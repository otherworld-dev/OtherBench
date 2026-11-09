/**
 * A value a live artifact's page may choose for one of its calls (spec
 * 2026-10-12-live-artifacts): one of a fixed list, or a whole number in a
 * range. Never free text.
 */
export type LiveParam =
  | { enum: (string | number | boolean)[]; default: string | number | boolean }
  | { type: 'integer'; minimum: number; maximum: number; default: number };

/**
 * One data call a live html artifact declares: a read-only MCP tool
 * (`mcp__<server>__<tool>`) with fixed arguments, where an argument that is
 * exactly `{ "$param": name }` takes that parameter's value.
 */
export interface LiveCall {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  params: Record<string, LiveParam>;
}

/** The data calls an html artifact version declares; see `parseLiveSpec`. */
export interface LiveSpec {
  calls: LiveCall[];
}

/** What an artifact is (Deck #896): a web page, a Markdown document, a Mermaid or SVG diagram, a code file, or (Deck #928) a Word document, Excel spreadsheet or PowerPoint deck made from Markdown or JSON. */
export type ArtifactKind = 'html' | 'markdown' | 'mermaid' | 'svg' | 'code' | 'document' | 'spreadsheet' | 'presentation';

/** Standalone content the model made in a chat (spec 2026-10-07-artifacts); its content lives in its versions. */
export interface Artifact {
  id: string;
  chatId: string;
  /** The short id the model and the UI use; unique within the chat. */
  slug: string;
  kind: ArtifactKind;
  /** For `code`: its language, e.g. `ts`, `py`. */
  language: string | null;
  createdAt: number;
}

/** One version of an artifact; never changed once written. */
export interface ArtifactVersion {
  id: string;
  artifactId: string;
  /** 1, 2, … in the order made, across every branch. */
  number: number;
  title: string;
  content: string;
  /** This version's kind: a rewrite may change it (a note made into a page), so the artifact's own kind is only the one it was created as. */
  kind: ArtifactKind;
  /** A code version's language (ts, py), else null. */
  language: string | null;
  /**
   * The data calls this version's page may make each time it's opened (spec
   * 2026-10-12-live-artifacts), or null for a plain version. Only html
   * versions have one.
   */
  live: LiveSpec | null;
  madeBy: 'model' | 'user';
  /** The reply that made it (your edit: the newest message on the branch you were on). Not a foreign key: it may arrive by sync before its message. */
  messageId: string | null;
  parentVersionId: string | null;
  createdAt: number;
}

/** A version without its content: what lists and the branch's current version need. */
export type ArtifactVersionInfo = Omit<ArtifactVersion, 'content'>;

/** A version to add: everything but its number, with kind and language defaulting to the artifact's and `live` to null. */
export type NewArtifactVersion = Omit<ArtifactVersion, 'number' | 'kind' | 'language' | 'live'> & { kind?: ArtifactKind; language?: string | null; live?: LiveSpec | null };

export interface ArtifactRepo {
  create(a: Artifact): Artifact;
  get(id: string): Artifact | null;
  bySlug(chatId: string, slug: string): Artifact | null;
  /** Oldest first. */
  listByChat(chatId: string): Artifact[];
  /** Adds a version numbered after the artifact's highest. */
  /** Numbers the version next; its kind and language are the artifact's unless given. */
  addVersion(v: NewArtifactVersion): ArtifactVersion;
  /** Every version without its content (up to 1 MB each), oldest number first: for lists and finding the current one. */
  versionInfos(artifactId: string): ArtifactVersionInfo[];
  getVersion(id: string): ArtifactVersion | null;
  /** Oldest (lowest number) first. */
  versions(artifactId: string): ArtifactVersion[];
}
