import { describe, expect, it } from 'vitest';
import { parseOpenArgs } from './openArgs.js';

describe('parseOpenArgs', () => {
  it('reads --open-folder and --send, skipping the executable and flags it doesn\'t know', () => {
    expect(parseOpenArgs(['otherbench.exe', '--minimized'])).toEqual({ openFolder: null, send: [] });
    expect(parseOpenArgs(['otherbench.exe', '--open-folder', 'E:\\Work\\App'])).toEqual({ openFolder: 'E:\\Work\\App', send: [] });
    expect(parseOpenArgs(['otherbench.exe', '--send', 'a.png', 'b c.jpg'])).toEqual({ openFolder: null, send: ['a.png', 'b c.jpg'] });
  });

  it('stops --send at the next flag, and ignores --open-folder with nothing after it', () => {
    expect(parseOpenArgs(['otherbench', '--send', 'a.png', '--minimized', 'stray'])).toEqual({ openFolder: null, send: ['a.png'] });
    expect(parseOpenArgs(['otherbench', '--open-folder'])).toEqual({ openFolder: null, send: [] });
    expect(parseOpenArgs(['otherbench', '--open-folder', '--send', 'x.png'])).toEqual({ openFolder: null, send: ['x.png'] });
  });

  it('never treats the executable itself as an argument', () => {
    expect(parseOpenArgs(['--send'])).toEqual({ openFolder: null, send: [] });
    expect(parseOpenArgs([])).toEqual({ openFolder: null, send: [] });
  });
});
