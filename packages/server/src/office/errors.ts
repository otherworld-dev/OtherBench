/**
 * Any failure to make an Office file, a writer's own included: the routes
 * answer it with a 422. Kept in its own module so the renderers (docx.ts,
 * xlsx.ts) can throw it without importing render.ts, which imports them.
 */
export class OfficeRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfficeRenderError';
  }
}
