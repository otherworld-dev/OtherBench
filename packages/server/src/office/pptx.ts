import PptxGenJS from 'pptxgenjs';
import { xmlSafe, type Bullet, type PresentationSpec, type SlideColumn, type SlideSpec } from '@grunt/core/domain/office-spec.js';

/**
 * A `presentation` artifact as a .pptx (spec 2026-10-12-office-files §4):
 * 16:9 (LAYOUT_WIDE, 13.33 x 7.5 in), Calibri, one accent colour, five
 * layouts. Text boxes are set to shrink on overflow, which PowerPoint applies
 * the next time the slide is edited. pptxgenjs is only ever given text,
 * shapes and tables: never `path` media (it would read a local file or fetch
 * over https) and never hyperlinks.
 */

const FONT = 'Calibri';
const DEFAULT_ACCENT = '1F4E79';
const GREY = '595959';
const WIDE = 12.33;

type Slide = ReturnType<PptxGenJS['addSlide']>;

function bulletItems(bullets: Bullet[], fontSize: number): PptxGenJS.TextProps[] {
  return bullets.map((b, i) => ({
    text: xmlSafe(typeof b === 'string' ? b : b.text),
    options: { bullet: true, indentLevel: typeof b === 'string' ? 0 : b.level, fontSize, breakLine: i < bullets.length - 1 },
  }));
}

function columnItems(column: SlideColumn): PptxGenJS.TextProps[] {
  const heading: PptxGenJS.TextProps[] = column.heading ? [{ text: xmlSafe(column.heading), options: { bold: true, fontSize: 22, breakLine: true } }] : [];
  return [...heading, ...bulletItems(column.bullets, 18)];
}

function heading(slide: Slide, title: string, accent: string): void {
  slide.addText(xmlSafe(title), { x: 0.5, y: 0.35, w: WIDE, h: 0.9, fontFace: FONT, fontSize: 30, bold: true, color: accent, valign: 'middle', fit: 'shrink' });
}

function addSlide(pptx: PptxGenJS, s: SlideSpec, accent: string): void {
  const slide = pptx.addSlide();
  const box = { fontFace: FONT, fit: 'shrink' as const };
  if (s.layout !== 'title') slide.slideNumber = { x: 12.4, y: 6.95, w: 0.7, h: 0.35, fontFace: FONT, fontSize: 10, color: '808080' };
  switch (s.layout) {
    case 'title':
      slide.addText(xmlSafe(s.title), { ...box, x: 0.75, y: 2.2, w: 11.83, h: 1.4, fontSize: 40, bold: true, color: accent, align: 'center', valign: 'middle' });
      slide.addShape(pptx.ShapeType.rect, { x: 5.67, y: 3.75, w: 2, h: 0.06, fill: { color: accent }, line: { color: accent } });
      if (s.subtitle) slide.addText(xmlSafe(s.subtitle), { ...box, x: 0.75, y: 3.95, w: 11.83, h: 1.0, fontSize: 24, color: GREY, align: 'center', valign: 'top' });
      break;
    case 'section':
      slide.background = { color: accent };
      slide.addText(xmlSafe(s.title), { ...box, x: 0.75, y: 2.6, w: 11.83, h: 1.3, fontSize: 36, bold: true, color: 'FFFFFF', valign: 'middle' });
      if (s.subtitle) slide.addText(xmlSafe(s.subtitle), { ...box, x: 0.75, y: 3.95, w: 11.83, h: 0.9, fontSize: 20, color: 'FFFFFF', valign: 'top' });
      break;
    case 'bullets':
      heading(slide, s.title, accent);
      slide.addText(bulletItems(s.bullets, 20), { ...box, x: 0.5, y: 1.45, w: WIDE, h: 5.5, valign: 'top' });
      break;
    case 'two-column':
      heading(slide, s.title, accent);
      slide.addText(columnItems(s.left), { ...box, x: 0.5, y: 1.45, w: 6.0, h: 5.5, valign: 'top' });
      slide.addText(columnItems(s.right), { ...box, x: 6.83, y: 1.45, w: 6.0, h: 5.5, valign: 'top' });
      break;
    case 'table': {
      heading(slide, s.title, accent);
      const rows: PptxGenJS.TableRow[] = [
        s.table.header.map((h) => ({ text: xmlSafe(h), options: { bold: true, color: 'FFFFFF', fill: { color: accent } } })),
        ...s.table.rows.map((row) => row.map((c) => ({ text: xmlSafe(String(c)) }))),
      ];
      slide.addTable(rows, { x: 0.5, y: 1.45, w: WIDE, fontFace: FONT, fontSize: s.table.rows.length > 15 ? 12 : 14, border: { type: 'solid', pt: 0.5, color: 'BFBFBF' } });
      break;
    }
  }
  if (s.notes) slide.addNotes(xmlSafe(s.notes));
}

export async function renderPptx(spec: PresentationSpec, title: string): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = xmlSafe(title);
  pptx.author = 'Grunt';
  const accent = (spec.theme?.accent ?? `#${DEFAULT_ACCENT}`).slice(1).toUpperCase();
  for (const s of spec.slides) addSlide(pptx, s, accent);
  // With outputType 'nodebuffer' the union pptxgenjs declares is a Buffer.
  return (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
}
