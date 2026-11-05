import { describe, expect, it } from 'vitest';
import {
  APP_NOTES_MIRROR_BANNER,
  appNotesMirrorText,
  appNotesPrompt,
  appNotesSections,
  editFact,
  emptyAppNotesBody,
  factFromMessage,
  hasAppNotesContent,
  moveFact,
  notesContainFact,
  parseFactPlacement,
  placeFact,
  splitNoteOffers,
  validateAppNotes,
} from '../src/domain/app-notes.js';
import { TurnPromptBuilder } from '../src/domain/turn-prompt.js';
import type { Chat } from '../src/ports/store.js';
import { InMemoryStore } from '../src/testing/fakes.js';
import type { ResolvedProfile } from '../src/types/config.js';

const NOTES = `## Build
- Run npm run build first

## VM / workers
- Builds run on worker vm-build-01

## Gotchas
`;

describe('app notes', () => {
  it('starts with the default headings and no facts', () => {
    const body = emptyAppNotesBody();
    expect(appNotesSections(body)).toEqual(['Build', 'Release', 'VM / workers', 'Gotchas']);
    expect(hasAppNotesContent(body)).toBe(false);
    expect(hasAppNotesContent(NOTES)).toBe(true);
  });

  it('adds a fact under an existing heading, matching its case', () => {
    const placed = placeFact(NOTES, 'Never run npm audit fix --force', 'gotchas');
    expect(placed.section).toBe('Gotchas');
    expect(placed.line).toBe('- Never run npm audit fix --force');
    expect(placed.replaced).toBeNull();
    expect(placed.body).toContain('## Gotchas\n- Never run npm audit fix --force\n');
  });

  it('replaces the line a fact supersedes, in its place', () => {
    const body = `## VM / workers\n- First\n- Builds run on worker vm-build-01\n- Last\n`;
    const placed = placeFact(body, 'Builds run on worker vm-build-02', 'VM / workers', '- builds run on  worker vm-build-01');
    expect(placed.replaced).toBe('- Builds run on worker vm-build-01');
    expect(placed.body).toBe('## VM / workers\n- First\n- Builds run on worker vm-build-02\n- Last\n');
  });

  it('removes a superseded line from another heading', () => {
    const placed = placeFact(NOTES, 'Builds run on worker vm-build-02', 'Build', 'Builds run on worker vm-build-01');
    expect(placed.body).not.toContain('vm-build-01');
    expect(placed.body).toContain('## Build\n- Run npm run build first\n- Builds run on worker vm-build-02');
  });

  it('makes a new heading at the end, and uses Other when given none', () => {
    expect(placeFact(NOTES, 'x', 'Signing').body.trimEnd().endsWith('## Signing\n- x')).toBe(true);
    expect(placeFact(NOTES, 'y', '  ').section).toBe('Other');
  });

  it("doesn't add a fact twice", () => {
    const placed = placeFact(NOTES, 'run npm run build  first', 'Gotchas');
    expect(placed.section).toBe('Build');
    expect(placed.added).toBe(false);
    expect(placed.body.match(/npm run build first/gi)).toHaveLength(1);
  });

  it('moves and edits a line', () => {
    const moved = moveFact(NOTES, '- Run npm run build first', 'Release');
    expect(moved).toContain('## Build\n\n## VM');
    expect(moved.trimEnd().endsWith('## Release\n- Run npm run build first')).toBe(true);
    expect(editFact(NOTES, 'Run npm run build first', 'Run npm run build:all first')).toContain('- Run npm run build:all first');
    expect(editFact(NOTES, 'missing', 'z')).toBe(NOTES);
  });

  it('knows a # message from an ordinary one', () => {
    expect(factFromMessage('# builds run on vm-build-02')).toBe('builds run on vm-build-02');
    expect(factFromMessage('#remember this')).toBe('remember this');
    expect(factFromMessage('## A heading')).toBeNull();
    expect(factFromMessage('# Title\n\nbody')).toBeNull();
    expect(factFromMessage('#')).toBeNull();
    expect(factFromMessage('plain')).toBeNull();
  });

  it('checks a fact is there and the size', () => {
    expect(notesContainFact(NOTES, 'builds run on worker VM-BUILD-01')).toBe(true);
    expect(notesContainFact(NOTES, 'nope')).toBe(false);
    expect(validateAppNotes('x'.repeat(12_001))).toMatch(/at most/);
    expect(validateAppNotes(NOTES)).toBeNull();
  });

  it('splits offers out of a reply, hiding a half-written one', () => {
    const text = 'Done.\n\n<save-note section="Build">Needs  --target x86_64</save-note>\n\nMore.\n<save-note sec';
    expect(splitNoteOffers(text)).toEqual([
      { type: 'text', text: 'Done.\n\n' },
      { type: 'offer', section: 'Build', fact: 'Needs --target x86_64' },
      { type: 'text', text: '\n\nMore.\n' },
    ]);
    expect(splitNoteOffers('<save-note>No section</save-note>')).toEqual([{ type: 'offer', section: '', fact: 'No section' }]);
  });

  it('reads a placement only when it points at real lines', () => {
    expect(parseFactPlacement('{"section":"VM / workers","replaces":"- Builds run on worker vm-build-01"}', NOTES)).toEqual({
      section: 'VM / workers',
      replaces: '- Builds run on worker vm-build-01',
    });
    expect(parseFactPlacement('Sure: {"section":"Build","replaces":"- invented"}', NOTES)).toEqual({ section: 'Build', replaces: null });
    expect(parseFactPlacement('no json', NOTES)).toBeNull();
    expect(parseFactPlacement('{"section":""}', NOTES)).toBeNull();
  });

  it('builds the prompt block and the mirror text', () => {
    expect(appNotesPrompt('OtherBench', NOTES)).toContain('vm-build-01');
    expect(appNotesPrompt('OtherBench', emptyAppNotesBody())).toContain('There are no notes yet.');
    expect(appNotesMirrorText(NOTES).startsWith(`${APP_NOTES_MIRROR_BANNER}\n\n## Build`)).toBe(true);
  });
});

describe('TurnPromptBuilder.withAppNotes', () => {
  it("adds the app's notes to an app chat's prompt only", () => {
    const store = new InMemoryStore();
    store.apps.create({ id: 'app1', name: 'OtherBench' });
    store.appNotes.save('app1', NOTES, null, 1);
    const prompts = new TurnPromptBuilder(store, () => 1, (p) => p);
    const profile = { id: 'p', systemPrompt: 'Be brief.' } as ResolvedProfile;
    const appChat = { id: 'c', appId: 'app1' } as Chat;
    expect(prompts.withAppNotes(profile, appChat).systemPrompt).toBe(`Be brief.\n\n${appNotesPrompt('OtherBench', NOTES)}`);
    expect(prompts.withAppNotes(profile, { id: 'd', appId: null } as Chat)).toBe(profile);
    expect(prompts.withAppNotes(profile, { id: 'e', appId: 'gone' } as Chat)).toBe(profile);
  });
});
