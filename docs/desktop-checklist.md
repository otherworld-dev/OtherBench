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
