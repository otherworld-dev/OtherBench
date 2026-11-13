import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { attachmentRowShapeOk } from '@otherbench/core/domain/tool-images.js';
import { sha256Of } from '@otherbench/store-sqlite/blob-store.js';
import type { Container } from '../container.js';
import { MAX_ATTACHMENT_BYTES, storeUpload } from '../routes/attachments.js';
import { PeerError } from './service.js';
import type { ForwardedEnv } from './forward.js';

/**
 * Files pasted, dropped or picked on this machine for a chat that runs on a paired machine
 * (docs/features/v2-machines-and-sync.md, "Running a chat on another machine").
 *
 * An upload is stored where the UI is, as an unsent attachment, and unsent attachments never sync: a file
 * travels by sync only once it is bound to a message. A chat that runs elsewhere has its message written over
 * there, so the file the message names has to be there first. Just before a turn or a held message is forwarded,
 * each unsent file of this chat that it names is handed to that machine under the same id
 * (`POST /api/chats/:id/attachments/incoming` on its peer listener). Once that machine sends it, the row comes
 * back by sync bound to the message, and this machine's copy becomes the sent one (same id, chat, hash and type).
 *
 * Only a file this machine's UI is sending goes, and only to the machine the chat runs on: nothing is offered to
 * a paired machine that asks, so an unsent file still never leaves on another machine's say-so.
 */

/** The body of a hand-over: one file, its bytes as base64. */
interface HandedFile {
  id: string;
  filename: string;
  mime: string;
  data: string;
}

/** base64 of `MAX_ATTACHMENT_BYTES`, with room for the other fields. */
const MAX_HANDOVER_BODY_BYTES = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 64 * 1024;
/** A 25MB file over a slow link takes longer than the default minute. */
const HANDOVER_TIMEOUT_MS = 5 * 60_000;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The attachment ids a turn's `parts` or a held message's `attachments` name, each once. */
export function namedAttachmentIds(body: unknown): string[] {
  if (!isRecord(body)) return [];
  const ids = new Set<string>();
  for (const part of Array.isArray(body['parts']) ? body['parts'] : []) {
    if (isRecord(part) && (part['type'] === 'image' || part['type'] === 'file') && typeof part['attachmentId'] === 'string') ids.add(part['attachmentId']);
  }
  for (const a of Array.isArray(body['attachments']) ? body['attachments'] : []) {
    if (isRecord(a) && typeof a['attachmentId'] === 'string') ids.add(a['attachmentId']);
  }
  return [...ids];
}

/** Why a hand-over didn't go through, as the answer to the call it came with. */
export interface HandoverFailure {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Hands `nodeId` each unsent file of `chatId` that `body` names, before the call is forwarded there. A file
 * already sent, of another chat, or not here at all is left alone: sync carries a sent one, and the other
 * machine refuses a bad reference itself. Null when every file is there; otherwise what to answer.
 */
export async function handOverAttachments(container: Container, nodeId: string, chatId: string, body: unknown): Promise<HandoverFailure | null> {
  const peers = container.peers!;
  const name = peers.peer(nodeId)?.name ?? 'That machine';
  for (const id of namedAttachmentIds(body)) {
    const row = container.store.attachments.get(id);
    if (!row || row.chatId !== chatId || row.messageId !== null) continue;
    let data: Buffer;
    try {
      data = await container.blobStore.get(row.sha256);
    } catch {
      return { status: 409, body: { error: `"${row.filename}" is missing on this machine. Remove it and attach it again.`, kind: 'attachment_missing' } };
    }
    const file: HandedFile = { id: row.id, filename: row.filename, mime: row.mime, data: data.toString('base64') };
    let res;
    try {
      res = await peers.call(nodeId, { method: 'POST', path: `/api/chats/${encodeURIComponent(chatId)}/attachments/incoming`, body: file }, { timeoutMs: HANDOVER_TIMEOUT_MS });
    } catch (err) {
      if (err instanceof PeerError && err.status === 503) return { status: 503, body: { error: err.message, kind: 'peer_unreachable', nodeId } };
      throw err;
    }
    if (res.status === 200 || res.status === 201) continue;
    const said = isRecord(res.body) ? res.body : null;
    // A machine on a build without the route answers a bare 404.
    if (res.status === 404 && said === null) return { status: 501, body: { error: `${name} needs a newer OtherBench to take files sent from here.`, kind: 'peer_outdated', nodeId } };
    const status = res.status >= 400 && res.status < 600 ? res.status : 502;
    return { status, body: said ?? { error: `${name} didn't take "${row.filename}".` } };
  }
  return null;
}

/**
 * The receiving end, on the peer listener (mounted in `forwardedApi`, behind its token, desktop-only gate, chat
 * marking and "this chat runs here" check). The file is stored as an unsent attachment of the chat, under the id
 * the sending machine gave it, the way an upload here is (same cap, same text extraction). Sent again, the same
 * file in the same chat is a 200 and nothing changes; any other row under that id is a 409.
 */
export function attachmentHandoverRoutes(container: Container): Hono<ForwardedEnv> {
  const app = new Hono<ForwardedEnv>();
  app.post(
    '/chats/:id/attachments/incoming',
    bodyLimit({ maxSize: MAX_HANDOVER_BODY_BYTES, onError: (c) => c.json({ error: 'That file is over the 25MB limit.' }, 413) }),
    async (c: Context<ForwardedEnv>) => {
      const chatId = c.req.param('id')!;
      if (!container.store.chats.get(chatId)) return c.json({ error: 'Chat not found.' }, 404);
      const body = (await c.req.json().catch(() => null)) as unknown;
      const file = isRecord(body) ? body : {};
      const encoded = file['data'];
      if (typeof encoded !== 'string' || encoded.length % 4 !== 0 || !BASE64.test(encoded)) return c.json({ error: '"data" must be the file as base64.' }, 400);
      const data = Buffer.from(encoded, 'base64');
      const { id, filename, mime } = file;
      if (!attachmentRowShapeOk({ id, filename, mime, size: data.length }, MAX_ATTACHMENT_BYTES)) {
        return c.json({ error: data.length > MAX_ATTACHMENT_BYTES ? 'That file is over the 25MB limit.' : 'That file has an id, name or type OtherBench would not make.' }, 400);
      }
      const [fileId, name, type] = [id as string, filename as string, mime as string];
      const existing = container.store.attachments.get(fileId);
      if (existing) {
        if (existing.chatId === chatId && existing.sha256 === sha256Of(data)) return c.json({ id: fileId }, 200);
        return c.json({ error: 'A different file already has that id here.' }, 409);
      }
      await storeUpload(container, data, name, type, (blob, extractedText) =>
        container.store.attachments.create({ id: fileId, chatId, messageId: null, filename: name, mime: type, size: blob.size, sha256: blob.sha256, storagePath: blob.path, extractedText })
      );
      console.info(`[otherbench-server] chat ${chatId} got the file ${fileId} from paired machine ${c.env.peerNodeId}.`);
      return c.json({ id: fileId }, 201);
    }
  );
  return app;
}
