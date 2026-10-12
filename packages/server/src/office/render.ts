import { checkOfficeContent, type OfficeKind } from '@grunt/core/domain/office-spec.js';
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
      case 'document': {
        // Bounded before parsing: a synced version was never checked, and the parser's work grows fast with tables and nesting.
        const problem = checkOfficeContent('document', content);
        if (problem) throw new OfficeRenderError(problem);
        return await renderDocx(content, title);
      }
      case 'spreadsheet':
        throw new OfficeRenderError("Grunt can't make spreadsheets yet.");
      default: {
        const never: never = kind;
        throw new OfficeRenderError(`Grunt can't make a ${String(never)} file.`);
      }
    }
  } catch (err) {
    if (err instanceof OfficeRenderError) throw err;
    throw new OfficeRenderError(err instanceof Error ? err.message : String(err));
  }
}
