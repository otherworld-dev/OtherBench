# Add-ons

An add-on is a piece of code that runs inside OtherBench's server on one machine, for something that belongs to that machine's owner rather than to OtherBench itself (a link to a private service, for example). OtherBench ships no add-ons, and on a machine with none installed nothing about them shows: there is no Add-ons tab, and `GET /api/addons` is an empty list.

## Installing one

An add-on is a folder, `<data dir>/addons/<id>/`, beside the database (in the desktop app, the same folder as `otherbench.db`). Copy the add-on's built files there on the machine it should run on, then restart OtherBench. Nothing in OtherBench installs, removes, switches on or uploads an add-on: there is no route or setting for it, so another machine, a web page or a model can't add one. Removing the folder and restarting removes it. Its data lives apart, in `<data dir>/addon-data/<id>/`, so reinstalling never wipes it.

The folder holds `addon.json`:

| Field | |
|------|---|
| `id` | Lower case letters, digits and dashes, 2 to 32 long, starting with a letter; the same as the folder's name. |
| `name`, `version` | What Settings → Add-ons shows. |
| `apiVersion` | The host API it was built for. This OtherBench offers version 1 (`ADDON_API_VERSION`); any other isn't loaded. |
| `main` | Its ES module, relative to the folder and inside it. |
| `settingsPage` | Optional: a folder of static files with an `index.html`, inside the add-on's folder. It must be a folder of its own, not the add-on's folder itself and not one holding `main`, since everything in it is served without sign-in. |
| `branchPrefix` | Optional: the first part of every job branch its jobs make. Defaults to the id. It can't be `job` (OtherBench's own) or one an add-on earlier in name order has, whether as its id or its `branchPrefix`; such an add-on isn't loaded. |

## Loading

At start-up, after everything else in the container is built, the server reads each folder in `addons` named like an id, in name order (`server/src/addons/loader.ts`). For each it checks the manifest (`manifest.ts`: the id is the folder's name, `main` and `settingsPage` resolve inside the folder through `containPath`, so no `..`, absolute path or link out), imports `main` and calls its `activate(host)`, each with a 10 second limit (a top-level await in `main` that never settles counts as a failed load). An add-on that can't be read, imported or given its host, or doesn't start, is listed as failed with the reason, its routes aren't served, and the rest still load: an add-on never stops the server starting. When `activate` throws or runs out of time, the add-on's `dispose` is called (under the same limit) so it can stop what it set going, and then its host is cut off (`stoppable.ts`): anything it reads from the host, or calls that it got from it earlier, throws from then on. On shutdown each loaded add-on's `dispose` is called, each with 5 seconds, before the database and everything else close, so a dispose can still save its state through the host. In the desktop app the main window shows a notification, once per start, for each add-on that didn't load.

## The host

`activate` is given an `AddonHost` (`@otherbench/addon-api`, `packages/addon-api`, the types an add-on builds against; `server/src/addons/host.ts` makes it). It is everything the add-on gets from OtherBench:

- `dataFolder`, its own folder for its data, and `log`.
- `secrets`: this machine's secret store, under `addon:<id>:<key>` only. A key is letters, digits, `_` and `-`, so it can't reach another add-on's secrets or OtherBench's own.
- `apps()` (each with its folder on this machine), `profiles()` (live ones), `defaultProfileId()` and `machineName()`.
- `jobs`: OtherBench's `JobRunner`. Every chat an add-on makes this way is a job chat, so it runs under the job rules (docs/features/jobs.md) whatever the add-on does, and commands run through it have their network fixed by OtherBench.
- `git`: job-folder git with the add-on's own branch prefix, so its pushes can only ever create `<prefix>/<job id>`.
- `routes(app)`: anything with `fetch(Request)` (a Hono app of its own, say), called once. Requests to `/api/addons/<id>/...` go to it with that prefix taken off, behind the same sign-in as the rest of the API. They are forwarded rather than mounted, so an add-on can bundle whatever Hono version it likes.
- `atThisMachine(c)`: whether a request came from this machine (the desktop app's token, or a server that takes no sign-ins); an add-on uses it to let its settings change only here.
- `notify()`: emits `{ type: 'addon-changed', id }` to every open window.
- `fetch` and `lookup`, so its network calls can be faked in tests.

An add-on runs in the server's own process with full access to Node, so it is trusted the way OtherBench itself is: it is code its owner installed by hand on their own machine. The host is about keeping what it reaches through OtherBench tidy and separate (its own secrets and data, job chats only under the job rules, its own branch prefix), not about containing hostile code.

## Settings → Add-ons

The tab (`web/src/views/settings/AddonsPanel.tsx`) appears after Sandbox when `GET /api/addons` lists at least one add-on, loaded or failed. A failed one shows why. A loaded one with a settings page shows it in a frame from `/addons/<id>/` (`server/src/addons/routes.ts`), served:

- only from the checked page folder, with no `..` and no link out, and only as HTML, JavaScript, CSS, SVG, PNG or WOFF2 (anything else is a 404);
- with `X-Content-Type-Options: nosniff` and a policy of `default-src 'self'; script-src 'self'`, and `frame-ancestors` that allows only this server and the desktop app's own origins (everything else OtherBench serves keeps `frame-ancestors 'none'`);
- without sign-in, like the main UI's own files. The page's calls to its API need the usual sign-in.

The frame has `sandbox="allow-scripts allow-same-origin allow-forms"`, so it can't navigate the app or open windows. That holds the page back only where it is served from another origin than the app, as in the desktop app. In a browser the app and the page both come from the server, so with `allow-same-origin` the page can reach the app's own window (`window.parent`) and do anything the app can. This is left as it is because the page is the add-on's own code, which already runs in the server with full access, and `allow-same-origin` is what lets the page call its API with the browser's sign-in cookie. The page and the app talk by `postMessage`:

| From | Message | |
|------|---------|---|
| page | `{ type: 'otherbench-addon-ready' }` | Asks for the host details. Answered only when it comes from that frame and the server's origin. |
| app | `{ type: 'otherbench-host', apiBase, token, theme }` | The API's address, the desktop app's per-launch token (null in a browser, which signs in with a cookie) and the app's colour and font tokens. Sent only to the server's origin. |
| app | `{ type: 'otherbench-changed' }` | Its add-on called `notify()`: re-read. |
| page | `{ type: 'otherbench-open-chat', chatId }` | Opens that chat, closing Settings. |

## Tests

Server `test/addons/` (`loader`: manifests, failures, the time limit, dispose; `host`: secrets kept apart, branch prefix, routes once, notify; `routes`: the list, forwarded routes, no install route, page serving and its refusals; `container-addons`: a real container loading an add-on beside its database). Web `AddonsPanel.test.tsx` (the handshake and its origin checks), `SettingsView.test.tsx` (the tab) and `state/addons.test.tsx` (the notification).
