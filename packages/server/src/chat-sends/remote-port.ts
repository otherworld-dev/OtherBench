/**
 * What ChatSendService needs from paired machines to send work to chats that run there (spec
 * 2026-11-13-chat-sends-across-machines-design). `remote.ts` implements it over the peer listener; tests use a fake.
 * Nothing here decides anything: the service does, and the other machine decides what it takes.
 */

/**
 * Whether a paired machine can be handed a send now: `ok` it said it takes them, `off` it said it doesn't,
 * `unknown` it is reachable but never said (an older build: try, and its answer tells), `unreachable`.
 */
export type PeerSendState = 'ok' | 'unreachable' | 'off' | 'unknown';

/** One send as the sender's machine hands it over. The target's machine keeps it under the same id. */
export interface Handover {
  id: string;
  chainId: string;
  depth: number;
  /** The sends the chain already had on the sender's machine, not counting this one, for the chain limit there. */
  chainBase: number;
  fromChatId: string;
  fromMessageId: string;
  fromTitle: string;
  fromAppName: string | null;
  toChatId: string;
  text: string;
  /** Make the chat first: a new chat in this app, with this title, under `toChatId`. */
  createApp?: { appId: string; title: string };
}

/** `final: false` is a refusal that will pass (the machine is off or busy): the send waits and is tried again. */
export type HandoverAnswer = { accepted: true } | { refused: string; final: boolean };

/** How a send ended on the target's machine, as it reports it back. */
export interface Outcome {
  status: 'replied' | 'failed' | 'stopped' | 'dropped';
  replyText: string | null;
  reason: string | null;
}

export interface ChatSendRemote {
  /** This machine: its node id and name. */
  self(): { id: string; name: string };
  machineName(nodeId: string): string;
  state(nodeId: string): PeerSendState;
  /** The chats with a reply running on `nodeId`, as it last said; none while it isn't reachable. */
  activeChats(nodeId: string): string[];
  handOver(nodeId: string, h: Handover): Promise<HandoverAnswer>;
  /** `taken` also when the other machine doesn't know the send: there is nothing more to tell it. */
  report(nodeId: string, sendId: string, toChatId: string, o: Outcome): Promise<'taken' | 'retry'>;
  stop(nodeId: string, sendId: string, toChatId: string, reason: string): Promise<'taken' | 'retry'>;
}

/** What the sender is told while the machine is off. */
export const unreachableReason = (machine: string): string => `${machine} isn't reachable. The message goes when it is back.`;
/** What the sender is told while computer use may be in control there (forward.ts's desktop-only gate). */
export const busyReason = (machine: string): string => `${machine} is being used by computer use. The message goes when that ends.`;
/** A machine on a build from before this feature. */
export const outdatedReason = (machine: string): string => `${machine} needs updating before chats can send work to it.`;
/** A machine that doesn't take sends from paired machines (`peerChatSends` off there). */
export const sendsOffReason = (machine: string): string =>
  `${machine} doesn't accept work from chats on paired machines. Turn on "Let chats on paired machines send work to chats here" in Settings → Machines on ${machine}.`;
/** Why Run here isn't offered. */
export const notHereReason = (name: string, machine: string): string => `${name}'s folder is only on ${machine}.`;
export const CANCELLED_BY_USER = 'Cancelled by the user.';
