export type Part =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'image'; attachmentId: string; mime: string }
  | { type: 'file'; attachmentId: string; mime: string; filename: string }
  | { type: 'tool-call'; id: string; name: string; args: unknown }
  | { type: 'tool-result'; id: string; name: string; result: unknown; isError: boolean };

export type Role = 'system' | 'user' | 'assistant';
export type MessageStatus = 'streaming' | 'complete' | 'error' | 'cancelled';

export interface ProducedBy {
  profileId: string;
  profileName: string;
  connectionId: string;
  modelId: string;
}

export interface CanonMessage {
  id: string;
  chatId: string;
  parentId: string | null;
  role: Role;
  parts: Part[];
  status: MessageStatus;
  error: SerializedError | null;
  producedBy: ProducedBy | null;
  createdAt: number;
}

export interface SerializedError {
  kind: ErrorKind;
  message: string;
  retryable: boolean;
  detail?: unknown;
}

export type ErrorKind =
  | 'auth' | 'rate_limit' | 'context_overflow' | 'content_filter'
  | 'model_not_found' | 'capability' | 'transient' | 'cancelled' | 'unknown';
