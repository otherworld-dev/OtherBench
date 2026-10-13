import { useState, type JSX } from 'react';
import type { LiveParam } from '@grunt/core/ports/store.js';
import type { LiveOutcome, LiveStatus } from '../state/api.js';

const BUTTON = 'btn px-2 py-0.5';
const ARGS_SHOWN = 300;

/** A param as the panel lists it: `list: Work, Home (default Work)` or `days: 1–30 (default 7)`. */
export function describeParam(name: string, p: LiveParam): string {
  if ('enum' in p) return `${name}: ${p.enum.map(String).join(', ')} (default ${String(p.default)})`;
  return `${name}: ${p.minimum}–${p.maximum} (default ${p.default})`;
}

function CallRow({ call }: { call: LiveStatus['calls'][number] }): JSX.Element {
  const [all, setAll] = useState(false);
  const args = JSON.stringify(call.args);
  const long = args.length > ARGS_SHOWN;
  return (
    <li className="space-y-0.5">
      <div>
        <span className="font-medium">{call.serverName} · {call.toolName}</span>
        {call.state === 'allowed' && <span className="ml-2 text-[var(--text-muted)]">Allowed</span>}
      </div>
      <div className="font-mono break-all">
        {long && !all ? `${args.slice(0, ARGS_SHOWN)}…` : args}
        {long && !all && (
          <button type="button" onClick={() => setAll(true)} className="ml-2 underline">Show all</button>
        )}
      </div>
      {Object.entries(call.params).map(([name, p]) => (
        <div key={name}>{describeParam(name, p)}</div>
      ))}
      {call.description && <p className="text-[var(--text-muted)]">{call.description}</p>}
      {call.state === 'unavailable' && call.reason && <p className="text-[var(--warn)]">{call.reason}</p>}
    </li>
  );
}

type LiveBarProps = {
  status: LiveStatus | null;
  error: string | null;
  hidden: boolean;
  latest: { at: number; cached: boolean } | null;
  outcomes: ReadonlyMap<string, LiveOutcome>;
  onAllow(): void;
  onNotNow(): void;
  onRefresh(): void;
  onStop(): void;
};

/**
 * Above a live page in the viewer (spec 2026-10-12-live-artifacts): the
 * approval panel while any eligible call needs an OK (or the reasons, when
 * none is eligible), else a one-line strip with when data last came, Refresh,
 * Stop and a line for each call that failed. An error goes above either, so
 * their buttons still work. Everything shown is plain text.
 */
export function LiveBar(props: LiveBarProps): JSX.Element | null {
  const controls = <LiveControls {...props} />;
  if (!props.error) return controls;
  return (
    <>
      <p role="alert" className="border-b border-[var(--border)] px-3 py-1 text-xs text-[var(--danger)]">Live data: {props.error}</p>
      {controls}
    </>
  );
}

function LiveControls(props: LiveBarProps): JSX.Element | null {
  const status = props.status;
  if (!status) return null;
  const needsOk = status.calls.some((c) => c.state === 'needs_ok');
  const anyAllowed = status.calls.some((c) => c.state === 'allowed');

  if (needsOk || !anyAllowed) {
    if (props.hidden) return null;
    return (
      <section role="region" aria-label="Live data" className="space-y-2 border-b border-[var(--border)] px-3 py-2 text-xs">
        <h3 className="font-medium">Live data</h3>
        <p>
          {`Each time it's opened, this page asks for data from these tools. They run on this machine (${status.machine.name}) with the chat's profile (${status.profile.name}).`}
          {status.runsOn ? ` This chat runs on ${status.runsOn.name}; live data still comes from this machine.` : ''}
        </p>
        <ul className="space-y-2">
          {status.calls.map((c) => (
            <CallRow key={c.callId} call={c} />
          ))}
        </ul>
        <p className="text-[var(--text-muted)]">
          {"The page can't use the internet through ordinary requests, but its code could still send what it shows elsewhere by leaving the page. Allow only data you're content for it to have."}
        </p>
        <div className="flex gap-2">
          {needsOk && <button type="button" onClick={props.onAllow} className={BUTTON}>Allow live data</button>}
          <button type="button" onClick={props.onNotNow} className={BUTTON}>Not now</button>
        </div>
      </section>
    );
  }

  const failed = status.calls.flatMap((c) => {
    if (c.state === 'unavailable') return [`${c.callId}: ${c.reason ?? "it isn't available."}`];
    const o = props.outcomes.get(c.callId);
    return o && !o.ok ? [`${c.callId}: ${o.message}`] : [];
  });
  return (
    <section role="region" aria-label="Live data" className="border-b border-[var(--border)] px-3 py-1 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1">
          Live data{props.latest ? ` · updated ${new Date(props.latest.at).toLocaleTimeString()}${props.latest.cached ? ' (cached)' : ''}` : ''}
        </span>
        <button type="button" onClick={props.onRefresh} className={BUTTON}>Refresh</button>
        <button type="button" onClick={props.onStop} className={BUTTON}>Stop live data</button>
      </div>
      {failed.map((line) => (
        <p key={line} className="text-[var(--danger)]">{line}</p>
      ))}
    </section>
  );
}
