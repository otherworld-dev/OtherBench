import { describe, expect, it } from 'vitest';
import { mermaidPage, mermaidScript } from '../../src/view/mermaid.js';

describe('the Mermaid page', () => {
  it('escapes the diagram source and draws it with Grunt\'s copy in strict mode', () => {
    const page = mermaidPage('graph TD; A-->B; </pre><script>alert(1)</script>');
    expect(page).toContain('&lt;/pre&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page).not.toContain('<script>alert(1)</script>');
    expect(page).toContain('<script src="mermaid.min.js"></script>');
    expect(page).toContain("securityLevel: 'strict'");
  });

  // A 5 MB file: its first read can take seconds while the whole suite runs (and the OS scans it).
  it("finds Grunt's copy of mermaid.min.js", async () => {
    const script = await mermaidScript();
    expect(script.length).toBeGreaterThan(100_000);
  }, 20_000);
});
