/** A pairing attempt or a call to a peer that failed in a way the user should read. */
export class PeerError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 410 | 502 | 503 = 400
  ) {
    super(message);
    this.name = 'PeerError';
  }
}
