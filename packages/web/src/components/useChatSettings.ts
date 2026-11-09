import { useState, type Dispatch, type SetStateAction } from 'react';
import type { Chat } from '@otherbench/core/ports/store.js';
import type { ClaudeEffort } from '@otherbench/core/types/config.js';
import { api, ApiError } from '../state/api.js';
import { useOtherBenchStore } from '../state/store.js';

export interface ChatSettingsInput {
  chat: Chat;
  /** The store's copy of `chat`, when it has one. */
  storedChat: Chat | undefined;
  autoMode: boolean;
  planMode: boolean;
  effort: ClaudeEffort | null;
  claudeAccount: string | null;
  setSelectedProfileIds: Dispatch<SetStateAction<string[]>>;
  setPickerOpen: Dispatch<SetStateAction<boolean>>;
}

export interface ChatSettings {
  autoError: string | null;
  autoSaving: boolean;
  planError: string | null;
  planSaving: boolean;
  effortError: string | null;
  effortSaving: boolean;
  accountError: string | null;
  accountSaving: boolean;
  profileError: string | null;
  toggleAutoMode: () => Promise<void>;
  togglePlanMode: () => Promise<void>;
  choosePrimaryProfile: (profileId: string) => Promise<void>;
  changeEffort: (next: ClaudeEffort | null) => Promise<void>;
  changeAccount: (next: string | null) => Promise<void>;
}

/** The chat's own settings the composer's toolbar changes (Auto, Plan, profile, effort, Claude account): each saved optimistically, put back with a reason if the save fails. */
export function useChatSettings({ chat, storedChat, autoMode, planMode, effort, claudeAccount, setSelectedProfileIds, setPickerOpen }: ChatSettingsInput): ChatSettings {
  const upsertChat = useOtherBenchStore((s) => s.upsertChat);
  const [autoError, setAutoError] = useState<string | null>(null);
  const [effortSaving, setEffortSaving] = useState(false);
  const [effortError, setEffortError] = useState<string | null>(null);
  const [accountSaving, setAccountSaving] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [autoSaving, setAutoSaving] = useState(false);
  const [planSaving, setPlanSaving] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  /** Flips the chat's Auto setting optimistically; a failed save reverts only `autoMode` and shows why. Applies at once, to a reply already running too (its Claude Code is switched). */
  async function toggleAutoMode(): Promise<void> {
    if (autoSaving) return;
    const previous = autoMode;
    const next = !previous;
    const latest = (): Chat => useOtherBenchStore.getState().chats.find((c) => c.id === chat.id) ?? storedChat ?? chat;
    setAutoError(null);
    setAutoSaving(true);
    upsertChat({ ...latest(), autoMode: next });
    try {
      upsertChat(await api.chats.patch(chat.id, { autoMode: next }));
    } catch (err) {
      const current = useOtherBenchStore.getState().chats.find((c) => c.id === chat.id);
      // A chat removed mid-save must not be re-inserted by the revert.
      if (current) upsertChat({ ...current, autoMode: previous });
      setAutoError(err instanceof ApiError ? err.message : "Couldn't change auto mode. Please try again.");
    } finally {
      setAutoSaving(false);
    }
  }

  /** Flips the chat's Plan mode optimistically; a failed save reverts only `planMode` and shows why. Applies from the next message. */
  async function togglePlanMode(): Promise<void> {
    if (planSaving) return;
    const previous = planMode;
    const next = !previous;
    const latest = (): Chat => useOtherBenchStore.getState().chats.find((c) => c.id === chat.id) ?? storedChat ?? chat;
    setPlanError(null);
    setPlanSaving(true);
    upsertChat({ ...latest(), planMode: next });
    try {
      upsertChat(await api.chats.patch(chat.id, { planMode: next }));
    } catch (err) {
      const current = useOtherBenchStore.getState().chats.find((c) => c.id === chat.id);
      if (current) upsertChat({ ...current, planMode: previous });
      setPlanError(err instanceof ApiError ? err.message : "Couldn't change plan mode. Please try again.");
    } finally {
      setPlanSaving(false);
    }
  }

  /**
   * Makes `profileId` the chat's profile: the selector shows it at once, and
   * the chat keeps it, so it's still chosen after switching away and back. A
   * failed save puts the chat's profile back and shows why; the selector keeps
   * the choice for this message.
   */
  async function choosePrimaryProfile(profileId: string): Promise<void> {
    setSelectedProfileIds((ids) => [profileId, ...ids.slice(1).filter((id) => id !== profileId)]);
    setPickerOpen(false);
    const latest = (): Chat => useOtherBenchStore.getState().chats.find((c) => c.id === chat.id) ?? storedChat ?? chat;
    const previous = latest().profileId;
    if (previous === profileId) return;
    setProfileError(null);
    upsertChat({ ...latest(), profileId });
    try {
      upsertChat(await api.chats.patch(chat.id, { profileId }));
    } catch (err) {
      const current = useOtherBenchStore.getState().chats.find((c) => c.id === chat.id);
      if (current) upsertChat({ ...current, profileId: previous });
      setProfileError(err instanceof ApiError ? err.message : "Couldn't keep the profile for this chat. Please try again.");
    }
  }

  /** Sets the chat's Claude Code effort optimistically; a failed save reverts only `effort` and shows why. Applies from the next message. */
  async function changeEffort(next: ClaudeEffort | null): Promise<void> {
    if (effortSaving) return;
    const previous = effort;
    const latest = (): Chat => useOtherBenchStore.getState().chats.find((c) => c.id === chat.id) ?? storedChat ?? chat;
    setEffortError(null);
    setEffortSaving(true);
    upsertChat({ ...latest(), effort: next });
    try {
      upsertChat(await api.chats.patch(chat.id, { effort: next }));
    } catch (err) {
      const current = useOtherBenchStore.getState().chats.find((c) => c.id === chat.id);
      if (current) upsertChat({ ...current, effort: previous });
      setEffortError(err instanceof ApiError ? err.message : "Couldn't change the effort. Please try again.");
    } finally {
      setEffortSaving(false);
    }
  }

  /** Sets the chat's Claude account optimistically; a failed save reverts only `claudeAccount` and shows why. Applies from the next message. */
  async function changeAccount(next: string | null): Promise<void> {
    if (accountSaving) return;
    const previous = claudeAccount;
    const latest = (): Chat => useOtherBenchStore.getState().chats.find((c) => c.id === chat.id) ?? storedChat ?? chat;
    setAccountError(null);
    setAccountSaving(true);
    upsertChat({ ...latest(), claudeAccount: next });
    try {
      upsertChat(await api.chats.patch(chat.id, { claudeAccount: next }));
    } catch (err) {
      const current = useOtherBenchStore.getState().chats.find((c) => c.id === chat.id);
      if (current) upsertChat({ ...current, claudeAccount: previous });
      setAccountError(err instanceof ApiError ? err.message : "Couldn't change the account. Please try again.");
    } finally {
      setAccountSaving(false);
    }
  }

  return { autoError, autoSaving, planError, planSaving, effortError, effortSaving, accountError, accountSaving, profileError, toggleAutoMode, togglePlanMode, choosePrimaryProfile, changeEffort, changeAccount };
}
