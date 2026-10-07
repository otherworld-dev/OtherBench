import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The page a Mermaid artifact is drawn in (Deck #896), inside the viewer's sandbox: its source escaped, Grunt's copy of Mermaid, strict mode. */
export function mermaidPage(source: string): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:16px;background:#fff;font-family:sans-serif}</style></head><body>' +
    `<pre class="mermaid">${escapeHtml(source)}</pre>` +
    '<script src="mermaid.min.js"></script>' +
    "<script>mermaid.initialize({ startOnLoad: true, securityLevel: 'strict' });</script>" +
    '</body></html>'
  );
}

let cached: Buffer | null = null;

/** Grunt's copy of mermaid.min.js: beside the bundled server (`assets/`), else from the mermaid package. */
export async function mermaidScript(): Promise<Buffer> {
  if (cached) return cached;
  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = [join(here, 'assets', 'mermaid.min.js'), join(here, '..', 'assets', 'mermaid.min.js')].find((p) => existsSync(p));
  const path = bundled ?? createRequire(import.meta.url).resolve('mermaid/dist/mermaid.min.js');
  cached = await readFile(path);
  return cached;
}
