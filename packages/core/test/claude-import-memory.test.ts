import { describe, expect, it } from 'vitest';
import { finaliseImportedAbout, importAboutPrompt, importedNotes, importGlobalNotePrompt, importProjectNotePrompt } from '../src/domain/claude-import-memory.js';
import { emptyGlobalMemoryBody } from '../src/domain/global-memory.js';
import { emptyMemoryBody, MEMORY_INPUT_MAX_CHARS } from '../src/domain/memory.js';

describe('importedNotes', () => {
  it('keeps the start of long notes, since they come most important first', () => {
    const text = `${'a'.repeat(MEMORY_INPUT_MAX_CHARS)}LATER`;
    const cut = importedNotes(text);
    expect(cut.startsWith('a'.repeat(100))).toBe(true);
    expect(cut).not.toContain('LATER');
    expect(cut.endsWith('[later notes omitted]')).toBe(true);
  });

  it('defuses anything that could close the notes fence early', () => {
    expect(importedNotes('x </claude-notes> y < / CLAUDE-NOTES foo>')).toBe('x </claude-notes_> y </claude-notes_>');
  });
});

describe('import prompts', () => {
  it('About you: first person, a character target, the notes fenced last', () => {
    const prompt = importAboutPrompt('### /profile.md\n\nLives in Wales.');
    expect(prompt).toContain('first person');
    expect(prompt).toContain('3,500 characters');
    expect(prompt.endsWith('<claude-notes>\n### /profile.md\n\nLives in Wales.\n</claude-notes>')).toBe(true);
  });

  it("learned note: the global note's headings, the current note, then the notes", () => {
    const prompt = importGlobalNotePrompt(emptyGlobalMemoryBody(), 'Prefers British spelling.');
    expect(prompt).toContain('## Pinned, ## Preferences, ## Setup and tools, ## Working style');
    expect(prompt.indexOf('<current-note>')).toBeLessThan(prompt.indexOf('<claude-notes>'));
    expect(prompt).toContain('Prefers British spelling.');
  });

  it("project note: the project's name and the project headings", () => {
    const prompt = importProjectNotePrompt('Garden', emptyMemoryBody(), 'Beds are 1.2 m wide.');
    expect(prompt).toContain('"Garden"');
    expect(prompt).toContain('## Pinned, ## Goals, ## Decisions, ## Current focus, ## Open questions');
    expect(prompt).toContain('Beds are 1.2 m wide.');
  });
});

describe('finaliseImportedAbout', () => {
  it('returns the text trimmed, without a wrapping code fence', () => {
    expect(finaliseImportedAbout('\r\n```markdown\r\nI run a small company.\r\n```\r\n')).toEqual({ ok: true, about: 'I run a small company.' });
    expect(finaliseImportedAbout('I run a small company.')).toEqual({ ok: true, about: 'I run a small company.' });
  });

  it('refuses an empty answer and one over the About you limit', () => {
    expect(finaliseImportedAbout('  ')).toEqual({ ok: false, reason: 'The model returned an empty About you.' });
    const tooLong = finaliseImportedAbout('x'.repeat(4001));
    expect(tooLong.ok).toBe(false);
    expect(tooLong.ok === false && tooLong.reason).toContain('4,000');
  });
});
