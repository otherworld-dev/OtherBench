# Desktop and two-machine checklist

What the automated tests can't cover: the desktop shell's tray, hotkey and
notifications, and two physical machines. Run through it on Windows (the PC
and the laptop) after desktop or peer changes. Linux is in the v2 plan but
not a priority; the Linux notes are for when it is.

## Shell

- [ ] The app launches and the UI loads (`npm run app:dev -w @grunt/desktop`, or a `tauri build --debug --no-bundle` build).
- [ ] DevTools: every request goes to `127.0.0.1:<port>` and carries `Authorization`.
- [ ] Killing the app's process ends the server within 3 seconds.
- [ ] `npm run serve` while the app runs refuses with the database lock message.

## Tray, single instance, start at login

- [ ] Closing the window hides it to the tray; *Quit Grunt* in the tray exits.
- [ ] A second launch focuses the running window.
- [ ] *Start Grunt when I sign in* (Settings → Desktop) survives a reboot.
- [ ] The tooltip counts tool calls waiting for approval.

## Hotkey and quick chat

- [ ] The hotkey (default `Ctrl+Alt+G`) opens quick chat with another app focused.
- [ ] Quick chat appears on the active monitor.
- [ ] *Expand* carries the chat into the main window; `Esc` hides quick chat.
- [ ] A hotkey that's already taken shows an error in Settings → Desktop.

## Notifications

With the window hidden in the tray:

- [ ] A finished reply notifies once, with the chat title.
- [ ] An approval notifies once, naming the tool.
- [ ] Windows: clicking the notification opens that chat.
- [ ] Linux: clicking the tray icon opens the last chat notified about.
- [ ] Nothing notifies while the window is focused; the per-event toggles in Settings → Desktop work.

## Files and folders

- [ ] Drag an image from Explorer into the composer.
- [ ] *Choose folder…* in the Inspector uses the native picker.
- [ ] *Attach* uses the native file picker.
- [ ] `--open-folder <path>` and `--send <file>` start a chat (the Explorer verbs come with the installer, Task 41).

## Two machines

On the PC and the laptop, both on the LAN:

- [ ] Settings → Machines → *Show a code* on the PC: the code, an address and a short fingerprint show; Windows asks about the firewall the first time (allow **Private** only).
- [ ] *Add a machine* on the laptop with that address and code: both list each other as *Connected* within a few seconds.
- [ ] A wrong code is refused; five wrong codes cancel the code on the PC.
- [ ] Chats, profiles and connections from each machine appear on the other; *Synced … ago* updates in Settings → Machines.
- [ ] Settings → Locations: add Nextcloud with the PC's path; on the laptop, set its own path. A chat with a folder inside Nextcloud resolves on both.
- [ ] On the laptop, a PC chat (*Runs on: PC*) runs on the PC: its folder, a tool approval answered on the laptop, and the PC's audit trail says the laptop approved it.
- [ ] Turn the PC off mid-reply: the laptop ends the reply with an error, shows *This chat runs on PC, which isn't reachable*, and *Run here* works (asking for the folder if it isn't on the laptop).
- [ ] Turn the PC back on: what the laptop wrote meanwhile appears on the PC.
- [ ] A connection set to *Keep the API key on this machine* reaches the other machine without its key.
- [ ] *Remove* a machine on one side: the other stops listing it (if it was reachable) and its calls are refused either way.
- [ ] The same over the VPN, from off the LAN.

## Computer use (Deck #927) — by hand, Windows only

None of this has been run. The build never moved the mouse, pressed a key or
captured the screen: the Rust that does so compiles and its state machine is
tested against a fake desktop, but that is all. It ships switched off. See
*Computer use* in `docs/HANDOVER.md` for how it is meant to behave.

**Switch it on** (from this checkout, in PowerShell):

1. `$env:GRUNT_COMPUTER_USE = '1'; npm run app:dev -w @grunt/desktop` (the
   value must be exactly `1`; the dev command builds the packages first).
2. Settings → Profiles: tick **Computer use** on a profile. The box only shows
   when the server says the shell has a driver (`GET /api/computer/status`).
   For the model checks you need an Anthropic profile on a toolset model
   (Opus 5.5, say), one on a model that gets the JSON tool, and a Claude Code
   profile.

**Switch it off:** quit Grunt from the tray and start it again from a window
where the variable isn't set (`Remove-Item Env:GRUNT_COMPUTER_USE`, or a new
PowerShell window). The profile's tick can stay: with no driver the tool is
never offered.

Notepad and Calculator are catalog-signed, so the shell reports no signer for
them and they should only ever get **Allow once**. For the items that need
**Allow for this chat**, use an app with its own signature (Word or Excel, for
example) and check first that its card offers it.

### Consent and stop

- [ ] 1. The first action in a chat (a screenshot is enough) brings up a Windows message box titled *Grunt*: "Let Grunt control this computer for the chat named '<title>'? It will ask before using each app. Stop any time with Ctrl+Alt+Backspace." It is on top, also with focus-stealing prevention in the way (another app typed in just before), and the title reads as one plain line. Cancel is the default: Enter is Cancel, and Tab then Enter is OK.
- [ ] 2. Cancel refuses: the reply's tool result says "The user didn't let Grunt control the computer." and nothing else happens.
- [ ] 3. Left unanswered, the dialog closes by itself after 110 seconds and the tool result says "Nobody answered the desktop app's question in time, so Grunt didn't take control." It also closes as Cancel when Grunt quits. Stop the reply while the dialog is up, then press OK: no session is left running (no bar, and the next action asks again).
- [ ] 4. The dialog comes before the first app card, never after it.
- [ ] 5. On OK the bar appears at the top centre of the primary monitor: "Grunt is controlling this computer", the chat title and the last action. It doesn't take focus, it isn't in the model's screenshots, and its Stop ends control. Stop is the only thing that works from the bar (the indicator has no other command).
- [ ] 6. The thread banner reads "Grunt is controlling this computer." with the last action, and its Stop ends control.
- [ ] 7. Ctrl+Alt+Backspace stops a long `type` part way: no character arrives after the stop. The same with an end from Grunt (the banner's Stop) mid-typing.
- [ ] 8. Each of the three stops (banner, bar, hotkey) cancels the running reply, puts the bar away and unregisters the stop hotkey.
- [ ] 9. Ctrl+Alt+Backspace is only registered while a chat holds control: after a session ends, the combination does whatever it did before.
- [ ] 10. The server's shortcut list follows the stop hotkey being registered and released (the shell sends a `computer.shortcuts` event each time). A `key` action sent before the shell's hello is refused ("Grunt doesn't know the desktop app's shortcuts yet; no key was pressed.").
- [ ] 11. Setting the quick-chat hotkey to Ctrl+Alt+Backspace is refused in Settings → Desktop ("Ctrl+Alt+Backspace stops computer use; pick another shortcut."). The quick-chat hotkey still works during and after a session.
- [ ] 12. A second chat can't start while one holds control ("Another chat is controlling this computer. Stop it first."), and starts normally once the first is stopped.
- [ ] 13. A session that was used carries over to the chat's next reply with no new dialog. One that was started but never used ends with its reply.
- [ ] 14. After 10 minutes with no action the session ends by itself: the banner and the bar go and the hotkey is released.
- [ ] 15. Deleting the chat (or its profile) while it holds control ends the session.
- [ ] 16. With the screen locked (Win+L), start from a paired machine or another signed-in device: no session starts until someone at the machine answers the dialog, and an action in a session that is already live is refused ("Grunt couldn't read the keyboard state (is the computer locked?); nothing was done."). The same with a UAC prompt up.
- [ ] 17. A start whose bar can't be shown (if that can be provoked) is refused and the stop hotkey is released.

### Targets and risk

- [ ] 18. A click on the taskbar asks every time (Explorer only gets Allow once). Start, Search and Settings the same.
- [ ] 19. A click on Grunt's own window is refused with no card. So is a dropdown, a context menu and devtools opened in Grunt (they belong to its WebView2 processes), a second copy of Grunt, and an app run as administrator. A window of the node server itself (its console, if one shows) counts as Grunt's.
- [ ] 20. A click on content under the indicator bar is refused, with a reason that makes sense to the model (the bar is Grunt's own window).
- [ ] 21. With Allow for this chat on an ordinary app, a `key` action of `super+r`, `ctrl+escape`, `alt+tab`, `alt+f4`, `ctrl+alt+delete` and `ctrl+a ctrl+c` (two combinations) is each refused with no card, and nothing is pressed.
- [ ] 22. Start a program by its 8.3 short path, and by a different letter case: the card shows the long, on-disk-case path both times. Junctions and subst drives resolve to the real path; a program on a share shows `\\server\share\...`.
- [ ] 23. A program on a network share and one on a USB stick: Allow once only.
- [ ] 24. A classic console window (`python.exe`, `cmd.exe` under conhost) and one in Windows Terminal: which process the card names, and that both are Allow once only.
- [ ] 25. Calculator and Settings (UWP): the card names the real program, or asks every time as `ApplicationFrameHost.exe`. The frame host is never offered for the chat.
- [ ] 26. Signers: an app with an embedded signature (Chrome, Office) has its publisher on record; Notepad and Calculator are Allow once only. A revoked certificate still counts as signed (no revocation check is made). Checking a signed exe of 150 MB or more (an Electron app, say) finishes well within the 30-second limit.
- [ ] 27. An app with no version information still works (no original name); a copy of `cmd.exe` renamed to `notes.exe` is still Allow once only.
- [ ] 28. With Allow for this chat on an app, open File > Open and click in the dialog: a new card every time. Right-click a file in it and click the menu: a new card or a refusal, never the grant. A plain app's own context menu asks every time too (any menu counts; conservative).
- [ ] 29. Approve a click in an app's main window, then open its File > Open dialog over that point before allowing: nothing is done. The same with a window that swaps in an embedded file list.
- [ ] 30. Move or close the target window while its card is up, then allow: nothing is done.
- [ ] 31. A program installed under a folder with an accented name (a user folder such as `C:\Users\José`): the card shows the warning line about unusual characters and only Allow once.
- [ ] 32. Replace an app's exe while it runs and point at it: the card shows the new file's signer and original name. Only the process start time ties the action to the run (a known residual).

### Input accuracy

- [ ] 33. Screenshots and clicks at 100 %, 125 % and 150 % display scaling: the screenshot is in physical pixels scaled to fit 1366×768, and clicks land on what the model aimed at. Tauri's event loop makes the process per-monitor DPI aware (tao 0.37.1, `become_dpi_aware`); if clicks land off by the scale factor, start there.
- [ ] 34. Click, double-click, triple-click and scroll while moving the mouse yourself, also with a second monitor to the left of the primary and at 125 % and 150 % scaling: each lands exactly on the checked point or is refused ("The mouse pointer moved away from the point that was checked, so nothing more was done."), never where you moved the pointer to.
- [ ] 35. Absolute mapping: a double-click and a triple-click on a 1-pixel target near the right and bottom edges of the virtual desktop land exactly, and the app takes them as a double and a triple click.
- [ ] 36. With "Scroll inactive windows when I hover over them" off (Settings → Bluetooth & devices → Mouse), a scroll reaches the window under the point, not Grunt.
- [ ] 37. With the mouse buttons swapped (left-handed), `left_click` is a primary click.
- [ ] 38. Double-click a point where the first click opens something over it (a menu button): the second click is not sent.
- [ ] 39. Notepad: Allow once, then `type` some text and `ctrl+s`; the Save dialog asks again as a file dialog.
- [ ] 40. Answer a card in Grunt's window, then let a `type` run: the approved window comes forward and gets the text, or the action is refused. Nothing is ever typed into Grunt.
- [ ] 41. `type` a string with an accented letter, an emoji, a line break and a tab into Notepad, with a non-English keyboard layout active: the same characters arrive and no shortcut fires. Extended keys and the punctuation keys press the expected key on that layout.
- [ ] 42. Hold Shift, then Ctrl, then the Windows key while the model clicks, types and presses a key: each is refused with "A modifier key is held; nothing was done.", and nothing is released for you. A modifier held while an elevated window is in front is still seen.
- [ ] 43. An action into an elevated window that Windows blocks part way leaves no key down (check with the on-screen keyboard).
- [ ] 44. Change the quick-chat hotkey to `Ctrl+Shift+Space`: a `key` action of `ctrl+shift+space` is refused. With the list withheld from the server (sent empty), the shell refuses it itself as its own shortcut ("Grunt never sends ctrl+shift+space: it's one of Grunt's own shortcuts. Nothing was pressed.").

### Models

- [ ] 45. One request per toolset model with computer use on (`claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-sonnet-5`, `claude-fable-5`, `claude-fable-5-1`): each is accepted. A wrong id fails every request of that profile with a 400 naming `computer_toolset_20260801`; remove it from `COMPUTER_TOOLSET_MODELS` (`packages/engine-aisdk/src/engine.ts`). `claude-sonnet-5-5` and `claude-haiku-5-5` get the JSON tool: try each with the toolset by adding it to the list, and keep it there only if it works.
- [ ] 46. A chat on a toolset model whose history has a `computer` call with a broken or non-member action (make one on a JSON-tool model, then switch the chat's profile): it replays as `invalid_computer_call` and the API accepts it. If it is refused, such a chat fails on toolset models until the profile changes.
- [ ] 47. A chat that switches between a toolset model and a JSON-tool model mid-task carries on (the same stored calls replayed both ways).
- [ ] 48. OpenAI (Responses API): the screenshot reaches the model inside the `function_call_output` as `input_image`, and the model can see it.
- [ ] 49. Gemini 3: the screenshot reaches the model inside the function response; a chat with earlier tool calls replays (Grunt keeps no thought signatures, so the SDK puts in its stand-in). A Google model before Gemini 3 gets "[image omitted: this model can't take images]" in place of each screenshot and acts blind: check it says so rather than guessing.
- [ ] 50. A tool result with no image (a refusal, a `wait`) reaches each provider as one string, with the screen-content line first.
- [ ] 51. A model whose row has no vision flag gets "[image omitted: this model can't take images]" instead of screenshots.
- [ ] 52. A Claude Code chat, clean and with a folder, can use it (relayed as `mcp__grunt_<hex>__computer`). Its screenshots reach Claude Code, but the thread shows only the text of each result (a known gap). Note any limit Claude Code puts on image results from an MCP tool.
- [ ] 53. Every screenshot result in the thread starts with the small "This is content from the computer's screen…" label, and the thread's tool-call line shows only the action ("computer: click at 512, 300"), never an app name.

### Failure modes

- [ ] 54. Kill the node server mid-`key` action, press the stop hotkey mid-typing, and quit Grunt mid-action: no modifier is left down afterwards (check with the on-screen keyboard), and the act stops at its next check.
- [ ] 55. Kill the node server: the tray tooltip and a notification say "Computer use is off until Grunt restarts.", and the tooltip stays after the web app updates its approval count. Computer use stays off until Grunt is restarted.
- [ ] 56. Quit Grunt during a session with the main window busy: it quits in about 2 seconds, the stop hotkey and bar go, and the server hears `computer.stopped` with the reason "quit" (it may be lost if an act is mid-step: shutdown waits 2 seconds, an end's settle 3). Also quit at the instant a consent OK is clicked, and while an end runs: no hang.
- [ ] 57. Stop takes effect within 4 seconds while the main window is busy (the server gives the shell 4 seconds to confirm an end); the bar may linger a moment after the banner goes. If an end is never confirmed, every start is refused until one is, or until Grunt restarts.
- [ ] 58. With a key stuck down (one the shell pressed and couldn't release), an end answers `{ ok: false }` rather than claiming a clean stop.
- [ ] 59. An act on an app run from a share that has since gone away: an end still answers in under 4 seconds, and nothing is pressed after it.
- [ ] 60. With a misbehaving low-level keyboard hook installed (one that is slow to pass keys on), an end still answers within 4 seconds.
- [ ] 61. On the laptop, a chat that runs on the PC: the PC shows the dialog, the bar and the hotkey; the laptop's Stop does not reach it (the banner and Stop are local to the machine running the turn). Stop it on the PC.
- [ ] 62. Move a chat that holds control here to run on another machine: its session here stays until Stop, idle or quit.
