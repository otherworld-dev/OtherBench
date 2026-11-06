# Projects

- **Data.** `project` table and `chat.project_id` (migration `007-projects`),
  both foreign keys `ON DELETE SET NULL`: deleting a project never deletes
  chats, deleting a profile clears it as a project default. Archiving a
  profile clears it too (`PATCH /profiles/:id` calls
  `clearProjectDefaultProfile`). `ProjectRepo.list()` orders by
  `sort_order`, then name (`NOCASE`), then id; `compareProjects` in
  `packages/core/src/domain/projects.ts` is the same order in JS.
- **API.** `GET/POST /api/projects`, `PATCH/DELETE /api/projects/:id` (name
  trimmed, 1-80 chars; folder validated like a chat's; default profile must
  exist and not be archived). `POST /api/chats` takes `projectId`: with no
  `workspaceRoot` key the chat gets the project's folder (an explicit `null`
  means no folder), with no `profileId` it gets the project's default, else
  the app default. `PATCH /api/chats/:id { projectId }` moves a chat without
  touching its folder or profile, and doesn't bump `updatedAt`.
- **UI.** `panes/ChatList.tsx` wires `panes/sidebar/*` (`buildSidebar`,
  `ChatRow`, `ProjectGroup`, the project editors, the mode switch, the search
  and filter chips in `useSidebarSearch` and `ChatFilters`, and the focus and
  row selectors in `focus.ts`). One `components/Menu.tsx`
  serves both the chat menu and the project menu; it opens from right-click,
  the **⋯** button, or Shift+F10 / the ContextMenu key on a focused row.
  Collapse state is per device, in `localStorage` key
  `otherbench.collapsedGroups`; whether the archived section is open is in
  `otherbench.showArchived`; each group's sort, where it differs from the default,
  is in `otherbench.groupSort` (`state/sidebarSort.ts`). "Show N more" and the
  filter chips last only for the session. Archive sets `archivedAt` and is reversible from the
  archived section (Unarchive sends `PATCH /chats/:id { "archivedAt": null }`).
  The Inspector's "Project" line links to the sidebar group.
- **Sub-projects** (spec `docs/superpowers/specs/2026-10-15-sub-projects-design.md`).
  Migration `027-project-parent` adds `project.parent_id`, deliberately
  without a foreign key so a sub-project that syncs in before its parent
  still applies; `ProjectRepo.delete` clears its sub-projects' links instead.
  One level only: `POST/PATCH /api/projects { parentId }` refuses a missing
  parent, the project itself, a parent that is a sub-project, and moving a
  project that has sub-projects. Nothing reads `parentId` directly:
  `projectParentOf` (`core/domain/projects.ts`) treats a missing, nested or
  cyclic parent as none, so a bad combination from two machines shows as top
  level until the next edit. A sub-project's chats get the parent's
  instructions, memory note (read only; the summariser writes the
  sub-project's own) and extra folders first, then its own, every turn; a
  new chat there falls back to the parent's folder and default profile. The
  sidebar nests a sub-project's group inside its parent's (count and status
  dot include it); its ⋯ menu has New sub-project… and Move under…, and the
  project page a Parent select. Elsewhere a sub-project is named
  "Parent / Child" (`projectDisplayName`).
- **Gaps.** Reordering projects sends one PATCH per project that moves, not
  one atomic call; on a failure the sidebar reloads the server's order.
  Projects and chats aren't refreshed across tabs or windows: another tab's
  changes show up only after a reload.
