import { DEFAULT_COLLECTIVE, type ProjectLinks } from '../types/nextcloud.js';

/** The lines under the first "Project links" heading, up to the next heading of the same or higher level. */
function projectLinksLines(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,6}\s*project links\s*$/i.test(l));
  if (start < 0) return [];
  const level = /^#+/.exec(lines[start]!)![0].length;
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const h = /^(#{1,6})\s/.exec(line);
    if (h && h[1]!.length <= level) break;
    out.push(line);
  }
  return out;
}

function backticked(line: string): string[] {
  return [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.trim());
}

function afterColon(line: string): string {
  return line.slice(line.indexOf(':') + 1).trim();
}

/**
 * Reads the Deck board, wiki page and bookmark tag from the "Project links"
 * section of a CLAUDE.md. Only that section is read; the first line carrying
 * a label wins. Anything it can't find comes back null.
 */
export function parseProjectLinks(markdown: string): ProjectLinks {
  const links: ProjectLinks = { deckBoard: null, collective: null, pagePath: null, bookmarkTag: null };
  let sawBoard = false;
  let sawCollective = false;
  let sawTag = false;
  for (const raw of projectLinksLines(markdown)) {
    const line = raw.replace(/\*\*/g, '');
    if (!sawBoard && /deck board\s*:/i.test(line)) {
      sawBoard = true;
      const value = backticked(line)[0] ?? afterColon(line).split(/ \(|;| —/)[0]!.trim();
      links.deckBoard = value || null;
    } else if (!sawCollective && /collectives\s*:/i.test(line)) {
      sawCollective = true;
      const ticks = backticked(line);
      const slashed = ticks.find((t) => t.includes('/'));
      const path = (slashed ?? /Products\/[^`(;,]+/.exec(line)?.[0] ?? '').trim().replace(/\/+$/, '');
      if (path) {
        links.pagePath = path;
        links.collective = ticks.find((t) => !t.includes('/')) ?? DEFAULT_COLLECTIVE;
      }
    } else if (!sawTag && /bookmark tag\s*:/i.test(line)) {
      sawTag = true;
      links.bookmarkTag = (backticked(line)[0] ?? afterColon(line)) || null;
    }
  }
  return links;
}
