import type { OfficeKind } from '@grunt/core/domain/office-spec.js';
import { renderDocx } from './docx.js';

/**
 * Makes the real file for an Office artifact version (spec
 * 2026-10-12-office-files §4), on Download or Save to workspace only. The
 * source is parsed again: a version that arrived by sync or was stored
 * before a check existed was never checked. Any failure, a writer's own
 * included, is an OfficeRenderError, which the routes answer with a 422.
 */
export class OfficeRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfficeRenderError';
  }
}

export async function renderOfficeFile(kind: OfficeKind, content: string, title: string): Promise<Buffer> {
  try {
    switch (kind) {
      case 'document':
        return await renderDocx(content, title);
      case 'spreadsheet':
        throw new OfficeRenderError("Grunt can't make spreadsheets yet.");
    }
  } catch (err) {
    if (err instanceof OfficeRenderError) throw err;
    throw new OfficeRenderError(err instanceof Error ? err.message : String(err));
  }
}
