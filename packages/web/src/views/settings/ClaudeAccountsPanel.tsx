import { useCallback, useEffect, useState, type JSX } from 'react';
import type { AccountView } from '@otherbench/core/types/claude-accounts.js';
import { toast } from '../../lib/toasts.js';
import { ApiError, api } from '../../state/api.js';
import { useClaudeAccounts } from '../../state/claudeAccounts.js';

/** How often the list is read again while an account is signing in. */
export const SIGN_IN_POLL_MS = 2000;

/** The swatches a new account's colour starts from, in turn. */
const NEW_COLOURS = ['#e8590c', '#2f9e44', '#7048e8', '#d6336c', '#1c7ed6', '#f08c00'];

function messageOf(e: unknown): string {
  return e instanceof ApiError || e instanceof Error ? e.message : String(e);
}

/**
 * Settings → Claude accounts: the logins a Claude Code chat can run on. Main is
 * the login Claude Code already uses; each other account has its own folder.
 * Sign-in is the CLI's: it either finishes through its localhost callback or
 * waits for the code the sign-in page shows.
 */
export function ClaudeAccountsPanel(): JSX.Element {
  const accounts = useClaudeAccounts((s) => s.accounts);
  const load = useClaudeAccounts((s) => s.load);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The sign-in page each account's running sign-in answered with (null: it gave none).
  const [urls, setUrls] = useState<Record<string, string | null>>({});

  const reload = useCallback(async (): Promise<void> => {
    try {
      await load();
      setLoadError(null);
    } catch (e) {
      setLoadError(messageOf(e));
    }
  }, [load]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const anySigningIn = accounts.some((a) => a.signingIn);
  useEffect(() => {
    if (!anySigningIn) return;
    const timer = setInterval(() => void reload(), SIGN_IN_POLL_MS);
    return () => clearInterval(timer);
  }, [anySigningIn, reload]);

  async function signIn(slug: string): Promise<void> {
    try {
      const { url } = await api.claude.accounts.signIn(slug);
      setUrls((u) => ({ ...u, [slug]: url }));
      await reload();
      const now = useClaudeAccounts.getState().accounts.find((a) => a.slug === slug);
      if (url === null && now && !now.signingIn) toast({ tone: 'error', text: "Couldn't start the Claude sign-in." });
    } catch (e) {
      toast({ tone: 'error', text: messageOf(e) });
    }
  }

  /** Runs a change, toasts its failure, and reloads the list either way. True when it worked. */
  async function act(run: () => Promise<unknown>): Promise<boolean> {
    let ok = true;
    try {
      await run();
    } catch (e) {
      ok = false;
      toast({ tone: 'error', text: messageOf(e) });
    }
    await reload();
    return ok;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <p className="text-sm text-[var(--text-muted)]">
        A Claude Code chat can run on any of these logins. When one hits its usage limit, OtherBench moves the chat to the next. Each account keeps its own folder of Claude Code settings and sign-in.
      </p>
      {loadError && (
        <p role="alert" className="text-sm text-[var(--danger)]">
          {loadError}
        </p>
      )}
      <ul className="space-y-3">
        {accounts.map((a) => (
          <AccountCard
            key={a.slug}
            account={a}
            url={urls[a.slug] ?? null}
            onSignIn={() => void signIn(a.slug)}
            onSignOut={() => {
              const warning = a.main ? '\n\nMain is the login Claude Code uses everywhere, so this also signs out Claude Code in your terminal.' : '';
              if (window.confirm(`Sign ${a.name} out of Claude?${warning}`)) void act(() => api.claude.accounts.signOut(a.slug));
            }}
            onRemove={() => {
              if (window.confirm(`Remove the account "${a.name}"? Its folder is left as it is.`)) void act(() => api.claude.accounts.remove(a.slug));
            }}
            onColour={(colour) => void act(() => api.claude.accounts.update(a.slug, { colour }))}
            onCode={(code) => act(() => api.claude.accounts.submitCode(a.slug, code))}
          />
        ))}
      </ul>
      <AddAccount count={accounts.length} onAdded={reload} />
    </div>
  );
}

interface CardProps {
  account: AccountView;
  url: string | null;
  onSignIn(): void;
  onSignOut(): void;
  onRemove(): void;
  onColour(colour: string): void;
  /** Resolves true when the code was taken, so the field is cleared only then. */
  onCode(code: string): Promise<boolean>;
}

function AccountCard({ account: a, url, onSignIn, onSignOut, onRemove, onColour, onCode }: CardProps): JSX.Element {
  const [code, setCode] = useState('');
  const limited = a.limitedUntil !== null && a.limitedUntil > Date.now();
  return (
    <li data-testid={`claude-account-${a.slug}`} className="space-y-2 rounded border border-[var(--border)] bg-[var(--bg-raised)] p-3">
      <div className="flex flex-wrap items-center gap-2">
        {a.colour ? (
          <input
            type="color"
            aria-label={`Colour for ${a.name}`}
            value={a.colour}
            onChange={(e) => onColour(e.target.value)}
            className="h-5 w-5 shrink-0 cursor-pointer rounded border border-[var(--border)] bg-transparent p-0"
          />
        ) : null}
        <span className="font-medium">{a.name}</span>
        {a.subscriptionType && <span className="text-xs text-[var(--text-muted)]">{a.subscriptionType}</span>}
        {limited && <span className="text-xs text-[var(--warn)]">At its limit</span>}
        <span className="ml-auto text-sm text-[var(--text-muted)]">{a.signedIn === true ? (a.email ?? 'Signed in') : a.signedIn === false ? 'Signed out' : 'Checking…'}</span>
      </div>
      <p className="break-all text-xs text-[var(--text-faint)]">{a.configDir ?? 'Default folder (Claude Code’s own)'}</p>

      {a.signingIn ? (
        <div className="space-y-2">
          <p className="text-sm">Waiting for sign-in…</p>
          {url && (
            <a href={url} target="_blank" rel="noreferrer" className="text-sm text-[var(--accent)] underline">
              Open the sign-in page
            </a>
          )}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const pasted = code.trim();
              // A failed submit keeps the code, to be sent again.
              if (pasted) void onCode(pasted).then((ok) => ok && setCode(''));
            }}
          >
            <input
              aria-label="Paste code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Paste code"
              className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg-sunken)] px-2 py-1 text-sm"
            />
            <button type="submit" className="btn px-2 py-1" disabled={!code.trim()}>
              Submit
            </button>
          </form>
        </div>
      ) : (
        <div className="flex gap-2">
          {a.signedIn === true ? (
            <button type="button" className="btn px-2 py-1" onClick={onSignOut}>
              Sign out
            </button>
          ) : (
            <button type="button" className="btn btn-primary px-2 py-1" onClick={onSignIn}>
              Sign in
            </button>
          )}
          {!a.main && (
            <button type="button" className="btn btn-danger px-2 py-1" onClick={onRemove}>
              Remove
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function AddAccount({ count, onAdded }: { count: number; onAdded(): Promise<void> }): JSX.Element {
  const [name, setName] = useState('');
  const [existing, setExisting] = useState(false);
  const [folder, setFolder] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const colour = NEW_COLOURS[(count - 1 + NEW_COLOURS.length) % NEW_COLOURS.length]!;
      await api.claude.accounts.add({ name: name.trim(), colour, ...(existing ? { configDir: folder.trim() } : {}) });
      setName('');
      setFolder('');
      setExisting(false);
      await onAdded();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="space-y-2 rounded border border-dashed border-[var(--border)] p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <div className="flex gap-2">
        <input
          aria-label="Account name"
          placeholder="Account name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--bg-sunken)] px-2 py-1 text-sm"
        />
        <button type="submit" className="btn btn-primary px-2 py-1" disabled={busy || !name.trim() || (existing && !folder.trim())}>
          Add account
        </button>
      </div>
      <label className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
        <input type="checkbox" checked={existing} onChange={(e) => setExisting(e.target.checked)} />
        Use an existing folder
      </label>
      {existing && (
        <input
          aria-label="Folder"
          placeholder="Absolute path to a Claude Code config folder"
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
          className="w-full rounded border border-[var(--border)] bg-[var(--bg-sunken)] px-2 py-1 text-sm"
        />
      )}
      {error && (
        <p role="alert" className="text-sm text-[var(--danger)]">
          {error}
        </p>
      )}
    </form>
  );
}
