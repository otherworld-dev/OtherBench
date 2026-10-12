import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ParagraphChild,
} from 'docx';
import type { FootnoteDefinition, List, ListItem, PhrasingContent, RootContent, Table as MdTable } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { xmlSafe } from '@grunt/core/domain/office-spec.js';

/**
 * A `document` artifact's Markdown as a .docx (spec 2026-10-12-office-files
 * §4): parsed with the same mdast/GFM parser the web uses, then walked into
 * docx paragraphs. A4, 2.54 cm margins, Calibri 11 pt, Word's own Heading
 * 1-6 styles. Nothing here fetches anything: images become "[Image: alt]",
 * links are only http, https or mailto (text in the file, never followed),
 * and raw HTML is left out, as the preview leaves it out.
 */

const PAGE = { width: 11906, height: 16838 };
const MARGIN = 1440;
const FONT = 'Calibri';
const MONO = 'Consolas';
const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
const ALIGN = { left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT } as const;
const LINKABLE = /^(?:https?:|mailto:)/i;
const BULLETS = ['•', '◦', '▪'];

type Block = Paragraph | Table;

interface Style {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  code?: boolean;
  link?: boolean;
}

interface Ctx {
  quote: number;
  /** Shared by every copy of the context: each numbered list gets its own instance, so numbering restarts. */
  counter: { lists: number };
  footnotes: Map<string, number>;
  notes: FootnoteDefinition[];
}

function run(text: string, style: Style): TextRun {
  return new TextRun({
    text: xmlSafe(text),
    ...(style.bold ? { bold: true } : {}),
    ...(style.italics ? { italics: true } : {}),
    ...(style.strike ? { strike: true } : {}),
    ...(style.code ? { font: MONO } : {}),
    ...(style.link ? { style: 'Hyperlink' } : {}),
  });
}

function footnoteNumber(ctx: Ctx, id: string): number {
  let n = ctx.footnotes.get(id);
  if (n === undefined) {
    n = ctx.footnotes.size + 1;
    ctx.footnotes.set(id, n);
  }
  return n;
}

function inline(nodes: readonly PhrasingContent[], style: Style, ctx: Ctx): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out.push(run(node.value.replace(/\r?\n/g, ' '), style));
        break;
      case 'strong':
        out.push(...inline(node.children, { ...style, bold: true }, ctx));
        break;
      case 'emphasis':
        out.push(...inline(node.children, { ...style, italics: true }, ctx));
        break;
      case 'delete':
        out.push(...inline(node.children, { ...style, strike: true }, ctx));
        break;
      case 'inlineCode':
        out.push(run(node.value, { ...style, code: true }));
        break;
      case 'break':
        out.push(new TextRun({ break: 1 }));
        break;
      case 'link':
        if (LINKABLE.test(node.url)) out.push(new ExternalHyperlink({ link: xmlSafe(node.url), children: inline(node.children, { ...style, link: true }, ctx) }));
        else out.push(...inline(node.children, style, ctx));
        break;
      case 'linkReference':
        out.push(...inline(node.children, style, ctx));
        break;
      case 'image':
      case 'imageReference':
        out.push(run(`[Image: ${node.alt ?? ''}]`, { ...style, italics: true }));
        break;
      case 'footnoteReference':
        out.push(run(`[${footnoteNumber(ctx, node.identifier)}]`, style));
        break;
      default:
        // html: left out, as the preview leaves it out.
        break;
    }
  }
  return out;
}

/** A quoted paragraph: indented 1 cm a level, with a grey bar on the left. */
function quoteOptions(ctx: Ctx) {
  return ctx.quote === 0 ? {} : { indent: { left: 567 * ctx.quote }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'BFBFBF', space: 8 } } };
}

function table(node: MdTable, ctx: Ctx): Table {
  const width = node.children.reduce((w, row) => Math.max(w, row.children.length), 1);
  const rows = node.children.map(
    (row, r) =>
      new TableRow({
        tableHeader: r === 0,
        children: Array.from({ length: width }, (_, i) => {
          const cell = row.children[i];
          return new TableCell({
            children: [new Paragraph({ alignment: ALIGN[node.align?.[i] ?? 'left'], children: cell ? inline(cell.children, r === 0 ? { bold: true } : {}, ctx) : [] })],
          });
        }),
      })
  );
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows });
}

function list(node: List, level: number, ctx: Ctx): Block[] {
  const numbered = node.ordered === true;
  const instance = numbered ? ++ctx.counter.lists : 0;
  return node.children.flatMap((item) => listItem(item, numbered, instance, Math.min(level, 8), ctx));
}

function listItem(item: ListItem, numbered: boolean, instance: number, level: number, ctx: Ctx): Block[] {
  const numbering = numbered ? { reference: 'grunt-numbers', level, instance } : { reference: 'grunt-bullets', level };
  const check = item.checked === true ? [run('☒ ', {})] : item.checked === false ? [run('☐ ', {})] : [];
  const out: Block[] = [];
  let first = true;
  for (const child of item.children) {
    if (child.type === 'list') {
      out.push(...list(child, level + 1, ctx));
      continue;
    }
    if (first) {
      first = false;
      out.push(new Paragraph({ numbering, children: [...check, ...(child.type === 'paragraph' ? inline(child.children, {}, ctx) : [])] }));
      if (child.type !== 'paragraph') out.push(...blocks([child], ctx));
      continue;
    }
    out.push(...blocks([child], ctx));
  }
  if (first) out.push(new Paragraph({ numbering, children: check }));
  return out;
}

function blocks(nodes: readonly RootContent[], ctx: Ctx): Block[] {
  const out: Block[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'heading':
        out.push(new Paragraph({ heading: HEADINGS[Math.min(node.depth, 6) - 1], children: inline(node.children, {}, ctx) }));
        break;
      case 'paragraph':
        out.push(new Paragraph({ ...quoteOptions(ctx), children: inline(node.children, {}, ctx) }));
        break;
      case 'blockquote':
        out.push(...blocks(node.children, { ...ctx, quote: ctx.quote + 1 }));
        break;
      case 'list':
        out.push(...list(node, 0, ctx));
        break;
      case 'code':
        for (const line of node.value.split(/\r?\n/)) {
          out.push(new Paragraph({ ...quoteOptions(ctx), shading: { type: ShadingType.CLEAR, fill: 'F2F2F2', color: 'auto' }, spacing: { before: 0, after: 0 }, children: [run(line === '' ? ' ' : line, { code: true })] }));
        }
        break;
      case 'table':
        out.push(table(node, ctx));
        break;
      case 'thematicBreak':
        out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'auto', space: 1 } }, children: [] }));
        break;
      case 'footnoteDefinition':
        footnoteNumber(ctx, node.identifier);
        ctx.notes.push(node);
        break;
      default:
        // html, definition, yaml: not in the file.
        break;
    }
  }
  return out;
}

function numberingConfig(reference: string, bullets: boolean) {
  return {
    reference,
    levels: Array.from({ length: 9 }, (_, level) => ({
      level,
      format: bullets ? LevelFormat.BULLET : LevelFormat.DECIMAL,
      text: bullets ? BULLETS[level % BULLETS.length]! : `%${level + 1}.`,
      alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
    })),
  };
}

export async function renderDocx(markdown: string, title: string): Promise<Buffer> {
  const tree = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const ctx: Ctx = { quote: 0, counter: { lists: 0 }, footnotes: new Map(), notes: [] };
  const children = blocks(tree.children, ctx);
  // Footnotes as "[n] text" paragraphs at the end.
  for (const note of ctx.notes) {
    const [first, ...rest] = note.children;
    const lead = first?.type === 'paragraph' ? inline(first.children, {}, ctx) : [];
    children.push(new Paragraph({ children: [run(`[${footnoteNumber(ctx, note.identifier)}] `, {}), ...lead] }));
    children.push(...blocks(first?.type === 'paragraph' ? rest : note.children, ctx));
  }
  const doc = new Document({
    creator: 'Grunt',
    title: xmlSafe(title),
    styles: { default: { document: { run: { font: FONT, size: 22 } } } },
    numbering: { config: [numberingConfig('grunt-bullets', true), numberingConfig('grunt-numbers', false)] },
    sections: [
      {
        properties: { page: { size: PAGE, margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN } } },
        children: children.length > 0 ? children : [new Paragraph({})],
      },
    ],
  });
  return Packer.toBuffer(doc);
}
