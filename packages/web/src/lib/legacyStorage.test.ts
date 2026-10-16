import { beforeEach, describe, expect, it } from 'vitest';
import { adoptLegacyStorage } from './legacyStorage.js';

beforeEach(() => {
  localStorage.clear();
});

describe('adoptLegacyStorage', () => {
  it("moves Grunt's preferences to OtherBench's keys", () => {
    localStorage.setItem('grunt.textSize', '"large"');
    localStorage.setItem('grunt.sidebarWidth', '320');
    localStorage.setItem('unrelated', 'x');

    adoptLegacyStorage(localStorage);

    expect(localStorage.getItem('otherbench.textSize')).toBe('"large"');
    expect(localStorage.getItem('otherbench.sidebarWidth')).toBe('320');
    expect(localStorage.getItem('grunt.textSize')).toBeNull();
    expect(localStorage.getItem('grunt.sidebarWidth')).toBeNull();
    expect(localStorage.getItem('unrelated')).toBe('x');
  });

  it('keeps a preference already set under the new name', () => {
    localStorage.setItem('grunt.textSize', '"large"');
    localStorage.setItem('otherbench.textSize', '"small"');

    adoptLegacyStorage(localStorage);

    expect(localStorage.getItem('otherbench.textSize')).toBe('"small"');
    expect(localStorage.getItem('grunt.textSize')).toBeNull();
  });
});
