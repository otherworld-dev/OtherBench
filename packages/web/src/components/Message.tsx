import { useState, type JSX, type ReactNode } from 'react';
import type { ApprovalChoice, ApprovalRequest, AskReply, UserAsk } from '@otherbench/core/ports/tool-provider.js';
import { isAskTool, isPlanTool, isTodoTool, latestTodos, parsePlan, parseQuestions } from '@otherbench/core/domain/thread-tools.js';
import type { CanonMessage, Part, SubagentStatus } from '@otherbench/core/types/messages.js';
import type { MediaProgress } from '@otherbench/core/ports/media.js';
import { contextLineOf } from '@otherbench/core/domain/context-lines.js';
import { editDiffOf } from '../lib/editDiff.js';
import { formatStamp } from '../lib/relativeTime.js';
import { isSandboxResult } from '../lib/sandbox.js';
import { api } from '../state/api.js';
import { actionSummary, COMPUTER_SCREEN_ABOUT, typedTextForCard } from '@otherbench/core/domain/computer-apps.js';
import { isToolImageRef, type ToolImageRef } from '@otherbench/core/domain/tool-images.js';
import { ApprovalPrompt } from './ApprovalPrompt.js';
import { AttachmentChip } from './AttachmentChip.js';
import { ContextLine } from './ContextLine.js';
import { AuthedImage } from './AuthedImage.js';
import { EditDiff } from './EditDiff.js';
import { GeneratedMedia, GenerationProgress, hasGeneratedMedia, isGenerationTool } from './GeneratedMedia.js';
import { GenerationCard } from './GenerationCard.js';
import { MarkdownBody } from './MarkdownBody.js';
import { PlanCard } from './PlanCard.js';
import { QuestionCard } from './QuestionCard.js';
import { SubagentCard, subagentDisplayStatus } from './SubagentCard.js';
import { TodoChecklist } from './TodoChecklist.js';
import { UserNoteBlock } from './UserNoteBlock.js';
import { artifactOutcomeOf, isArtifactTool, toolPath } from '../viewer/paths.js';
import { browserCallLabel, browserPageOf, displayLines, oneLine } from '../viewer/browser.js';
import { useViewer } from '../viewer/ViewerContext.js';

function NoticeBlock({ text }: { text: string }): JSX.Element {
  return (
    <div
      role="note"
      className="my-1 flex items-start gap-1.5 rounded border border-[var(--border)] bg-[var(--bg-sunken)] px-2 py-1 text-xs text-[var(--text-muted)]"
    >
      <span aria-hidden="true">ℹ️</span>
      <span>{text}</span>
    </div>
  );
}

/**
 * A stand-in display name for an `image` Part, which -- unlike `file` --
 * carries no `filename` field (see `Part`'s doc in
 * packages/core/src/types/messages.ts): just an opaque `attachmentId` and a
 * MIME type. Mirrors the same id+extension convention `convert.ts`'s
 * `imagePlaceholder` uses for the model-facing placeholder, so the chip
 * shown here and the text a vision-less model actually saw agree with each
 * other. A real upload's OWN chip (rendered live in the Composer, before
 * sending) shows the true filename instead -- this fallback is only reached
 * once a message has round-tripped through the store, which persists no
 * filename for an `image` part.
 */
function imageDisplayName(attachmentId: string, mime: string): string {
  const subtype = mime.split('/')[1] ?? '';
  const ext = (subtype.split('+')[0] ?? '').replace(/[^a-zA-Z0-9]/g, '') || 'bin';
  return `${attachmentId}.${ext}`;
}

function AttachmentPartChip({ part }: { part: Extract<Part, { type: 'image' | 'file' }> }): JSX.Element {
  const filename = part.type === 'file' ? part.filename : imageDisplayName(part.attachmentId, part.mime);
  const previewUrl = api.attachments.previewable(part.mime) ? api.attachments.contentUrl(part.attachmentId) : undefined;
  return <AttachmentChip filename={filename} mime={part.mime} previewUrl={previewUrl} />;
}

/** A compact's summary: closed by default, the counts on its line when both are known. */
function ContextSummaryBlock({ part }: { part: Extract<Part, { type: 'context-summary' }> }): JSX.Element {
  const counts =
    part.preTokens !== undefined && part.postTokens !== undefined
      ? ` · ${part.preTokens.toLocaleString()} → ${part.postTokens.toLocaleString()} tokens`
      : '';
  return (
    <details className="my-1 rounded border border-[var(--border)] bg-[var(--bg-sunken)] px-2 py-1 text-xs">
      <summary className="cursor-pointer font-medium text-[var(--text-muted)] select-none">{`Context compacted${counts}`}</summary>
      <div className="mt-1 text-sm">
        <MarkdownBody text={part.text} deckLinks />
      </div>
    </details>
  );
}

function ReasoningBlock({ text }: { text: string }): JSX.Element {
  return (
    <details className="my-1 rounded border border-[var(--border)] bg-[var(--bg-sunken)] px-2 py-1 text-xs">
      <summary className="cursor-pointer font-medium text-[var(--text-muted)] select-none">Reasoning</summary>
      <p className="mt-1 whitespace-pre-wrap text-[var(--text-muted)]">{text}</p>
    </details>
  );
}

/** The computer tool, by its own name or by the name Claude Code gives the relayed one (`mcp__otherbench_<hex>__computer`). */
const COMPUTER_TOOL_NAME = /^(?:mcp__otherbench_[0-9a-f]+__)?computer$/;

function isComputerTool(name: string): boolean {
  return COMPUTER_TOOL_NAME.test(name);
}

/** The reply a tool result belongs to: a tool's images are served only for that chat and that message. */
interface ToolImageScope {
  chatId: string;
  messageId: string;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A line about a tool's image or item, in the muted note style. */
function ToolItemNote({ text }: { text: string }): JSX.Element {
  return (
    <p role="note" className="text-[var(--text-muted)] italic">
      {text}
    </p>
  );
}

/**
 * An image a tool returned, loaded only through the chat and reply that hold
 * it (`toolImageUrl`). If it can't be loaded (a 404: the row is gone or
 * belongs elsewhere), it says so once and is never asked for again.
 */
function ToolImage({ item, scope, alt, noun }: { item: ToolImageRef; scope: ToolImageScope; alt: string; noun: string }): JSX.Element {
  const [missing, setMissing] = useState(false);
  if (missing) return <ToolItemNote text={`${noun} not available.`} />;
  return (
    <AuthedImage
      src={api.attachments.toolImageUrl(scope.chatId, scope.messageId, item.attachmentId)}
      alt={alt}
      onError={() => setMissing(true)}
      onFailed={() => setMissing(true)}
      className="max-h-48 max-w-full rounded border border-[var(--border)]"
    />
  );
}

/**
 * How the thread shows a computer call: what it does (`actionSummary`, which
 * never holds typed text), and nothing else. No app: the stored call holds the
 * model's own arguments, not the described target, so any app in them is only
 * what the model claimed (the approval card names the real one). Never the raw
 * arguments either: they can carry a window title and the text to type. Typed
 * text stays behind a toggle.
 */
function ComputerCallBlock({ args }: { args: unknown }): JSX.Element {
  const [showTyped, setShowTyped] = useState(false);
  const typed = typedTextForCard(args);
  return (
    <div data-testid="computer-call" className="my-1 rounded border border-[var(--border)] bg-[var(--bg-sunken)] px-2 py-1 text-xs">
      <span className="font-medium">
        {'\u{1F527}'} computer: <bdi>{oneLine(actionSummary(args))}</bdi>
      </span>
      {typed !== null && (
        <>
          <button type="button" aria-expanded={showTyped} onClick={() => setShowTyped((v) => !v)} className="ml-2 underline decoration-dotted">
            {showTyped ? 'Hide typed text' : 'Show typed text'}
          </button>
          {showTyped && (
            <pre data-testid="computer-call-typed-text" className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all">
              <bdi>{typed}</bdi>
            </pre>
          )}
        </>
      )}
    </div>
  );
}

/** The fixed line a computer result starts with, as a small label rather than body text. */
function ScreenAboutLabel(): JSX.Element {
  return (
    <p data-testid="computer-screen-about" className="text-[10px] text-[var(--text-muted)]">
      {COMPUTER_SCREEN_ABOUT}
    </p>
  );
}

/** Words in a computer result: untrusted, one plain line, never markdown or HTML. */
function ComputerText({ text }: { text: unknown }): JSX.Element {
  return (
    <p className="break-words">
      <bdi>{oneLine(text)}</bdi>
    </p>
  );
}

/** One top-level item of a computer result. */
function ComputerResultItem({ item, scope }: { item: unknown; scope: ToolImageScope }): JSX.Element {
  const record = recordOf(item);
  if (record?.['type'] === 'text') {
    return record['text'] === COMPUTER_SCREEN_ABOUT ? <ScreenAboutLabel /> : <ComputerText text={record['text']} />;
  }
  if (isToolImageRef(item)) {
    if (item.pending === true) return <ToolItemNote text="Screenshot not available yet." />;
    return <ToolImage item={item} scope={scope} alt="Screenshot" noun="Screenshot" />;
  }
  return <ToolItemNote text="(Part of this result can't be shown here.)" />;
}

/**
 * A computer result: the screen-content line as a label, the words as plain
 * text, a screenshot through the chat's tool-image route. Only the top-level
 * items of an array are looked at; an error is its message.
 */
function ComputerResultBlock({ result, isError, scope }: { result: unknown; isError: boolean; scope: ToolImageScope }): JSX.Element {
  const record = recordOf(result);
  let body: JSX.Element | JSX.Element[];
  if (Array.isArray(result)) {
    body = result.map((item, i) => <ComputerResultItem key={i} item={item} scope={scope} />);
  } else if (typeof result === 'string') {
    // Claude Code's results are kept as their text, one item per line (engine-claude-code/src/events.ts): the
    // screen-content line is the label, and each line after it is plain text. A result stored before that had
    // its items run together, so the line is taken off the front whatever follows it.
    const labelled = result.startsWith(COMPUTER_SCREEN_ABOUT);
    const lines = (labelled ? result.slice(COMPUTER_SCREEN_ABOUT.length) : result).split('\n').filter((l) => l.trim().length > 0);
    body = (
      <>
        {labelled && <ScreenAboutLabel />}
        {lines.map((l, i) => (
          <ComputerText key={i} text={l} />
        ))}
      </>
    );
  } else if (record !== null && typeof record['message'] === 'string') {
    body = (
      <>
        {record['about'] === COMPUTER_SCREEN_ABOUT && <ScreenAboutLabel />}
        <ComputerText text={record['message']} />
      </>
    );
  } else {
    body = <ToolItemNote text="(This result can't be shown here.)" />;
  }
  return (
    <div className={`my-1 rounded border px-2 py-1 text-xs ${isError ? 'border-[var(--danger)]' : 'border-[var(--border)]'} bg-[var(--bg-sunken)]`}>
      <span className="font-medium">{isError ? '\u26a0\ufe0f' : '\u21b3'} computer result</span>
      <div className="mt-1 space-y-1">{body}</div>
    </div>
  );
}

function ToolCallBlock({ name, args }: { name: string; args: unknown }): JSX.Element {
  const viewer = useViewer();
  const path = viewer ? toolPath(name, args) : null;
  // After the hook above, so the hooks run in the same order for every tool.
  if (isComputerTool(name)) return <ComputerCallBlock args={args} />;
  if (name === 'browser') {
    return (
      <div className="my-1 rounded border border-[var(--border)] bg-[var(--bg-sunken)] px-2 py-1 text-xs">
        <span className="font-medium">🔧 browser: {browserCallLabel(args)}</span>
      </div>
    );
  }
  return (
    <div className="my-1 rounded border border-[var(--border)] bg-[var(--bg-sunken)] px-2 py-1 text-xs">
      <span className="font-medium">🔧 {name}</span>
      {path && viewer && (
        <button type="button" aria-label={`Open ${path}`} title="Open in the viewer" onClick={() => viewer.openPath(path)} className="ml-2 underline decoration-dotted">
          Open
        </button>
      )}
      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap">{JSON.stringify(args, null, 2)}</pre>
    </div>
  );
}

/** One top-level item of another tool's result that holds an image: as before (text as is, anything else as JSON), the image through the tool-image route. */
function ToolResultItem({ name, item, scope }: { name: string; item: unknown; scope: ToolImageScope }): JSX.Element {
  if (isToolImageRef(item)) {
    if (item.pending === true) return <ToolItemNote text="Image not available yet." />;
    return <ToolImage item={item} scope={scope} alt={`Image from ${name}`} noun="Image" />;
  }
  // An image that isn't a stored reference (nothing should reach here as one) is never dumped as data.
  if (recordOf(item)?.['type'] === 'image') return <ToolItemNote text="[image not shown]" />;
  const text = recordOf(item)?.['type'] === 'text' ? recordOf(item)?.['text'] : undefined;
  return <pre className="overflow-x-auto whitespace-pre-wrap">{typeof text === 'string' ? text : JSON.stringify(item, null, 2)}</pre>;
}

function ToolResultBlock({ name, result, isError, scope }: { name: string; result: unknown; isError: boolean; scope: ToolImageScope }): JSX.Element {
  if (isComputerTool(name)) return <ComputerResultBlock result={result} isError={isError} scope={scope} />;
  const page = name === 'browser' && !isError ? browserPageOf(result) : null;
  if (page) {
    // Page-derived text: plain, sanitised, and the snapshot folded away (what the model saw is unchanged).
    return (
      <div className="my-1 rounded border border-[var(--border)] bg-[var(--bg-sunken)] px-2 py-1 text-xs">
        <div className="font-medium">
          ↳ <bdi>{oneLine(page.title) || 'Untitled page'}</bdi>
        </div>
        <div className="truncate font-mono text-[var(--text-muted)]">
          <bdi>{oneLine(page.url)}</bdi>
        </div>
        <details className="mt-1">
          <summary className="cursor-pointer text-[var(--text-muted)] select-none">Page snapshot</summary>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap">{displayLines(page.snapshot)}</pre>
        </details>
      </div>
    );
  }
  // Only a result that holds an image (at its top level) changes shape; every other result renders as it always has.
  const items = Array.isArray(result) && result.some((item) => recordOf(item)?.['type'] === 'image') ? (result as unknown[]) : null;
  return (
    <div className={`my-1 rounded border px-2 py-1 text-xs ${isError ? 'border-[var(--danger)]' : 'border-[var(--border)]'} bg-[var(--bg-sunken)]`}>
      <span className="font-medium">{isError ? '⚠️' : '↳'} {name} result</span>
      {isSandboxResult(name, result) && (
        <span data-testid="sandbox-tag" title="Ran in OtherBench's sandbox" className="ml-2 rounded-sm border border-[var(--border)] px-1 text-[10px] tracking-wide text-[var(--text-muted)] uppercase">
          sandbox
        </span>
      )}
      {items ? (
        <div className="mt-1 space-y-1">
          {items.map((item, i) => (
            <ToolResultItem key={i} name={name} item={item} scope={scope} />
          ))}
        </div>
      ) : (
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap">{typeof result === 'string' ? result : JSON.stringify(result, null, 2)}</pre>
      )}
    </div>
  );
}

function renderPart(part: Part, key: number, scope: ToolImageScope): JSX.Element | null {
  switch (part.type) {
    case 'text':
      return <MarkdownBody key={key} text={part.text} deckLinks />;
    case 'reasoning':
      return <ReasoningBlock key={key} text={part.text} />;
    case 'tool-call':
      return <ToolCallBlock key={key} name={part.name} args={part.args} />;
    case 'tool-result':
      return <ToolResultBlock key={key} name={part.name} result={part.result} isError={part.isError} scope={scope} />;
    case 'notice':
      return <NoticeBlock key={key} text={part.text} />;
    case 'context-summary':
      return <ContextSummaryBlock key={key} part={part} />;
    case 'user-note':
      return <UserNoteBlock key={key} part={part} />;
    case 'image':
    case 'file':
      return (
        <div key={key} className="my-1">
          <AttachmentPartChip part={part} />
        </div>
      );
    default:
      return null;
  }
}

type ToolPart = Extract<Part, { type: 'tool-call' | 'tool-result' }>;

const VERB = { create: 'Created', update: 'Updated to', rewrite: 'Rewrote as' } as const;

/** An artifact call's card (Deck #896): what it made, opening that version in the chat's viewer. */
function ArtifactCard({ result }: { result: unknown }): JSX.Element | null {
  const viewer = useViewer();
  const info = artifactOutcomeOf(result);
  if (!info) return null;
  return (
    <button
      type="button"
      onClick={() => viewer?.openArtifact({ artifactId: info.artifactId, title: info.title, versionId: info.versionId })}
      className="my-1 flex w-full items-center gap-2 rounded border border-[var(--border)] bg-[var(--bg-raised)] px-3 py-2 text-left text-sm hover:bg-[var(--bg-sunken)]"
    >
      <span aria-hidden="true">◧</span>
      <span className="min-w-0 flex-1 truncate font-medium">{info.title}</span>
      <span className="text-xs text-[var(--text-muted)]">{`${info.kind} · ${VERB[info.command]} v${info.number}`}</span>
    </button>
  );
}

/** "Used 14 tools: Glob ×4, Read ×6, Bash" -- names in first-seen order, ×1 omitted. Counts calls; a (shouldn't-happen) run of results alone counts those instead. */
function toolGroupSummary(run: ToolPart[]): string {
  const calls = run.filter((p) => p.type === 'tool-call');
  const counted = calls.length > 0 ? calls : run;
  const counts = new Map<string, number>();
  for (const p of counted) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
  const breakdown = [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ');
  const failed = run.some((p) => p.type === 'tool-result' && p.isError);
  return `${failed ? '⚠ ' : ''}Used ${counted.length} ${counted.length === 1 ? 'tool' : 'tools'}: ${breakdown}`;
}

/** A collapsed-by-default block for one run of consecutive tool calls/results; expanding shows the unchanged per-part blocks. */
function ToolGroup({ run, scope }: { run: ToolPart[]; scope: ToolImageScope }): JSX.Element {
  return (
    <details className="my-1 rounded border border-[var(--border)] bg-[var(--bg-sunken)] px-2 py-1 text-xs">
      <summary className="cursor-pointer font-medium text-[var(--text-muted)] select-none">{toolGroupSummary(run)}</summary>
      <div className="mt-1">{run.map((p, i) => renderPart(p, i, scope))}</div>
    </details>
  );
}

type SubagentPart = Extract<Part, { type: 'subagent' }>;

/** A tool group or a sub-agent card, as `renderParts` lays them out: what an activity fold sums up. */
type Activity = { kind: 'tools'; run: ToolPart[] } | { kind: 'subagent'; part: SubagentPart; status: SubagentStatus; waiting: boolean };

/**
 * "Used 3 tools (Bash ×3) and 2 helpers: Review Task 1, Implement Task 2 · 1 working" -- the tools
 * of every group in the fold counted together, then the helpers by label in order.
 */
function activitySummary(items: Activity[]): string {
  const run = items.flatMap((a) => (a.kind === 'tools' ? a.run : []));
  const helpers = items.flatMap((a) => (a.kind === 'subagent' ? [a] : []));
  const bits: string[] = [];
  if (run.length > 0) {
    const calls = run.filter((p) => p.type === 'tool-call');
    const counted = calls.length > 0 ? calls : run;
    const counts = new Map<string, number>();
    for (const p of counted) counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
    const breakdown = [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ');
    bits.push(`${counted.length} ${counted.length === 1 ? 'tool' : 'tools'} (${breakdown})`);
  }
  if (helpers.length > 0) bits.push(`${helpers.length} ${helpers.length === 1 ? 'helper' : 'helpers'}: ${helpers.map((h) => h.part.label).join(', ')}`);
  const failed = run.some((p) => p.type === 'tool-result' && p.isError) || helpers.some((h) => h.status === 'error');
  const waiting = helpers.filter((h) => h.waiting).length;
  const working = helpers.filter((h) => !h.waiting && (h.status === 'running' || h.status === 'queued' || h.status === 'background')).length;
  const state = [waiting > 0 ? `${waiting} needs your approval` : '', working > 0 ? `${working} working` : ''].filter(Boolean);
  return `${failed ? '⚠ ' : ''}Used ${bits.join(' and ')}${state.length > 0 ? ` · ${state.join(' · ')}` : ''}`;
}

/** Two or more tool groups and sub-agent cards in a row, folded into one closed block so they don't space the reply out. */
function ActivityFold({ items, children }: { items: Activity[]; children: ReactNode }): JSX.Element {
  const summary = activitySummary(items);
  return (
    <details data-testid="activity-fold" className="my-1 rounded border border-[var(--border)] bg-[var(--bg-sunken)] px-2 py-1 text-xs">
      <summary title={summary} className="cursor-pointer font-medium text-[var(--text-muted)] select-none">
        <span className="inline-block max-w-[calc(100%-1.5rem)] truncate align-bottom">{summary}</span>
      </summary>
      <div className="mt-1">{children}</div>
    </details>
  );
}

type ToolCallPart = Extract<Part, { type: 'tool-call' }>;
type ToolResultPart = Extract<Part, { type: 'tool-result' }>;

/** An answered question or a decided plan (spec 2026-10-12-thread-cards-design §7), outside the tool fold like an artifact card. */
function ThreadRecord({ call, result }: { call: ToolCallPart; result: ToolResultPart }): JSX.Element {
  const text = typeof result.result === 'string' ? result.result : (JSON.stringify(result.result) ?? '');
  if (isPlanTool(call.name)) {
    const plan = parsePlan(call.args);
    return (
      <details data-testid="plan-record" className="my-1 rounded border border-[var(--border)] bg-[var(--bg-raised)] px-2 py-1 text-xs">
        <summary className="cursor-pointer font-medium select-none">Plan · {text.split('\n')[0]}</summary>
        {typeof plan === 'string' && (
          <div className="mt-1">
            <MarkdownBody text={plan} />
          </div>
        )}
      </details>
    );
  }
  const questions = parseQuestions(call.args);
  return (
    <div data-testid="question-record" className="my-1 rounded border border-[var(--border)] bg-[var(--bg-raised)] px-2 py-1 text-xs">
      {Array.isArray(questions) && (
        <ul className="font-medium">
          {questions.map((q, i) => (
            <li key={i}>{q.question}</li>
          ))}
        </ul>
      )}
      <p className={`mt-1 whitespace-pre-wrap ${result.isError ? 'text-[var(--danger)]' : 'text-[var(--text-muted)]'}`}>{text}</p>
    </div>
  );
}

/** What `renderParts` needs to know about the reply around the parts it renders. */
interface RenderContext {
  /** The reply's approval cards still waiting, to mark the sub-agent that raised one. */
  pendingApprovals: ApprovalRequest[];
  replyStreaming: boolean;
  /** The latest progress of each generation call still running, by tool call id. */
  progress?: Record<string, MediaProgress>;
  /** The reply the parts belong to: a tool's images (a sub-agent's included) are served only for it. */
  scope: ToolImageScope;
}

/**
 * Renders a message's parts, folding each run of consecutive tool-call/tool-result parts into one `ToolGroup`.
 * An artifact call that made a version (Deck #896) is a card instead, outside the fold; one still running,
 * failed or only viewing folds with the rest, so its error stays visible.
 * A sub-agent is a card where its part sits, with its own parts rendered inside.
 * Two or more tool groups and sub-agent cards in a row fold together into one `ActivityFold`.
 */
function renderParts(parts: Part[], ctx: RenderContext): JSX.Element[] {
  const { scope } = ctx;
  const out: { el: JSX.Element; activity?: Activity; diff?: boolean }[] = [];
  let run: ToolPart[] = [];
  let runStart = 0;
  // Keyed by the run's FIRST part so the key (and the user's open/closed
  // state on the <details>) stays stable while more tool parts stream in.
  // Cards made while a run of tools is open wait for it, so parallel calls stay in one group.
  let cards: JSX.Element[] = [];
  // File edits in the run: they stay in the group (counted, shown in its details) and ALSO show as
  // diffs right after it, outside any activity fold, so they're visible while it's closed
  // (spec 2026-10-20-code-tab-design, Goal 5). Marked `diff` so the fold loop below passes over
  // them instead of letting them split a fold: they land right after the fold their run is in.
  let diffs: JSX.Element[] = [];
  const flush = (): void => {
    if (run.length > 0) out.push({ el: <ToolGroup key={`tools-${runStart}`} run={run} scope={scope} />, activity: { kind: 'tools', run } });
    run = [];
    out.push(...diffs.map((el) => ({ el, diff: true })));
    diffs = [];
    out.push(...cards.map((el) => ({ el })));
    cards = [];
  };
  const addCard = (el: JSX.Element): void => {
    if (run.length > 0) cards.push(el);
    else out.push({ el });
  };
  const carded = new Set(parts.flatMap((p) => (p.type === 'tool-result' && isArtifactTool(p.name) && artifactOutcomeOf(p.result) ? [p.id] : [])));
  // Todo calls are shown as the checklist, never as tools. Question and plan
  // calls show as their record once answered; while waiting, only the card shows.
  const results = new Map(parts.flatMap((p) => (p.type === 'tool-result' ? [[p.id, p] as const] : [])));
  // A finished generation shows as its media outside the fold; a failed one folds with the other tools, so its error stays visible.
  const generated = new Set(parts.flatMap((p) => (p.type === 'tool-result' && isGenerationTool(p.name) && !p.isError && hasGeneratedMedia(p.result) ? [p.id] : [])));
  const recorded = new Set(parts.flatMap((p) => (p.type === 'tool-call' && (isAskTool(p.name) || isPlanTool(p.name)) ? [p.id] : [])));
  // A sub-agent shows as its card; the parent's own call and result that
  // started it (the API `subagent` tool, or Claude Code's Task or Agent) are
  // hidden. A subagent call with no card (refused before it started) stays in
  // the tool group, so its error shows.
  const subagentCards = new Set(parts.flatMap((p) => (p.type === 'subagent' ? [p.callId] : [])));
  parts.forEach((p, i) => {
    if ((p.type === 'tool-call' || p.type === 'tool-result') && subagentCards.has(p.id)) return;
    if (p.type === 'subagent') {
      flush();
      const status = subagentDisplayStatus(p.status, ctx.replyStreaming);
      const awaitingApproval = ctx.pendingApprovals.some((r) => r.subagent?.callId === p.callId);
      out.push({
        el: (
          <SubagentCard key={`subagent-${p.callId}`} part={p} replyStreaming={ctx.replyStreaming} awaitingApproval={awaitingApproval}>
            {renderParts(p.parts ?? [], ctx)}
          </SubagentCard>
        ),
        activity: { kind: 'subagent', part: p, status, waiting: awaitingApproval && status === 'running' },
      });
      return;
    }
    if (p.type === 'tool-call' || p.type === 'tool-result') {
      if (isTodoTool(p.name)) return;
      if (recorded.has(p.id)) {
        const result = p.type === 'tool-call' ? results.get(p.id) : undefined;
        if (p.type === 'tool-call' && result) addCard(<ThreadRecord key={i} call={p} result={result} />);
        return;
      }
      if (generated.has(p.id)) {
        if (p.type === 'tool-result') addCard(<GeneratedMedia key={`media-${p.id}`} result={p.result} scope={scope} />);
        return;
      }
      if (carded.has(p.id)) {
        // A carded call shows as its result's card.
        if (p.type === 'tool-result') addCard(<ArtifactCard key={i} result={p.result} />);
        return;
      }
      if (run.length === 0) runStart = i;
      run.push(p);
      // A generation that is still running shows where it has got to, outside the fold.
      if (p.type === 'tool-call' && isGenerationTool(p.name) && ctx.replyStreaming && !results.has(p.id)) {
        addCard(<GenerationProgress key={`progress-${p.id}`} progress={ctx.progress?.[p.id]} />);
      }
      const diff = p.type === 'tool-call' ? editDiffOf(p.name, p.args) : null;
      if (p.type === 'tool-call' && diff) {
        const result = results.get(p.id);
        diffs.push(<EditDiff key={`diff-${p.id}`} info={diff} status={result ? (result.isError ? 'failed' : 'applied') : 'pending'} />);
      }
      return;
    }
    flush();
    const el = renderPart(p, i, scope);
    if (el) out.push({ el });
  });
  flush();
  // Keyed by the fold's first block, so it stays open while more blocks stream into it.
  const folded: JSX.Element[] = [];
  for (let i = 0; i < out.length; ) {
    let j = i;
    while (j < out.length && (out[j]!.activity || out[j]!.diff)) j++;
    const blocks = out.slice(i, j).filter((b) => b.activity);
    if (blocks.length >= 2) {
      folded.push(
        <ActivityFold key={`activity-${String(blocks[0]!.el.key)}`} items={blocks.map((b) => b.activity!)}>
          {blocks.map((b) => b.el)}
        </ActivityFold>
      );
      // The edit diffs of the run stay visible, after the fold, in order.
      for (const b of out.slice(i, j)) if (b.diff) folded.push(b.el);
      i = j;
    } else {
      folded.push(out[i]!.el);
      i++;
    }
  }
  return folded;
}

/** Position within a set of sibling messages that aren't a compare turn: regenerated replies or edited prompts. */
export interface BranchInfo {
  /** Zero-based position of this message among its siblings. */
  index: number;
  total: number;
  /** -1 for the previous sibling, 1 for the next. */
  onSelect: (delta: -1 | 1) => void;
  /** Both arrows inert, e.g. while a reply streams (a switch would move the head under it). */
  disabled?: boolean;
}

/** The compact `‹ 2 / 3 ›` control. Quiet by design: it only appears when there is something to switch to. */
function BranchSwitcher({ branch }: { branch: BranchInfo }): JSX.Element {
  const arrow =
    'rounded px-1 leading-none hover:bg-[var(--bg-sunken)] hover:text-[var(--text)] disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent';
  return (
    <span
      data-testid="branch-switcher"
      role="group"
      aria-label={`Branch ${branch.index + 1} of ${branch.total}`}
      className="inline-flex items-center gap-0.5 text-xs text-[var(--text-muted)]"
    >
      <button type="button" aria-label="Previous branch" disabled={branch.disabled || branch.index <= 0} onClick={() => branch.onSelect(-1)} className={arrow}>
        ‹
      </button>
      <span className="tabular-nums" aria-hidden="true">
        {branch.index + 1} / {branch.total}
      </span>
      <button type="button" aria-label="Next branch" disabled={branch.disabled || branch.index >= branch.total - 1} onClick={() => branch.onSelect(1)} className={arrow}>
        ›
      </button>
    </span>
  );
}

type AttachmentPart = Extract<Part, { type: 'image' | 'file' }>;

/**
 * Inline editor for a user message: its text in a textarea, plus its
 * attachment chips (removable -- only from this edit; the original message
 * keeps them). Saving hands back the new parts; the caller sends them as a
 * sibling message.
 */
function MessageEditor({
  message,
  editing,
}: {
  message: CanonMessage;
  editing: NonNullable<MessageProps['editing']>;
}): JSX.Element {
  const [text, setText] = useState(() =>
    message.parts
      .map((p) => (p.type === 'text' ? p.text : ''))
      .filter(Boolean)
      .join('\n')
  );
  const [attachments, setAttachments] = useState<AttachmentPart[]>(() =>
    message.parts.filter((p): p is AttachmentPart => p.type === 'image' || p.type === 'file')
  );
  const trimmed = text.trim();
  const canSave = !editing.busy && (trimmed.length > 0 || attachments.length > 0);

  function save(): void {
    if (!canSave) return;
    editing.onSave([...(trimmed.length > 0 ? [{ type: 'text', text: trimmed } as Part] : []), ...attachments]);
  }

  return (
    <div className="space-y-2">
      <textarea
        autoFocus
        aria-label="Edit message"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') editing.onCancel();
          else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save();
        }}
        rows={Math.min(12, Math.max(2, text.split('\n').length))}
        className="w-full resize-y rounded border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
      />
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {attachments.map((p, i) => (
            <AttachmentChip
              key={p.attachmentId}
              filename={p.type === 'file' ? p.filename : imageDisplayName(p.attachmentId, p.mime)}
              mime={p.mime}
              previewUrl={api.attachments.previewable(p.mime) ? api.attachments.contentUrl(p.attachmentId) : undefined}
              onRemove={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
            />
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={!canSave}
          className="btn btn-primary px-3 py-1"
        >
          Save and send
        </button>
        <button
          type="button"
          onClick={editing.onCancel}
          className="btn px-3 py-1"
        >
          Cancel
        </button>
        <span className="text-xs text-[var(--text-muted)]">Sends as a new branch; the original stays.</span>
      </div>
      <div data-testid="edit-profile-note" className="text-xs text-[var(--text-muted)]">
        {editing.profileName ? `Answered by ${editing.profileName}.` : 'Answered by the chat profile.'}
        {editing.compareNote && ' This was a compare prompt; the edit goes to one profile only.'}
      </div>
    </div>
  );
}

export interface MessageProps {
  message: CanonMessage;
  /**
   * > 0 when this message is the KEPT variant of a resolved compare turn
   * that still has other, non-selected siblings sitting around (never
   * deleted -- they cost money and represent work, task 27 design). Renders
   * a "⤺ N other variants" chip that reopens the tab strip in place of this
   * message; omit (or 0) for an ordinary message with no siblings.
   */
  otherVariantsCount?: number;
  onReopenVariants?: () => void;
  /** Tool calls this message has made that are still waiting on a human decision (task 26). Rendered inline, right where the eventual tool-result would appear. */
  pendingApprovals?: ApprovalRequest[];
  /** Required whenever `pendingApprovals` is non-empty; omitted (with an empty array) everywhere a message can never have one, e.g. read-only historical views. */
  onResolveApproval?: (requestId: string, choice: ApprovalChoice) => Promise<void>;
  /** Questions and plans this message's tool calls are waiting on (spec 2026-10-12-thread-cards-design). Rendered after the approval cards. */
  pendingAsks?: UserAsk[];
  /** Required whenever `pendingAsks` is non-empty. */
  onAnswerAsk?: (askId: string, reply: AskReply) => Promise<void>;
  /** The latest progress of each generation call still running, by tool call id. */
  progressByCall?: Record<string, MediaProgress>;
  /** Shows the `‹ 2 / 3 ›` switcher: this message has non-compare siblings (a regenerated reply, an edited prompt). */
  branch?: BranchInfo;
  /** Offers "Regenerate" (assistant messages). Omit where it doesn't apply, e.g. a compare turn's variants. */
  onRegenerate?: () => void;
  /** Offers "Edit" (user messages). */
  onEdit?: () => void;
  /** Draws the message in a bordered box (the thread does; compare cards have their own). */
  framed?: boolean;
  /** Greys out Regenerate/Edit, e.g. while a reply in this chat is streaming. */
  actionsDisabled?: boolean;
  /** Replaces a user message's body with the inline editor. */
  editing?: {
    onSave: (parts: Part[]) => void;
    onCancel: () => void;
    /** Save is inert (a send is in flight, or a reply is streaming). */
    busy?: boolean;
    /** The profile that will answer the edit. */
    profileName?: string;
    /** The original was a compare turn's prompt: the edit goes to ONE profile. */
    compareNote?: boolean;
  };
}

/**
 * Renders one message. This is also the renderer VariantCard (VariantTabs.tsx)
 * wraps for a single tab/split-column's body -- task 27's design calls for
 * the tab strip and the split view to be "a container swap, not a second
 * implementation", so this component stays deliberately unaware of whether
 * it's being shown standalone, inside a tab, or inside a split column.
 */
export function Message({
  message,
  otherVariantsCount = 0,
  onReopenVariants,
  pendingApprovals = [],
  onResolveApproval,
  pendingAsks = [],
  onAnswerAsk,
  progressByCall,
  branch,
  onRegenerate,
  onEdit,
  actionsDisabled = false,
  editing,
  framed = false,
}: MessageProps): JSX.Element {
  const line = contextLineOf(message);
  if (line) {
    // A line edited from another message (or edited into one) still has its siblings to switch to.
    return (
      <ContextLine
        id={`msg-${message.id}`}
        kind={line.kind}
        {...(line.focus !== undefined ? { focus: line.focus } : {})}
        at={message.createdAt}
        aside={branch && branch.total > 1 ? <BranchSwitcher branch={branch} /> : undefined}
      />
    );
  }
  const isUser = message.role === 'user';
  const label = isUser ? 'You' : (message.producedBy?.profileName ?? 'Assistant');
  // Assistant messages already render image/file parts inline, in order,
  // via `renderPart` below -- this is only for the user side, which renders
  // its text as one plain (non-markdown) block rather than part-by-part
  // (see the "renders user messages as plain text" test), so its
  // attachments need their own pass here instead.
  const userAttachmentParts = isUser
    ? message.parts.filter((p): p is Extract<Part, { type: 'image' | 'file' }> => p.type === 'image' || p.type === 'file')
    : [];
  const todos = isUser ? null : latestTodos(message.parts);

  return (
    <article
      id={`msg-${message.id}`}
      data-role={message.role}
      data-status={message.status}
      className={`group space-y-1 ${framed ? 'rounded border border-[var(--border)] bg-[var(--bg)] px-3 py-2' : ''}`}
    >
      <div data-message-header="" className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
        <span className={`label-caps ${isUser ? 'text-[var(--text-muted)]' : 'text-[var(--accent)]'}`}>{label}</span>
        {!isUser && message.producedBy && <span className="font-mono text-[var(--text-faint)]">{message.producedBy.modelId}</span>}
        <time dateTime={new Date(message.createdAt).toISOString()} title={new Date(message.createdAt).toLocaleString()} className="text-[var(--text-faint)]">
          {formatStamp(message.createdAt)}
        </time>
        {message.status === 'error' && <span className="text-[var(--danger)]">error</span>}
        {message.status === 'cancelled' && <span>stopped</span>}
        {branch && branch.total > 1 && <BranchSwitcher branch={branch} />}
        {otherVariantsCount > 0 && (
          <button
            type="button"
            data-testid="reopen-variants-chip"
            onClick={onReopenVariants}
            className="ml-auto rounded-full border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-sunken)]"
          >
            ⤺ {otherVariantsCount} other variant{otherVariantsCount === 1 ? '' : 's'}
          </button>
        )}
        {/* On the label line rather than a line of their own; shown on hover or keyboard focus (opacity only, so still clickable). */}
        {!editing && (onRegenerate || onEdit) && (
          <span
            className={`${otherVariantsCount > 0 ? '' : 'ml-auto'} flex gap-3 opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100`}
          >
            {onRegenerate && (
              <button type="button" onClick={onRegenerate} disabled={actionsDisabled} className="label-caps hover:text-[var(--text)] focus-visible:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-[var(--text-muted)]">
                Regenerate
              </button>
            )}
            {onEdit && (
              <button type="button" onClick={onEdit} disabled={actionsDisabled} className="label-caps hover:text-[var(--text)] focus-visible:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-[var(--text-muted)]">
                Edit
              </button>
            )}
          </span>
        )}
      </div>

      {isUser && editing ? (
        <MessageEditor message={message} editing={editing} />
      ) : (
      <div className={isUser ? 'whitespace-pre-wrap text-sm' : ''}>
        {isUser
          ? message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n')
          : renderParts(message.parts, { pendingApprovals, replyStreaming: message.status === 'streaming', ...(progressByCall ? { progress: progressByCall } : {}), scope: { chatId: message.chatId, messageId: message.id } })}
        {message.status === 'streaming' && <span className="streaming-caret" aria-label="streaming" />}
      </div>
      )}

      {todos && <TodoChecklist todos={todos} streaming={message.status === 'streaming'} />}

      {userAttachmentParts.length > 0 && !editing && (
        <div className="flex flex-wrap gap-1.5">
          {userAttachmentParts.map((p, i) => (
            <AttachmentPartChip key={i} part={p} />
          ))}
        </div>
      )}

      {/* Notices on the user side: an imported message's files the claude.ai export didn't include, say. */}
      {isUser && !editing && message.parts.map((p, i) => (p.type === 'notice' ? <NoticeBlock key={i} text={p.text} /> : null))}

      {pendingApprovals.length > 0 && onResolveApproval && (
        <div className="space-y-1">
          {pendingApprovals.map((request) => (
            <ApprovalPrompt key={request.id} request={request} onResolve={onResolveApproval} />
          ))}
        </div>
      )}

      {pendingAsks.length > 0 && onAnswerAsk && (
        <div className="space-y-1">
          {pendingAsks.map((ask) =>
            ask.kind === 'question' ? (
              <QuestionCard key={ask.id} ask={ask} profileName={label} onAnswer={onAnswerAsk} />
            ) : ask.kind === 'generation' ? (
              <GenerationCard key={ask.id} ask={ask} profileName={label} onAnswer={onAnswerAsk} />
            ) : (
              <PlanCard key={ask.id} ask={ask} profileName={label} onAnswer={onAnswerAsk} />
            )
          )}
        </div>
      )}

      {message.status === 'error' && message.error && (
        <p className="text-xs text-[var(--danger)]">{message.error.message}</p>
      )}

    </article>
  );
}
