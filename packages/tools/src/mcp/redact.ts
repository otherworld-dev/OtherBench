const MAX_MESSAGE_LENGTH = 300;
const MIN_SECRET_LENGTH = 4;

/** `key=value`, `key: value` and `"key":"value"` for the usual OAuth secrets. */
const SENSITIVE_PAIR =
  /\b(code|code_verifier|authorization_code|state|token|access_token|refresh_token|id_token|client_secret|client_assertion|assertion|password)(["']?\s*[=:]\s*["']?)([^\s&"',}]+)/gi;
/** `code` and `state` also name ordinary things ("exit code: 127"); a purely numeric value for them is no OAuth secret. */
const NUMERIC_OK = new Set(['code', 'state']);

/**
 * Whether a configured env or header value counts as a secret when an error
 * message is redacted: at least 8 characters and not letters only. So
 * `production`, `debug`, `true` or `1` stay readable, while an API key, token
 * or password-like value (digits, symbols, mixed) is removed wherever it appears.
 */
export function looksSecret(value: string): boolean {
  return value.length >= 8 && !/^[A-Za-z]+$/.test(value);
}

/** `Bearer abc` / `Basic abc` as it appears in an echoed Authorization header. */
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[\w.~+/=-]+/gi;
const URL_PATTERN = /https?:\/\/[^\s"'<>)]+/gi;

/** A secret as it may appear in text: as is, percent-encoded, form-encoded (`+` for space) and base64. */
function formsOf(secret: string): Set<string> {
  const forms = new Set<string>([secret, encodeURIComponent(secret), new URLSearchParams({ v: secret }).toString().slice(2)]);
  const buffer = Buffer.from(secret);
  forms.add(buffer.toString('base64'));
  forms.add(buffer.toString('base64url'));
  return forms;
}

/**
 * Makes text safe to leave this module (an HTTP error, `health()`, a log
 * line): `Bearer`/`Basic` credentials and `key=value` / `"key":"value"` pairs
 * for the usual OAuth secrets become `[redacted]`, every known secret
 * (also percent-, form- and base64-encoded) does too, URLs lose their
 * userinfo, query and fragment, whitespace collapses, and it is cut to 300
 * characters. SDK and fetch errors can embed request URLs, headers and
 * response bodies, which can carry a code, a verifier, a client secret or a
 * token.
 */
export function redactMessage(text: string, secrets: Iterable<string | null | undefined> = []): string {
  let out = text
    .replace(AUTH_SCHEME, '$1 [redacted]')
    .replace(SENSITIVE_PAIR, (match: string, key: string, sep: string, value: string) =>
      NUMERIC_OK.has(key.toLowerCase()) && /^\d+[^\w]*$/.test(value) ? match : `${key}${sep}[redacted]` // digits, then at most punctuation ("127;")
    );
  for (const secret of secrets) {
    if (!secret || secret.length < MIN_SECRET_LENGTH) continue;
    for (const form of formsOf(secret)) if (form.length >= MIN_SECRET_LENGTH) out = out.split(form).join('[redacted]');
  }
  out = out.replace(URL_PATTERN, (url) => (url.split(/[?#]/)[0] ?? '').replace(/^(https?:\/\/)[^/\s@]*@/i, '$1'));
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > MAX_MESSAGE_LENGTH ? `${out.slice(0, MAX_MESSAGE_LENGTH)}...` : out;
}
