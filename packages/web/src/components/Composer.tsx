import { useEffect, useId, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import type { Chat } from '@otherbench/core/ports/store.js';
import type { Profile } from '@otherbench/core/types/config.js';
import { ESCAPE_STOPS_REPLY_ATTR } from '../lib/escapeStopsReply.js';
import { useStopReply } from '../state/useStopReply.js';
import { api } from '../state/api.js';
import { useOtherBenchStore } from '../state/store.js';
import { CommandMenu, commandOptionId, filterCommands } from './CommandMenu.js';
import { useChatCommands } from '../state/useChatCommands.js';
import type { CommandRow } from '@otherbench/core/domain/context-lines.js';
import { AttachmentChip } from './AttachmentChip.js';
import { PlanUsageMeter } from './PlanUsageMeter.js';
import { remoteUnreachable } from '../state/machines.js';
import { useUnsentText } from '../state/unsent.js';
import { factFromMessage } from '@otherbench/core/domain/app-notes.js';
import { ChatSettingsControls } from './ChatSettingsControls.js';
import { ComposerNotices } from './ComposerNotices.js';
import { ComparePicker, isClaudeCodeProfile, ProfilePicker } from './ProfilePickers.js';
import { useChatSettings } from './useChatSettings.js';
import { useComposerAttachments } from './useComposerAttachments.js';
import { useComposerFocus } from './useComposerFocus.js';
import { useComposerHistory } from './useComposerHistory.js';
import { useComposerSend } from './useComposerSend.js';

export { isClaudeCodeProfile };

export interface ComposerProps {
  chat: Chat;
  /**
   * The message id the next turn should be parented on -- the conversation's
   * effective tail, already extended forward through any run of single-child
   * replies (mirrors Thread.tsx's own `tailId`, computed the same way
   * `extendForward` walks a lone reply into `displayPath` for display).
   * Falls back to `chat.headMessageId` when omitted (e.g. call sites, tests
   * included, that don't need the distinction).
   *
   * This has to be separate from `chat.headMessageId` and NOT derived from
   * it in here: `chat.headMessageId` deliberately stays pinned to the
   * previous turn's USER message (never auto-advanced to an assistant reply
   * -- picking a reply is always an explicit "Keep", task 27), but nothing
   * ever shows a Keep control for a single-profile reply (Thread only renders
   * one once `openVariants.length > 1`), so there is no way to advance head
   * itself past a lone reply. Sending the NEXT turn against the raw,
   * un-extended `chat.headMessageId` therefore parents the new user message
   * as a SIBLING of the previous assistant reply rather than a child of it --
   * demoting a real reply to a "⤺ 1 other variant" chip and hiding it from
   * the thread. Found via the task-31 end-to-end smoke path, which is the
   * first place two ordinary single-profile turns were ever sent back to
   * back against a live server in the same chat.
   */
  parentId?: string | null;
  /**
   * Set while a compare turn's tabs are open and none has been kept: the name
   * of the reply whose tab is showing, which `parentId` already points at.
   * Shown as a hint so it is clear which reply the next message continues.
   */
  continuesFrom?: string | null;
  /** Told the primary selected profile id whenever it changes (and on mount), so an inline edit elsewhere can use the picker's choice. */
  onPrimaryProfileChange?: (profileId: string | null) => void;
}

export function Composer({ chat, parentId, continuesFrom = null, onPrimaryProfileChange }: ComposerProps): JSX.Element {
  const profiles = useOtherBenchStore((s) => s.profiles);
  const connections = useOtherBenchStore((s) => s.connections);
  // The store's copy, so an optimistic toggle shows at once even if the parent
  // hasn't re-rendered with the new chat yet.
  const storedChat = useOtherBenchStore((s) => s.chats.find((c) => c.id === chat.id));

  const [text, setText] = useState('');
  useUnsentText(text);
  const caretTo = useRef<'start' | 'end' | null>(null);
  const { browsing, setBrowsing, stepHistory } = useComposerHistory({ chat, storedChat, parentId, text, setText, caretToRef: caretTo });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [comparePickerOpen, setComparePickerOpen] = useState(false);
  const [selectedProfileIds, setSelectedProfileIds] = useState<string[]>(() => (chat.profileId ? [chat.profileId] : []));
  const { attachments, setAttachments, dragOver, removeError, setRemoveError, uploadError, uploadFiles, handleDragOver, handleDragLeave, handleDrop, handlePaste, removeAttachment } =
    useComposerAttachments(chat.id);
  // A one-line `# fact` in an app chat: saved to the app's notes on send rather than sent (see saveNoteFact).
  const noteFact = chat.appId && attachments.length === 0 ? factFromMessage(text) : null;
  const appName = useOtherBenchStore((s) => (chat.appId ? (s.apps.find((a) => a.id === chat.appId)?.name ?? null) : null));
  const [noteReturned, setNoteReturned] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // The `/` menu: open while the box holds just `/name` (no space yet) and a selected profile runs Claude Code.
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const menuId = useId();
  // The message field starts one line high and grows with its text, up to its max height (then it scrolls).
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
  }, [text]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const primaryId = selectedProfileIds[0] ?? null;
  useEffect(() => {
    onPrimaryProfileChange?.(primaryId);
  }, [primaryId, onPrimaryProfileChange]);

  const selectedProfiles = selectedProfileIds.map((id) => profiles.find((p) => p.id === id)).filter((p): p is Profile => !!p);
  // A folder that doesn't resolve on this machine blocks sending until the
  // prompt above the composer is answered (v2 spec §6).
  const folderUnresolved = (storedChat ?? chat).workspaceStatus?.status === 'unresolved';
  // A chat that runs on a machine that can't be reached waits for it, or for Run here (UnreachableBanner).
  const machines = useOtherBenchStore((s) => s.machines);
  const elsewhereUnreachable = remoteUnreachable(machines, storedChat ?? chat);
  // Auto mode (spec 2026-10-03-claude-code-auto-mode-design section 2): offered
  // when any selected profile runs through Claude Code; it needs the Claude
  // login, so it's unavailable when every such profile uses an endpoint backend.
  const claudeCodeProfiles = selectedProfiles.filter((p) => isClaudeCodeProfile(p, connections));
  const showAutoToggle = claudeCodeProfiles.length > 0;
  const slashTyped = /^\/\S*$/.test(text);
  const chatCommands = useChatCommands(chat.id, claudeCodeProfiles[0]?.id ?? null, slashTyped && !menuDismissed);
  const menuRows = slashTyped && claudeCodeProfiles.length > 0 ? filterCommands(chatCommands.commands, text.slice(1)) : [];
  const menuOpen = menuRows.length > 0 && !menuDismissed;
  const activeRow = menuRows[Math.min(menuIndex, menuRows.length - 1)];
  const autoUnavailable = showAutoToggle && claudeCodeProfiles.every((p) => !!connections.find((c) => c.id === p.connectionId)?.baseUrl);
  const autoMode = (storedChat ?? chat).autoMode;
  const autoActive = autoMode && !autoUnavailable;
  const planMode = (storedChat ?? chat).planMode === true;
  const effort = (storedChat ?? chat).effort ?? null;
  const claudeAccount = (storedChat ?? chat).claudeAccount ?? null;
  const primaryProfile = profiles.find((p) => p.id === selectedProfileIds[0]) ?? null;
  const comparedProfiles = selectedProfileIds.slice(1).map((id) => profiles.find((p) => p.id === id)).filter((p): p is NonNullable<typeof p> => !!p);
  const settings = useChatSettings({ chat, storedChat, autoMode, planMode, effort, claudeAccount, setSelectedProfileIds, setPickerOpen });

  const { streaming: isStreaming, canStop, stop: stopReplies } = useStopReply(chat.id);
  // While a reply runs, or messages sent during one still wait, Send makes a note (spec 2026-10-18-send-while-replying-design).
  const waitingCount = useOtherBenchStore((s) => s.chatNotes[chat.id]?.length ?? 0);
  const busy = isStreaming || waitingCount > 0;

  // A note that comes back (a stopped or lost reply, or one taken back) goes after the draft, its attachments as chips again.
  const returnedCount = useOtherBenchStore((s) => s.returnedNotes.filter((n) => n.chatId === chat.id).length);
  // Attachments a returned note brought back: a send still in flight with the same chips mustn't clear them when it ends.
  const returnedAttachmentIds = useRef(new Set<string>());
  useEffect(() => {
    if (returnedCount === 0) return;
    const taken = useOtherBenchStore.getState().takeReturnedNotes(chat.id);
    if (taken.length === 0) return;
    // While a recalled message shows, the draft is the one kept aside, not that message.
    const kept = browsing?.draft;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- takes the notes out of the store's queue, which can only happen once the render is committed; the text and chips are what it hands back.
    setText((draft) => [kept ?? draft, ...taken.map((n) => n.text)].filter((t) => t.trim().length > 0).join('\n\n'));
    setBrowsing(null);
    for (const n of taken) for (const a of n.attachments) returnedAttachmentIds.current.add(a.attachmentId);
    setAttachments((prev) => [
      ...prev,
      ...taken.flatMap((n) => n.attachments).filter((a) => !prev.some((p) => p.id === a.attachmentId)).map((a) => ({ id: a.attachmentId, filename: a.filename, mime: a.mime })),
    ]);
    // A note doesn't carry its attachments' sizes; unsent again, they are in the chat's list.
    if (taken.some((n) => n.attachments.length > 0)) {
      Promise.resolve(api.attachments.list(chat.id))
        .then((list) => {
          if (!Array.isArray(list)) return;
          const sizes = new Map(list.map((a) => [a.id, a.size]));
          setAttachments((now) => now.map((a) => (a.size === undefined && sizes.has(a.id) ? { ...a, size: sizes.get(a.id) } : a)));
        })
        .catch((err: unknown) => console.error(`[otherbench-web] failed to load the sizes of returned attachments for chat ${chat.id}:`, err));
    }
    if (taken.some((n) => !n.takenBack)) setNoteReturned(true);
    // Taken back: the button that did it goes with its note, so the cursor comes here rather than to the page.
    if (taken.some((n) => n.takenBack)) {
      // Only when text was added: an unchanged box wouldn't use up the caret move until the next keystroke.
      if (taken.some((n) => n.text.trim().length > 0)) caretTo.current = 'end';
      textareaRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when notes come back, not when browsing history; the draft it keeps is this render's.
  }, [returnedCount, chat.id]);

  // Text handed to this chat's box from outside (an issue's "Start a chat on
  // this", spec 2026-10-20-code-tab-design Goal 7): it goes after the draft,
  // the same as a returned note, and is never sent from here.
  const hasPrefill = useOtherBenchStore((s) => s.composerPrefills[chat.id] !== undefined);
  useEffect(() => {
    if (!hasPrefill) return;
    const handed = useOtherBenchStore.getState().takeComposerPrefill(chat.id);
    if (handed === null) return;
    const kept = browsing?.draft;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- takes the text out of the store's queue, which can only happen once the render is committed.
    setText((draft) => [kept ?? draft, handed].filter((t) => t.trim().length > 0).join('\n\n'));
    setBrowsing(null);
    caretTo.current = 'end';
    textareaRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when text is handed over, not when browsing history; the draft it keeps is this render's.
  }, [hasPrefill, chat.id]);

  useComposerFocus(chat.id, textareaRef);

  const { sending, sendError, handleSend } = useComposerSend({
    chat,
    parentId,
    text,
    setText,
    setBrowsing,
    attachments,
    setAttachments,
    setRemoveError,
    setNoteReturned,
    returnedAttachmentIds,
    textareaRef,
    noteFact,
    selectedProfileIds,
    profiles,
    folderUnresolved,
    elsewhereUnreachable,
    busy,
    claudeCodeProfiles,
    commands: chatCommands.commands,
  });

  async function handleStop(): Promise<void> {
    await stopReplies();
  }

  /** What picking a row puts in the box: `/clear` whole, anything else ready for its arguments. */
  const commandFill = (command: CommandRow): string => (command.name === 'clear' ? `/${command.name}` : `/${command.name} `);

  function pickCommand(command: CommandRow): void {
    caretTo.current = 'end';
    setText(commandFill(command));
    setBrowsing(null);
    setMenuDismissed(true);
    textareaRef.current?.focus();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (menuOpen && !e.nativeEvent.isComposing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setMenuIndex((i) => (Math.min(i, menuRows.length - 1) + step + menuRows.length) % menuRows.length);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        // Enter on a box that already holds the row's whole command (`/clear`) sends it rather than filling it again.
        const complete = e.key === 'Enter' && activeRow !== undefined && text === commandFill(activeRow) && !text.endsWith(' ');
        if (activeRow && !complete) {
          e.preventDefault();
          pickCommand(activeRow);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMenuDismissed(true);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !e.nativeEvent.isComposing) {
      stepHistory(e);
    }
  }

  // After a step through the history, put the caret where the next step expects it.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el || caretTo.current === null) return;
    const at = caretTo.current === 'start' ? 0 : el.value.length;
    el.setSelectionRange(at, at);
    caretTo.current = null;
  }, [text]);


  function togglePickerProfile(id: string): void {
    setSelectedProfileIds((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]));
  }

  return (
    <div
      data-testid="composer-dropzone"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`border-t px-3 py-2 ${dragOver ? 'border-[var(--accent)] bg-[var(--bg-sunken)]' : 'border-[var(--border)] bg-[var(--bg-raised)]'}`}
    >
      <ComposerNotices
        uploadError={uploadError}
        removeError={removeError}
        autoError={settings.autoError}
        planError={settings.planError}
        profileError={settings.profileError}
        effortError={settings.effortError}
        accountError={settings.accountError}
        noteFact={noteFact}
        appName={appName}
        sendError={sendError}
        noteReturned={noteReturned}
        continuesFrom={continuesFrom}
      />

      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        data-testid="composer-file-input"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = ''; // so choosing the same file again still fires
          if (files.length > 0) void uploadFiles(files);
        }}
      />

      {/* One box: attachments, the message, and a toolbar of the turn's settings with Send at its end. */}
      <div
        data-composer-box=""
        // A container, so the toolbar can tighten up by the box's own width (a narrow pane, not just a narrow window).
        className="@container rounded border border-[var(--border-strong)] bg-[var(--bg)] focus-within:border-[var(--accent)] focus-within:ring-1 focus-within:ring-[var(--accent)]"
      >
        {attachments.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 px-2 pt-2">
            {attachments.map((a) => (
              <AttachmentChip
                key={a.id}
                filename={a.filename}
                mime={a.mime}
                size={a.size}
                previewUrl={api.attachments.previewable(a.mime) ? api.attachments.contentUrl(a.id) : undefined}
                onRemove={() => void removeAttachment(a.id)}
                removeDisabled={sending}
              />
            ))}
          </div>
        )}

        <div className="relative">
          {menuOpen && <CommandMenu id={menuId} commands={chatCommands.commands} query={text.slice(1)} activeIndex={Math.min(menuIndex, menuRows.length - 1)} onPick={pickCommand} warning={chatCommands.warning} />}
        <textarea
          ref={textareaRef}
          // Escape here stops a running reply (Thread), unless the slash-command list takes it first.
          {...{ [ESCAPE_STOPS_REPLY_ATTR]: '' }}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setBrowsing(null); // typing in a recalled message makes it the draft
            setMenuDismissed(false);
            setMenuIndex(0);
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          aria-label="Message"
          aria-controls={menuOpen ? menuId : undefined}
          aria-activedescendant={menuOpen && activeRow ? commandOptionId(menuId, activeRow.name) : undefined}
          placeholder="Message…"
          title="Enter to send, Shift+Enter for a new line. Drag and drop or paste to attach a file."
          rows={1}
          className="block max-h-48 w-full resize-none overflow-y-auto bg-transparent px-3 pt-2 pb-1 text-sm outline-none"
        />
        </div>

        {/*
          One line while it fits: the plan meter gives way first (by the box's width), then Send and the meter
          drop to a line of their own. Left alone on theirs, the controls cut the profile name short, and past
          that wrap rather than run out of the box: how wide they need to be depends on which ones show.
        */}
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 px-2 pb-1.5">
          <div className="flex flex-auto flex-wrap items-center gap-x-1.5 gap-y-1">
          <button
            type="button"
            aria-label="Attach files"
            title="Attach files"
            onClick={() => fileInputRef.current?.click()}
            className="shrink-0 rounded px-1.5 py-0.5 text-sm text-[var(--text-muted)] hover:bg-[var(--bg-sunken)] hover:text-[var(--text)]"
          >
            <span aria-hidden="true">📎</span>
          </button>

          <ProfilePicker
            profiles={profiles}
            connections={connections}
            primaryProfile={primaryProfile}
            selectedProfileIds={selectedProfileIds}
            pickerOpen={pickerOpen}
            setPickerOpen={setPickerOpen}
            choosePrimaryProfile={settings.choosePrimaryProfile}
          />

          <ChatSettingsControls
            settings={settings}
            planMode={planMode}
            showAutoToggle={showAutoToggle}
            autoActive={autoActive}
            autoUnavailable={autoUnavailable}
            effort={effort}
            claudeAccount={claudeAccount}
          />

          <ComparePicker
            profiles={profiles}
            comparedProfiles={comparedProfiles}
            selectedProfileIds={selectedProfileIds}
            comparePickerOpen={comparePickerOpen}
            setComparePickerOpen={setComparePickerOpen}
            togglePickerProfile={togglePickerProfile}
          />

          </div>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            {/* Plan limits belong to the Claude login, so not to a Claude Code profile on an endpoint (Deck #825). */}
            {showAutoToggle && !autoUnavailable && <PlanUsageMeter busy={isStreaming} account={(storedChat ?? chat).claudeAccount ?? null} />}
            {/* While a reply runs, Send stays beside Stop: what's sent then waits for the reply or goes into it. */}
            {canStop && (
              <button
                type="button"
                onClick={() => void handleStop()}
                className="btn btn-danger bg-[var(--danger)] px-3 py-1 text-[var(--bg)]"
              >
                Stop
              </button>
            )}
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={sending || (text.trim().length === 0 && attachments.length === 0) || selectedProfileIds.length === 0 || folderUnresolved || elsewhereUnreachable}
              className="btn btn-primary px-3 py-1"
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
