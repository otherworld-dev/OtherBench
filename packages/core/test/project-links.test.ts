import { describe, expect, it } from 'vitest';
import { parseProjectLinks } from '../src/domain/project-links.js';

const section = (...lines: string[]) => `# X\n\n## Project links\n\n${lines.join('\n')}\n\n## Other\n- Deck board: \`Wrong\`\n`;

describe('parseProjectLinks', () => {
  it.each([
    ['- Deck board: `OtherBench` (columns `Backlog`, `To Do`, `Doing`)', 'OtherBench'],
    ['- **Deck board:** `Glados MCP` (Backlog / To Do / Doing / Done)', 'Glados MCP'],
    ['- Deck board: **BriefCycle**', 'BriefCycle'],
    ['- **Deck board:** ClaudeSync', 'ClaudeSync'],
  ])('reads the board from %s', (line, board) => expect(parseProjectLinks(section(line)).deckBoard).toBe(board));

  it.each([
    ['- Collectives: `Products/OtherBench` in `Otherworld Dev`; v1 plan and design spec under `Products/OtherBench/Design/` (dated page names keep `grunt`)', 'Otherworld Dev', 'Products/OtherBench'],
    ['- Collectives: `Otherworld Dev` → `Products/ClaudeImageEditor`', 'Otherworld Dev', 'Products/ClaudeImageEditor'],
    ['- Collectives: `Products/BriefCycle` (collective `Otherworld Dev`); SSO', 'Otherworld Dev', 'Products/BriefCycle'],
    ['- **Collectives:** `Products/ClaudeSync` in `Otherworld Dev`', 'Otherworld Dev', 'Products/ClaudeSync'],
    ['- Collectives: `Products/Budget` (Otherworld Dev)', 'Otherworld Dev', 'Products/Budget'],
  ])('reads the page from %s', (line, collective, pagePath) =>
    expect(parseProjectLinks(section(line))).toMatchObject({ collective, pagePath }));

  it('reads the bookmark tag', () => expect(parseProjectLinks(section('- Bookmark tag: `otherbench`')).bookmarkTag).toBe('otherbench'));
  it('only reads the Project links section', () => expect(parseProjectLinks('## Other\n- Deck board: `Wrong`\n')).toEqual({ deckBoard: null, collective: null, pagePath: null, bookmarkTag: null }));
  it('ignores a line that is not a Deck board line', () => expect(parseProjectLinks(section('- Task board: Nextcloud **Deck → "Nimbo"**')).deckBoard).toBeNull());
  it('has no collective without a page path', () => expect(parseProjectLinks(section('- Deck board: `A`'))).toMatchObject({ collective: null, pagePath: null }));
  it('lets the first line with a label win', () => expect(parseProjectLinks(section('- Deck board: `A`', '- Deck board: `B`')).deckBoard).toBe('A'));
});
