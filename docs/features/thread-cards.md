# Thread cards: checklists, questions and plan mode

These follow spec `docs/superpowers/specs/2026-10-12-thread-cards-design.md` (git-ignored, like the other specs here). They put three things in the thread: a progress checklist, question cards and a Plan mode.

- **Checklist.** It is built from the reply's last `update_todos` call (API profiles) or `TodoWrite` call (Claude Code). Each call carries the whole list, so the newest one replaces the rest. The thread shows it as a checklist in place of a tool row, and the Inspector has a Progress section for the open chat. `parseTodos` is the strict check for `update_todos` input and `readTodos` the lenient one used for display.
- **Question cards.** The model asks one to four questions of two to four options each. The card always offers a free-text "Other", multi-select answers are joined with ", ", and the user can decline. Option previews are not shown. API profiles get the answers back as `User has answered your questions: "Q"="A". You can now continue with the user's answers in mind.` Claude Code's own tool result reads `Your questions have been answered ...` instead (see the probe notes below).
- **Plan mode.**
  - **Switch.** It is per chat (`chat.plan_mode`, migration `022-chat-plan-mode`, `PATCH /api/chats/:id` with `planMode`). The composer has a **Plan** pill (`aria-label="Plan mode"`), saved optimistically and reverted if the save fails. It applies from the next message.
  - **Flow.** While it is on, the model sets out a plan with `propose_plan` and waits. The card offers Approve or "Ask for changes" with a note.
  - **Lifetime.** An approval lasts for the rest of that one reply. A compare variant, a retry and the next message each start closed again.
  - **Scope.** Approving a plan approves no tool call. Anything that changes something still gets its usual card or grant afterwards.
- **Sources and tools.**
  - **API profiles.** `ToolSource` has a new member, `'thread'`, with three tools: `update_todos`, `ask_user` and `propose_plan` (`core/src/domain/thread-tools.ts`, run by `tools/src/thread-tools.ts`). The policy allows them with no card and no grants after the policy check, and every call is audited like any other.
  - **Claude Code.** It keeps its own `TodoWrite` and `AskUserQuestion`. `AskUserQuestion` is answered inside the PreToolUse hook: the hook returns `allow` with the answers in `updatedInput.answers`, keyed by question text, so OtherBench's card is the answer. `propose_plan` lives on OtherBench's per-process server (`mcp__otherbench_<16 hex>__propose_plan`) only while the reply is planning, and is reported as `propose_plan`. `EnterPlanMode` and `ExitPlanMode` are always disallowed (`agentDisallowedTools`), as OtherBench's plan mode replaces them.
  - **Todo flag.** Newer models such as Sonnet are not offered `TodoWrite` in SDK sessions by default, so `buildChildEnv` sets `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` for every Claude Code process.
- **What the probe found** (Task 1, `engine-claude-code/test/fixtures/README.md`, section "Thread tools"; decision `ASK_PATH=hook, TODO_FLAG=env`).
  - **Hook answer.** It worked live. The model got `Your questions have been answered: ...` and replied with the answer, and `canUseTool` was never called, so the hook gets there first as it does for other tools.
  - **Hook refusal.** A `deny` with a reason reaches the model wrapped as `PreToolUse:AskUserQuestion hook error: <reason>`. The turn still finishes `success`.
  - **Todos.** Sonnet lists `TodoWrite` with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`. Haiku lists it anyway.
  - **Clean chat.** The tools check (`tools: ['WebSearch', 'WebFetch', 'TodoWrite', 'AskUserQuestion']`) ran on Haiku only. A clean chat on Sonnet is unprobed.
  - **Fallbacks.** Task F (fallback ask and todo tools on OtherBench's own server) was not needed and was not built.
- **The route.** `POST /api/asks/:id/answer` takes exactly one of `{ answers: string[] }`, `{ declined: true }`, `{ approve: true }` or `{ changes: string }`.
  - **Statuses.** 200 `{ answered: true }`; 404 when the ask is unknown or already settled; 400 when the body has the wrong shape, or doesn't fit the ask (an `approve` sent to a question, a `declined` sent to a plan, the wrong number of answers, a blank or over-long answer or change note).
  - **Paired machines.** It is forwarded to the machine running the chat, like `/approvals/:id/resolve`. The peer listener allows it for a paired machine.
  - **Limits.** At most 50 asks are pending at once. Past that the oldest is settled as cancelled and logged. Each answer is at most 4,000 characters, a change note 8,000 and a plan 20,000.
- **The planning rule.** Until the reply's plan is approved, `decide` (`core/src/domain/permissions.ts`) refuses any call that `allowedWhilePlanning` rejects. The refusal is "Plan mode is on: set out your plan with propose_plan and wait for the user's approval before changing anything.", with no card, audited `deny:plan`. The browser's `open` is the one partial exception: it goes through on a standing grant or the profile's site list and is otherwise refused the same way, never with a card (see `browser.md`, "Plan mode").
  - **Allowed while planning.** `thread`, `artifact` and `recall` tools. `fs` and `mcp` tools with risk `read`. Claude Code tools in the categories `file-read`, `web` and `internal`.
  - **Everything else is refused.** That includes any source added later, so the rule fails closed. It only adds refusals: an allowed call still goes on to its grants or card.
  - **Parallel calls.** On the AI SDK path a call made alongside `propose_plan` is refused, as the gate is still closed when it is decided. Claude Code runs OtherBench's server tools one at a time and its PreToolUse hook runs just before each tool, so a Write sent in the same message as `propose_plan` reaches the gate after the user approves, and goes on to its normal card. That is not a bypass, the card still applies.
- **Unattended runs.** `ToolContext.unattended` and `EngineRequest.unattended` are added by this feature, and the schedule service now sets them (see Scheduled tasks below). When set, there is no card, no event, no notification and no tab dot. A question gets "Nobody is here to answer: this run is unattended. Use your judgement, carry on, and say in your reply what you assumed." A plan gets "Nobody can approve a plan in this run, so nothing may be changed. Don't propose it again; finish by setting out your plan in your reply.", and the gate stays closed. Unit tests cover both, and the scheduled-tasks e2e runs a refused tool call for real.
- **Telling you.** A pending question or plan counts like a pending tool approval: the tab dot (label "waiting for you") and a desktop notification, "Waiting for your answer" or "Plan waiting for your approval". The approvals toggle in Settings is now "Approvals, questions and plans".
- **Known gaps** (the first six are Phase 2 in the spec).
  - Cowork's `TaskCreate` and `TaskUpdate` are not folded into the checklist.
  - Option previews are not shown.
  - The tray's count is tool approvals only.
  - The quick-chat window has no cards.
  - There is no per-profile switch for any of this.
  - There is no "Approve, and allow file edits for this reply" shortcut on the plan card, so every write still gets its own card after the approval.
  - A subagent's `TodoWrite` replaces the reply's checklist.
  - The model can do something other than the plan it had approved. Each call's own card or grant is still the control.
  - On a paired machine, a reply that runs on the other machine asks for you there, but the question or plan is not announced app-wide on this one (no tab dot, no notification). The card itself shows in the thread through the relayed stream. Remote tool approvals already behave this way.
  - Clean chats on Sonnet have not been probed for `TodoWrite` and `AskUserQuestion` (see the probe notes above).
- **Live check (manual)** (spec section 9). Not done yet, these need a real Claude Code and a desktop window.  1. A Claude Code folder chat on Sonnet shows a checklist.
  2. Claude Code asks through the card, in a folder chat and in a clean chat (the clean chat on Sonnet is the unprobed case).
  3. With Plan on: a write is refused, the model proposes a plan, you ask for changes, it proposes again, you approve, and the write then gets its own card.
  4. A question while the window is unfocused raises a desktop notification.
  5. An API profile uses `ask_user` and `update_todos` sensibly.
