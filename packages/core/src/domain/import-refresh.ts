import type { MessageOutline } from '../ports/store.js';
import type { CanonMessage } from '../types/messages.js';

/**
 * What a re-import adds to a chat already here (claude.ai's, and Cowork's,
 * which share the import job). The source keeps its own ids as OtherBench's,
 * so the messages a chat lacks are the source's ids it doesn't hold: text is
 * never compared. Pure: the server reads the chat's outline and writes the
 * result.
 */

/**
 * How new messages go into a chat. `append`: the chat holds nothing but the
 * source's messages, so they go on as the source has them and the chat opens
 * on the source's branch. `branch`: the chat was carried on here (it holds
 * messages the source doesn't have), so those stay as they are and where the
 * chat opens; the source's new messages hang off the same parents they have
 * in the source, which makes them a branch beside the user's to switch to.
 */
export type NewMessagesMode = 'append' | 'branch';

export interface NewMessages {
  /** The source's messages the chat lacks, parents first, ready to write. */
  add: CanonMessage[];
  /** How they go in (or would, for those that can't be placed); null when the chat lacks nothing. */
  mode: NewMessagesMode | null;
  /**
   * The source's messages the chat lacks that can't go in, counted with every
   * message below them: the parent isn't in the chat or the source, the id is
   * already another chat's, or the message would sit beside one of the chat's
   * own of another role (a reply beside a prompt), which no branch switcher
   * shows.
   */
  unplaced: number;
}

/**
 * The source's messages a chat lacks, and how they go in. `source` is the
 * source's whole chat; `here` is the chat as it is (`MessageRepo.outline`).
 * `takenElsewhere` says whether an id the chat lacks is already a message in
 * another chat.
 *
 * A reply added beside replies already here is marked regenerated, so the
 * set is browsed with the branch switcher and never mistaken for a compare
 * turn (`isCompareSet`).
 */
export function planNewMessages(source: CanonMessage[], here: MessageOutline[], takenElsewhere: (id: string) => boolean = () => false): NewMessages {
  const held = new Set(here.map((m) => m.id));
  const missing = source.filter((m) => !held.has(m.id));
  if (missing.length === 0) return { add: [], mode: null, unplaced: 0 };

  const fromSource = new Set(source.map((m) => m.id));
  const own = new Set(here.filter((m) => !fromSource.has(m.id)).map((m) => m.id));
  const childrenHere = new Map<string | null, MessageOutline[]>();
  for (const m of here) childrenHere.set(m.parentId, [...(childrenHere.get(m.parentId) ?? []), m]);

  // Parents before children, whatever order the source listed them in; a message whose parent never goes in stays out.
  const add: CanonMessage[] = [];
  const placed = new Set<string>();
  const refused = new Set<string>();
  let rest = missing;
  for (;;) {
    const ready = rest.filter((m) => m.parentId === null || held.has(m.parentId) || placed.has(m.parentId));
    if (ready.length === 0) break;
    for (const m of ready) {
      const beside = childrenHere.get(m.parentId) ?? [];
      if (takenElsewhere(m.id) || beside.some((s) => own.has(s.id) && s.role !== m.role)) {
        refused.add(m.id);
        continue;
      }
      const regenerate = m.role === 'assistant' && m.producedBy !== null && !m.producedBy.regenerated && beside.some((s) => s.role === 'assistant');
      add.push(regenerate ? { ...m, producedBy: { ...m.producedBy!, regenerated: true } } : m);
      placed.add(m.id);
    }
    rest = rest.filter((m) => !placed.has(m.id) && !refused.has(m.id));
  }
  return { add, mode: own.size > 0 ? 'branch' : 'append', unplaced: missing.length - add.length };
}
