/**
 * Every reason `otherbench serve` refuses to start with sign-in (spec
 * 2026-10-12-remote-access §1). `main()` prints any `RemoteStartError` as
 * `Error: <message>` and exits 1, like the other start-up refusals.
 */
export class RemoteStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InsecurePublicUrlError extends RemoteStartError {
  constructor(url: string) {
    super(`Refusing to start: --public-url "${url}" must be https://<host>[:<port>] with no path, query or user name. Sign-in only works over HTTPS.`);
  }
}

export class RemoteNeedsHttpsError extends RemoteStartError {
  constructor() {
    super('Refusing to start: sign-in (--public-url) needs HTTPS. Add --tls auto, or --tls-cert <file> --tls-key <file>, or put an HTTPS proxy in front and pass --trust-proxy <its address>.');
  }
}

export class RemoteWithAnnounceError extends RemoteStartError {
  constructor() {
    super("Refusing to start: --public-url can't be used with --announce (the desktop app's mode).");
  }
}

export class TlsWithoutPublicUrlError extends RemoteStartError {
  constructor() {
    super('Refusing to start: --tls, --tls-cert, --tls-key and --trust-proxy only apply with --public-url.');
  }
}

export class TlsConflictError extends RemoteStartError {}

export class InvalidTrustProxyError extends RemoteStartError {
  constructor(address: string) {
    super(`Refusing to start: --trust-proxy "${address}" must be an IP address (no names or ranges).`);
  }
}

export class NoPasswordError extends RemoteStartError {
  constructor(loginPath: string) {
    super(`Refusing to start: no sign-in password is set (looked for ${loginPath}). Run "otherbench password" on this machine first.`);
  }
}

export class LoginFileError extends RemoteStartError {
  constructor(path: string, reason: string) {
    super(`${path} is not a usable password file (${reason}). Run "otherbench password" again.`);
  }
}

export class TlsFilesError extends RemoteStartError {}
