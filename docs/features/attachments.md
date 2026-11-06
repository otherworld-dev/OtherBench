# Attachments

`GET/POST /chats/:id/attachments`, `GET /attachments/:id`, `GET
/attachments/:id/content` — and now `DELETE /attachments/:id`
(`packages/server/src/routes/attachments.ts`).

- **Deleting an unsent attachment** (`messageId === null`) removes its row
  and, if no other row references the same content hash, its blob. **A sent
  attachment can't be deleted** — `attachment.messageId` is bound the moment
  a turn is sent (`packages/core/src/domain/turn.ts`), and the route returns
  409: it's part of that message's history, and deleting it would make the
  transcript misrepresent what was actually sent to the model.
- **Blob storage is per database now.** `resolveAttachmentsRoots`
  (`packages/store-sqlite/src/blob-store.ts`) derives `<db file
  path>.attachments/` from the database's own full filename — e.g.
  `otherbench.db.attachments/`. Before this fix, every database's blobs lived in
  one directory derived from `secrets.json`'s own location, so two databases
  in the same directory (or two `:memory:` runs, which both resolved to the
  default `~/.otherbench`) shared one attachments folder and each one's cleanup
  sweep deleted the other's blobs. The old shared `<dir>/attachments/`
  directory is now **read-only**: `BlobStore.get()` still falls back to it so
  attachments uploaded before this change stay servable, but nothing ever
  writes to or sweeps it again — **do not delete it**, or those older
  attachments 404. `createContainer` (`packages/server/src/container.ts`)
  logs a warning on startup if it still exists.
- **Blobs are garbage-collected** when no attachment row references their
  content hash any more: after a delete, after chat/profile/connection
  cascade deletes, and in a startup sweep (`packages/store-sqlite/src/blob-gc.ts`).
  A filesystem-level GC failure (locked file, permissions) is logged and
  swallowed — it never fails the request or the boot — but a programming
  error is not swallowed and surfaces as a 500.
- **Abandoned unsent attachments are collected after 30 days.** An unsent
  attachment whose row hasn't changed for `ABANDONED_ATTACHMENT_GRACE_MS`
  (30 days) is deleted with its blob by `sweepAbandonedAttachments`
  (`blob-gc.ts`): the row first, then `gcBlobIfOrphaned`, exactly as
  `DELETE /attachments/:id` does it, so a blob another row shares or an
  upload has pinned stays. It runs at startup (before the orphan sweep) and
  every 24 hours while the server runs (`server/src/attachment-sweep.ts`, an
  unref'd timer stopped by `close()`); one on a note waiting to be sent is
  skipped. Age is read from the row's own sync stamp (`hlc`, its last
  write), so there's no migration, and only rows last written by this
  machine are swept. Unsent attachments never sync, so a paired machine
  can't be about to send one. The period is long because the composer has
  no draft store: its text is lost on a reload, but it shows every unsent
  attachment on the server as a chip when a chat opens, so the row is the
  draft's attachment and age is the only way to tell an abandoned one. A
  chip left untouched for 30 days goes; sending it after that fails as an
  unknown attachment.
- **`storagePath` no longer appears in any `Attachment` API response.**
  `toPublicAttachment()` strips it before every `c.json()` call in that
  route; it's still used internally (loading the blob to serve `/content`),
  just never sent to the client.
- **The 25MB upload cap holds while the body is read.** `limitUploadBody`
  in `routes/attachments.ts` caps the whole multipart body at
  `MAX_UPLOAD_BODY_BYTES` (25MB plus 1MB for the multipart framing). A
  Content-Length over that is refused before any of the body is read.
  Otherwise the body reaches the multipart parser through a stream that
  counts the bytes as they're pulled, whatever the Content-Length says or
  when there is none (a chunked upload), and refuses once the count passes
  the cap: at most one chunk past it is read. Both answer 413 with the usual
  `{ error }`. The rest of the body is left unread; `@hono/node-server`
  drains it for up to half a second (or 64 MB) after the answer and then
  closes the connection. Hono's own `bodyLimit` was used here before; it
  trusts a Content-Length without counting and reads a chunked body into
  memory before the handler starts. The per-file checks after parsing (the
  `File`'s `.size`, then the bytes read) are unchanged and give the exact
  byte count.
- **Office files and files as text (Deck #928).** Uploads of .docx/.docm,
  .xlsx/.xlsm and .pptx/.pptm (by MIME type or extension; the main part in
  the ZIP decides what it really is) are read into `extracted_text` by
  OtherBench's own extractor (`server/src/office/`: the claude.ai import's ZIP
  reader plus a small XML scanner, no new dependencies). Word gives headings,
  lists and tables as Markdown; Excel gives each sheet as CSV plus its
  formulas with cached values; PowerPoint gives each slide's text, tables
  and notes. A part over 32 MB is skipped with a note, reading stops at
  64 MB of parts or 100,000 characters, and a DOCTYPE is refused. A part is
  read once however often (and in whatever case) it's named, and every read
  is charged to the 64 MB; the skip notes are deduplicated and capped. The
  scanner and the three readers are linear in the size of a hostile part and
  stop appending at the character cap (a paragraph, cell or table is never
  held past it); the hostile cases are tests with time bounds. A
  hostile file can still hold the upload request for about 10-15 seconds
  (the scanner runs at about 4-6 MB/s and the parts total can reach 64 MB). `.txt .tsv .json .log` and
  `application/json` are plain text now too. Every attached file that isn't
  a PDF reaches the model as that text, fenced as `<attached-file
  name="…">`, for every engine (`filesForModel` in `core/src/domain/turn-attachments.ts`); API models
  still get PDFs as PDFs, Claude Code gets their text. A file with no text
  becomes a placeholder and a notice on the reply. Attachments uploaded
  before this change have no text and get the placeholder: attach them
  again. Until then such an attachment re-triggers the "couldn't read"
  notice on every later turn of its chat, since `filesForModel` runs over the
  whole history. Not read: headers, footers, footnotes, comments, charts, masters.

The review for this merge found two Criticals in the first cut (the
sent-attachment delete guard was never actually armed in production; the
startup sweep deleted other databases' blobs) and the re-review found two
more data-loss paths in the fix itself (same-stem databases still colliding
— e.g. `main.db` and `main.bak` before the fix derived the write root from
the full basename, extension included; a snapshot-vs-unlink race letting the
sweep delete a blob a concurrent upload had just written). All four closed
and verified with the reviewer's own reproduction probes — see
`packages/store-sqlite/test/blob-gc.test.ts` and
`packages/server/test/attachment-roots.test.ts`, which encode those probes
as regression tests.
