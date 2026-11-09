/**
 * The rules for a reply that runs in a mode, for the permission broker
 * (`../permissions.ts`) and the tool provider: what an unattended
 * (scheduled) run's call is told instead of a card, which calls Claude Code
 * auto mode may hand to its own classifier, and which calls Plan mode lets
 * through before the reply's plan is approved. `decide()` applies the plan
 * rule; the provider applies the other two around it.
 */
import { classifyAgentTool } from '../agent-tools.js';
import { BROWSER_READ_COMMANDS } from '../browser-hosts.js';
import type { ToolSpec } from '../../ports/tool-provider.js';
import { PLAN_REFUSAL } from '../thread-tools.js';
import { stringField } from './fields.js';

/**
 * What an unattended (scheduled) run's tool call gets instead of a card
 * (spec 2026-10-12-scheduled-tasks-design §2): the model reads it, so it says
 * what happened and how to let the call run next time.
 */
export const UNATTENDED_REASON =
  'Nobody is watching this scheduled run, so this tool call needed an approval that nobody can give. It did not run. ' +
  'To let it run unattended, allow it ahead of time with an Always grant. Shell commands run unattended in the sandbox ' +
  '(a profile whose shell runs there, with "Ask on changes"); a host the sandbox needs must be on that profile\'s list or have an Always grant. ' +
  'The browser needs an Always grant for each website it opens, reads or acts on, or the website on the profile\'s site list.';

/**
 * Whether, in Claude Code auto mode, a call the broker would ask about may go
 * to Claude Code's own classifier instead of an OtherBench card (spec
 * 2026-10-03-claude-code-auto-mode-design section 3). Every Claude Code tool
 * does, as in Claude Code's own auto mode (VS Code, the CLI): a write to its
 * config (isProtectedAgentPath) and an unrecognised tool included, since the
 * classifier is what Claude Code routes its own protected paths to. A card
 * left waiting overnight stalls the reply and its helpers; a classifier block
 * only tells the model to find another way. OtherBench's own tools never
 * do: each runs only with the ticket its approval leaves, which a hand-off
 * would not, so in auto mode the tool provider approves them instead.
 */
export function isDeferrableInAutoMode(tool: ToolSpec, _args: unknown): boolean {
  return tool.source === 'agent';
}

/**
 * Whether a call may run while its reply's plan is still unapproved (spec
 * 2026-10-12-thread-cards-design §2): OtherBench's own thread, artifact and
 * recall tools; read-risk fs and MCP tools; and Claude Code's file-read,
 * web and internal tools; and the browser's reads of the page that is already
 * open. Everything else, including any source added later, is refused: the
 * default is false on purpose.
 */
export function allowedWhilePlanning(tool: ToolSpec, args?: unknown): boolean {
  switch (tool.source) {
    // The browser (spec 2026-10-12-model-browser-design): reading the open
    // page (`snapshot`, `scroll`) and closing the browser change nothing. By
    // command name, never by declared risk, as the ask-on-mutate read pass
    // does. Everything that changes a page or sends something to a site is
    // refused: `click`, `type`, `select`, `press`, `back`, and `open` too (a
    // request to an address the model chose, which can carry anything in its
    // query). A call with no command, or one OtherBench doesn't know, is refused.
    // `open` has a narrower way through, `openNeedsStandingGrant` below: only
    // to a site a person already let the browser use.
    case 'browser':
      return BROWSER_READ_COMMANDS.has(stringField(args, 'command') ?? '');
    // Computer use (spec 2026-10-12-computer-use-design): every action is
    // refused while planning, the looks (`screenshot`, `cursor_position`,
    // `wait`) included. A look is not like the browser's `snapshot` of a page
    // the model already opened: the first one starts the control session (the
    // shell's native dialog and its indicator), and a screenshot sends
    // whatever is on the screen, any app's window, to the model. Fail closed;
    // the plan can say what it needs to look at.
    case 'computer':
      return false;
    case 'thread':
    case 'artifact':
    case 'recall':
      return true;
    // Starting a sub-agent changes nothing by itself, so a planning reply may
    // send one to look around. This is only safe because the sub-agent's own
    // request carries the same plan gate (SubagentRunner.requestFor): each
    // call it makes comes back through `decide` and is refused here like the
    // parent's would be. Never keep this case without that.
    case 'subagent':
      return true;
    case 'fs':
    case 'mcp':
      return tool.risk === 'read';
    case 'agent': {
      const category = classifyAgentTool(tool.name).category;
      return category === 'file-read' || category === 'web' || category === 'internal';
    }
    default:
      return false;
  }
}

/**
 * What a planning reply's browser `open` is told when its site has no
 * standing grant: the plan gate's own words, and what would let it through.
 */
export const PLAN_BROWSER_OPEN_REFUSAL =
  `${PLAN_REFUSAL} Until then the browser opens only websites that already have a grant or are on the profile's site list; ` +
  'say in your plan which other sites you need.';

/**
 * Whether a call that `allowedWhilePlanning` refuses may still run before the
 * plan is approved, on a standing grant alone: the browser's `open`. Claude
 * Code's WebFetch is allowed while planning, so the browser may go to a site
 * too, but only one a person already let it use, a stored grant (this chat's
 * or an Always one, under the profile grants are matched under) or the
 * profile's site list. `decide()` lets such a call reach the browser's
 * refusals, the site list and the grants, and refuses it with
 * `PLAN_BROWSER_OPEN_REFUSAL` where it would otherwise raise a card: a card
 * would let a planning reply reach a site nobody had approved. In a
 * scheduled run that is exactly what the run allows anyway (a grant or the
 * site list, never a card). Everything that changes a page stays refused.
 */
export function openNeedsStandingGrant(tool: ToolSpec, args?: unknown): boolean {
  return tool.source === 'browser' && stringField(args, 'command') === 'open';
}
