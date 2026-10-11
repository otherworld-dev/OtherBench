import { useEffect, useState, type JSX } from 'react';
import { ApiError, api, type ClaudeDesktopImportResult, type ClaudeDesktopListing, type ClaudeDesktopServerView } from '../../state/api.js';
import { useGruntStore } from '../../state/store.js';

/** What a server would run as, for the list: its command and arguments, or its URL. */
function summary(s: ClaudeDesktopServerView): string {
  if (s.transport === 'http') return s.url ?? '';
  return [s.command, ...s.args].filter(Boolean).join(' ');
}

/** `set` with `key` added, or removed if it was there. */
function flip(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** Why a server can't be ticked, or null when it can. */
function blocked(s: ClaudeDesktopServerView): string | null {
  if (s.exists) return 'Grunt already has it.';
  if (!s.supported) return s.reason ?? "Grunt can't use it.";
  return null;
}

/**
 * Settings > MCP servers > Import from Claude Desktop (spec
 * 2026-10-11-claude-code-clean-chat-and-mcp-design §3). Lists the servers
 * in Claude Desktop's config by name and command, with the names of their
 * env vars and headers (their values never leave the server), and imports
 * the ticked ones. They are turned on only for the profiles ticked under
 * "Turn on for", none by default: a profile's MCP list is what its chats may
 * call, so adding to it stays an explicit choice.
 */
export function ClaudeDesktopImport({ onImported, onClose }: { onImported: () => void; onClose: () => void }): JSX.Element {
  const [listing, setListing] = useState<ClaudeDesktopListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ClaudeDesktopImportResult | null>(null);
  const allProfiles = useGruntStore((s) => s.profiles);
  const upsertProfile = useGruntStore((s) => s.upsertProfile);
  const profiles = allProfiles.filter((p) => p.archivedAt === null);
  const [forProfiles, setForProfiles] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    api.mcpServers
      .claudeDesktop()
      .then((l) => {
        if (!cancelled) setListing(l);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Couldn't read Claude Desktop's config -- please try again.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function toggle(name: string): void {
    setChosen((prev) => flip(prev, name));
  }

  async function runImport(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const done = await api.mcpServers.importClaudeDesktop([...chosen], [...forProfiles]);
      for (const p of done.profiles) upsertProfile(p);
      setResult(done);
      setChosen(new Set());
      setForProfiles(new Set());
      onImported();
      // Show the imported ones as Grunt's now.
      setListing(await api.mcpServers.claudeDesktop().catch(() => listing));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't import the servers -- please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Import from Claude Desktop" className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="label-caps text-base">Import from Claude Desktop</h3>
        <button type="button" onClick={onClose} className="btn px-2 py-1">
          Close
        </button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-[var(--danger)]">
          {error}
        </p>
      )}
      {listing === null && !error && <p className="text-sm text-[var(--text-faint)]">Reading Claude Desktop&rsquo;s config…</p>}
      {listing && !listing.found && <p className="text-sm text-[var(--text-muted)]">{`Claude Desktop's config wasn't found at ${listing.path}.`}</p>}
      {listing?.found && (
        <>
          <p className="text-xs text-[var(--text-muted)]">
            From {listing.path}. Values of environment variables and headers go straight into Grunt&rsquo;s encrypted secret store.
          </p>
          {listing.servers.length === 0 ? (
            <p className="text-sm text-[var(--text-faint)]">Claude Desktop has no MCP servers set up.</p>
          ) : (
            <ul className="space-y-1.5">
              {listing.servers.map((s) => {
                const why = blocked(s);
                return (
                  <li key={s.name}>
                    <label className={`flex items-start gap-2 text-sm ${why ? 'text-[var(--text-muted)]' : ''}`}>
                      <input
                        type="checkbox"
                        className="mt-1"
                        aria-label={s.name}
                        checked={chosen.has(s.name)}
                        disabled={why !== null || busy}
                        onChange={() => toggle(s.name)}
                      />
                      <span className="min-w-0">
                        <span className="font-medium">{s.name}</span>
                        <span className="block truncate font-mono text-xs text-[var(--text-muted)]">{summary(s)}</span>
                        {s.envNames.length + s.headerNames.length > 0 && (
                          <span className="block text-xs text-[var(--text-faint)]">Secrets: {[...s.envNames, ...s.headerNames].join(', ')}</span>
                        )}
                        {why && <span className="block text-xs">{why}</span>}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          {profiles.length > 0 && (
            <fieldset className="space-y-1.5">
              <legend className="text-xs text-[var(--text-muted)]">Turn on for</legend>
              {profiles.map((p) => (
                <label key={p.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    aria-label={p.name}
                    checked={forProfiles.has(p.id)}
                    disabled={busy}
                    onChange={() => setForProfiles((prev) => flip(prev, p.id))}
                  />
                  {p.name}
                </label>
              ))}
            </fieldset>
          )}
          <button type="button" onClick={() => void runImport()} disabled={chosen.size === 0 || busy} className="btn btn-primary px-3 py-1.5">
            {busy ? 'Importing…' : 'Import'}
          </button>
        </>
      )}
      {result && (
        <p role="status" className="text-sm">
          {result.imported.length > 0 ? `Imported ${result.imported.join(', ')}.` : 'Nothing was imported.'}
          {result.profiles.length > 0 && ` Turned on for ${result.profiles.map((p) => p.name).join(', ')}.`}
          {result.skipped.map((s) => ` Skipped ${s.name}: ${s.reason}`).join('')}
          {result.imported.length > 0 && result.profiles.length === 0 && " Turn them on for a profile under its MCP servers, or in the Inspector, to use them in chats."}
        </p>
      )}
    </section>
  );
}
