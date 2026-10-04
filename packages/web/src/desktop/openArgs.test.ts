import { describe, expect, it } from 'vitest';
import { parseOpenArgs } from './openArgs.js';

describe('parseOpenArgs', () => {
  it('reads --open-folder and --send, skipping the executable and flags it doesn\'t know', () => {
    expect(parseOpenArgs(['grunt.exe', '--minimized'])).toEqual({ openFolder: null, send: [] });
    expect(parseOpenArgs(['grunt.exe', '--open-folder', 'E:\\Work\\App'])).toEqual({ openFolder: 'E:\\Work\\App', send: [] });
    expect(parseOpenArgs(['grunt.exe', '--send', 'a.png', 'b c.jpg'])).toEqual({ openFolder: null, send: ['a.png', 'b c.jpg'] });
  });

  it('stops --send at the next flag, and ignores --open-folder with nothing after it', () => {
    expect(parseOpenArgs(['grunt', '--send', 'a.png', '--minimized', 'stray'])).toEqual({ openFolder: null, send: ['a.png'] });
    expect(parseOpenArgs(['grunt', '--open-folder'])).toEqual({ openFolder: null, send: [] });
    expect(parseOpenArgs(['grunt', '--open-folder', '--send', 'x.png'])).toEqual({ openFolder: null, send: ['x.png'] });
  });

  it('never treats the executable itself as an argument', () => {
    expect(parseOpenArgs(['--send'])).toEqual({ openFolder: null, send: [] });
    expect(parseOpenArgs([])).toEqual({ openFolder: null, send: [] });
  });
});
