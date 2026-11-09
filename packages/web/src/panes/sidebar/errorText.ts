import { ApiError } from '../../state/api.js';

/** A sidebar error line: the server's own message when there is one. */
export function errorText(err: unknown, action: string): string {
  return err instanceof ApiError ? `${action}: ${err.message}` : `${action} -- please try again.`;
}
