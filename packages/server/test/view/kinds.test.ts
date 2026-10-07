import { describe, expect, it } from 'vitest';
import { extensionOf, kindByName, servedType } from '../../src/view/kinds.js';

describe('view kinds', () => {
  it('reads the extension of the last segment, lower-cased, with either separator', () => {
    expect(extensionOf('C:\\Work\\Report.PDF')).toBe('pdf');
    expect(extensionOf('/home/a/b.tar.gz')).toBe('gz');
    expect(extensionOf('notes')).toBe('');
    expect(extensionOf('.gitignore')).toBe('');
  });

  it('serves only listed types, with the type from the list', () => {
    expect(servedType('a.png')).toEqual({ kind: 'image', mime: 'image/png' });
    expect(servedType('A.SVG')).toEqual({ kind: 'image', mime: 'image/svg+xml' });
    expect(servedType('clip.mp4')).toEqual({ kind: 'video', mime: 'video/mp4' });
    expect(servedType('doc.pdf')).toEqual({ kind: 'pdf', mime: 'application/pdf' });
    expect(servedType('index.html')).toEqual({ kind: 'html', mime: 'text/html; charset=utf-8' });
    expect(servedType('site.css')).toEqual({ kind: 'asset', mime: 'text/css; charset=utf-8' });
    for (const name of ['tool.exe', 'run.bat', 'notes.md', 'x', 'x.constructor', 'x.__proto__', 'x.toString']) expect(servedType(name)).toBeNull();
  });

  it('names the kind when the name decides it, and leaves text or other to the bytes', () => {
    expect(kindByName('README.md')).toBe('markdown');
    expect(kindByName('a.markdown')).toBe('markdown');
    expect(kindByName('page.htm')).toBe('html');
    expect(kindByName('pic.webp')).toBe('image');
    expect(kindByName('style.css')).toBeNull();
    expect(kindByName('main.ts')).toBeNull();
  });
});
