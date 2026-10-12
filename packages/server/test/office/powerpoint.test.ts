import { describe, expect, it } from 'vitest';
import { extractOfficeText } from '../../src/office/extract.js';
import { makeZip, type ZipFixtureEntry } from '../import/make-zip.js';

const NS =
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';
const ap = (text: string, lvl: number | string = 0) => `<a:p>${lvl ? `<a:pPr lvl="${lvl}"/>` : ''}<a:r><a:t>${text}</a:t></a:r></a:p>`;
const sp = (ph: string | null, paras: string) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ''}</p:nvPr></p:nvSpPr><p:txBody><a:bodyPr/>${paras}</p:txBody></p:sp>`;
const slideXml = (shapes: string, attrs = '') => `<p:sld ${NS}${attrs}><p:cSld><p:spTree>${shapes}</p:spTree></p:cSld></p:sld>`;
const tc = (text: string) => `<a:tc><a:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></a:txBody></a:tc>`;
const frame = (rows: string) => `<p:graphicFrame><a:graphic><a:graphicData><a:tbl>${rows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
const table = (rows: string[][]) => frame(rows.map((r) => `<a:tr>${r.map(tc).join('')}</a:tr>`).join(''));
const notesXml = (body: string) => `<p:notes ${NS}><p:cSld><p:spTree>${sp('sldImg', '')}${sp('body', body)}${sp('sldNum', ap('1'))}</p:spTree></p:cSld></p:notes>`;

/** Slides stored as slide1..N; `order` lists them as the presentation shows them (an id may repeat or have no slide). */
function pptx(slides: { xml: string; notes?: string }[], order: number[], more: ZipFixtureEntry[] = []): Buffer {
  const entries: ZipFixtureEntry[] = [
    { name: 'ppt/presentation.xml', content: `<p:presentation ${NS}><p:sldIdLst>${order.map((n, i) => `<p:sldId id="${256 + i}" r:id="rId${n}"/>`).join('')}</p:sldIdLst></p:presentation>` },
    {
      name: 'ppt/_rels/presentation.xml.rels',
      content: `<Relationships>${slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('')}</Relationships>`,
    },
    ...more,
  ];
  slides.forEach((s, i) => {
    entries.push({ name: `ppt/slides/slide${i + 1}.xml`, content: s.xml });
    if (s.notes === undefined) return;
    entries.push({
      name: `ppt/slides/_rels/slide${i + 1}.xml.rels`,
      content: `<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${i + 1}.xml"/></Relationships>`,
    });
    entries.push({ name: `ppt/notesSlides/notesSlide${i + 1}.xml`, content: notesXml(ap(s.notes)) });
  });
  return makeZip(entries);
}

describe('reading PowerPoint files', () => {
  it('reads slides in presentation order, with titles, levels, tables, notes and hidden slides, and a Fallback copy once', () => {
    const welcome = slideXml(sp('ctrTitle', ap('Welcome')) + sp('subTitle', ap('Q3')));
    const agenda = slideXml(
      sp('title', ap('Agenda')) +
        sp('body', ap('Plans') + ap('Details', 1)) +
        `<mc:AlternateContent><mc:Choice Requires="x">${sp(null, ap('Once'))}</mc:Choice><mc:Fallback>${sp(null, ap('Once'))}</mc:Fallback></mc:AlternateContent>`
    );
    const costs = slideXml(table([['Item', 'Cost'], ['Widgets', '12']]), ' show="0"');
    const text = extractOfficeText(pptx([{ xml: welcome, notes: 'Say hello' }, { xml: agenda }, { xml: costs }], [2, 1, 3]));
    expect(text).toBe(
      ['Slide 1: Agenda', 'Plans', '  Details', 'Once', '', 'Slide 2: Welcome', 'Q3', 'Notes: Say hello', '', 'Slide 3 (hidden)', '| Item | Cost |', '| --- | --- |', '| Widgets | 12 |'].join('\n')
    );
  });

  it('writes a slide with no title as "Slide N", takes only the first title placeholder, and joins its paragraphs', () => {
    const slide = slideXml(sp('title', ap('Big') + ap('Idea')) + sp('title', ap('Second title')) + sp(null, ap('Body')));
    expect(extractOfficeText(pptx([{ xml: slide }, { xml: slideXml(sp(null, ap('Only body'))) }], [1, 2]))).toBe('Slide 1: Big Idea\nSecond title\nBody\n\nSlide 2\nOnly body');
  });

  it('calls a slide hidden for show="false" too, and does not put a blank line before the first slide it can read', () => {
    const slides = [{ xml: slideXml(sp(null, ap('Gone'))) }, { xml: slideXml(sp(null, ap('Kept')), ' show="false"') }];
    // Rel 9 has no slide: it is skipped, and the slide after it keeps its position in the list.
    expect(extractOfficeText(pptx(slides, [9, 2, 1]))).toBe('Slide 2 (hidden)\nKept\n\nSlide 3\nGone');
  });

  it('reads a table cell with several paragraphs on one line and escapes pipes', () => {
    const cell = `<a:tc><a:txBody>${ap('One')}${ap('Two|Three')}</a:txBody></a:tc>`;
    const slide = slideXml(frame(`<a:tr>${cell}${tc('X')}</a:tr>`));
    expect(extractOfficeText(pptx([{ xml: slide }], [1]))).toBe('Slide 1\n| One Two\\|Three | X |\n| --- | --- |');
  });

  it('puts a table nested in a cell into that cell', () => {
    const inner = `<a:tbl><a:tr>${tc('Inner')}</a:tr></a:tbl>`;
    const slide = slideXml(frame(`<a:tr><a:tc><a:txBody>${ap('Outer')}${inner}</a:txBody></a:tc>${tc('Next')}</a:tr>`));
    expect(extractOfficeText(pptx([{ xml: slide }], [1]))).toBe('Slide 1\n| Outer Inner | Next |\n| --- | --- |');
  });

  it('reads only the notes body, and a notes part shared by two slides for each', () => {
    const more: ZipFixtureEntry[] = [
      { name: 'ppt/slides/_rels/slide1.xml.rels', content: '<Relationships><Relationship Id="a" Type="x/image" Target="../media/a.png"/><Relationship Id="b" Type="x/notesSlide" Target="../notesSlides/shared.xml"/></Relationships>' },
      { name: 'ppt/slides/_rels/slide2.xml.rels', content: '<Relationships><Relationship Id="b" Type="x/notesSlide" Target="../notesSlides/shared.xml"/></Relationships>' },
      { name: 'ppt/notesSlides/shared.xml', content: notesXml(ap('First note') + ap('Second note')) },
    ];
    const slide = slideXml(sp('title', ap('T')));
    expect(extractOfficeText(pptx([{ xml: slide }, { xml: slide }], [1, 2], more))).toBe('Slide 1: T\nNotes: First note\nSecond note\n\nSlide 2: T\nNotes: First note\nSecond note');
  });

  it('stops at the character cap and says nothing of the slides after it', () => {
    const slides = Array.from({ length: 50 }, (_, i) => ({ xml: slideXml(sp('title', ap(`Title ${i}`)) + sp(null, ap(`Paragraph ${i} `.repeat(10)))) }));
    const text = extractOfficeText(pptx(slides, slides.map((_, i) => i + 1)), { maxChars: 500 })!;
    expect(text.length).toBeLessThan(800);
    expect(text).toContain('Slide 1: Title 0');
    expect(text).not.toContain('Title 49');
  });

  it('gives null for a presentation with no slides', () => {
    expect(extractOfficeText(pptx([], []))).toBeNull();
  });

  it('notes a slide part over the part cap once, however many ids point at it', () => {
    const slide = slideXml(sp(null, ap('x'.repeat(5000))));
    const text = extractOfficeText(pptx([{ xml: slide }], Array(50).fill(1)), { maxPartBytes: 4000 });
    expect(text).toMatch(/^\[Grunt skipped ppt\/slides\/slide1\.xml: [^\]]*\]$/);
  });

  it('clamps a hostile paragraph level instead of losing the slide', () => {
    const slide = slideXml(sp(null, ap('Negative', -1) + ap('Huge', 99999999999) + ap('Infinite', '1e999') + ap('Odd', 'x') + ap('Fraction', '1.9')));
    expect(extractOfficeText(pptx([{ xml: slide }], [1]))).toBe(`Slide 1\nNegative\n${'  '.repeat(8)}Huge\n${'  '.repeat(8)}Infinite\nOdd\n  Fraction`);
  });
});

// Hostile input: linear time, and text that stops at the cap however the file is built.
describe('reading hostile PowerPoint files', () => {
  const FAST_MS = 5000;
  const CAP = 100_000;
  /** Runs `fn`, checks it was fast, and reports the time when GRUNT_TIMINGS is set. */
  function timed<T>(label: string, fn: () => T): T {
    const start = performance.now();
    const result = fn();
    const ms = performance.now() - start;
    if (process.env['GRUNT_TIMINGS']) console.log(`[timing] ${label}: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(FAST_MS);
    return result;
  }
  /** The text stays inside the cap (a stop note inside it, or one character past it for truncate() to mark). */
  const insideCap = (text: string | null, maxChars = CAP): string => {
    expect(text).not.toBeNull();
    expect(text!.length).toBeLessThanOrEqual(maxChars + 1);
    return text!;
  };

  it('reads 100 thousand slide ids that all point at one large slide with its notes', () => {
    const body = Array.from({ length: 30_000 }, (_, i) => ap(`Paragraph ${i}`)).join('');
    const file = pptx([{ xml: slideXml(sp('title', ap('Big')) + sp(null, body)), notes: 'Note' }], Array(100_000).fill(1));
    const text = insideCap(timed('100k ids, one large slide', () => extractOfficeText(file)));
    expect(text).toContain('Slide 1: Big');
  });

  it('reads that slide once: 100 thousand ids at a 3 MB slide under a total cap that allows only one read', () => {
    // Empty shapes: no text, so every id would make a "Slide N" line and the slide would be read again each time.
    const slide = slideXml('<p:sp/>'.repeat(450_000));
    const file = pptx([{ xml: slide, notes: 'Note' }], Array(100_000).fill(1));
    const text = insideCap(timed('100k ids, 3 MB slide read once', () => extractOfficeText(file, { maxTotalBytes: 8 * 1024 * 1024 })));
    expect(text).not.toContain('stopped reading here: this file');
    expect(text).toContain('Slide 1\nNotes: Note\n\nSlide 2\nNotes: Note');
  });

  it('reads thousands of slides that share one notes part, each with its own rels', () => {
    const count = 5000;
    const more: ZipFixtureEntry[] = [{ name: 'ppt/notesSlides/shared.xml', content: notesXml(ap('Shared note')) }];
    const slides = Array.from({ length: count }, (_, i) => ({ xml: slideXml(sp('title', ap(`S${i}`))) }));
    for (let i = 0; i < count; i++) {
      more.push({ name: `ppt/slides/_rels/slide${i + 1}.xml.rels`, content: '<Relationships><Relationship Id="n" Type="x/notesSlide" Target="../notesSlides/shared.xml"/></Relationships>' });
    }
    const file = pptx(slides, slides.map((_, i) => i + 1), more);
    const text = insideCap(timed('5000 slides, one notes part', () => extractOfficeText(file)));
    expect(text).toContain('Slide 1: S0\nNotes: Shared note\n\nSlide 2: S1');
  });

  it.each([
    ['one 5 MB run', ap('word '.repeat(1_000_000))],
    ['60 thousand runs in a paragraph', `<a:p>${'<a:r><a:t>word word word </a:t></a:r>'.repeat(60_000)}</a:p>`],
    ['5 MB of spaces', ap(`a${' '.repeat(5_000_000)}b`)],
  ])('cuts a multi-MB paragraph (%s) at the cap', (label, paragraph) => {
    const file = pptx([{ xml: slideXml(sp('title', ap('Head')) + sp(null, paragraph) + sp(null, ap('After'))) }], [1]);
    const text = insideCap(timed(label, () => extractOfficeText(file)));
    expect(text.startsWith('Slide 1: Head\n')).toBe(true);
    expect(text).not.toContain('After');
  });

  it('cuts a multi-MB title and a multi-MB speaker note at the cap', () => {
    const big = 'word '.repeat(1_000_000);
    const title = pptx([{ xml: slideXml(sp('title', ap(big))) }], [1]);
    expect(insideCap(timed('5 MB title', () => extractOfficeText(title))).startsWith('Slide 1: word word')).toBe(true);
    const note = pptx([{ xml: slideXml(sp(null, ap('Body'))), notes: big }], [1]);
    const text = insideCap(timed('5 MB note', () => extractOfficeText(note)));
    expect(text).toContain('Slide 1\nBody\nNotes: word word');
  });

  it.each([
    ['1 million <a:tr/>', '<a:tr/>'.repeat(1_000_000)],
    ['1 million <a:tr></a:tr>', '<a:tr></a:tr>'.repeat(1_000_000)],
    ['one row of 1 million <a:tc/>', `<a:tr>${'<a:tc/>'.repeat(1_000_000)}</a:tr>`],
    ['200 thousand one-cell rows', `<a:tr>${tc('x')}</a:tr>`.repeat(200_000)],
  ])('cuts a table of %s at the cap and never reads the slide after it', (label, rows) => {
    const file = pptx([{ xml: slideXml(frame(rows) + sp(null, ap('After'))) }], [1]);
    const text = insideCap(timed(label, () => extractOfficeText(file)));
    expect(text).not.toContain('After');
  });

  it('keeps a table of empty rows, each costing a line, inside a small cap', () => {
    const file = pptx([{ xml: slideXml(frame('<a:tr/>'.repeat(1_000_000))) }], [1]);
    const text = insideCap(timed('empty rows, small cap', () => extractOfficeText(file, { maxChars: 2000 })), 2000);
    expect(text.length).toBeGreaterThan(1900);
  });

  it('cuts one huge table cell and one huge table at the cap', () => {
    const bigCell = `<a:tr><a:tc><a:txBody>${Array.from({ length: 50_000 }, () => ap('word word')).join('')}</a:txBody></a:tc></a:tr>`;
    const cellFile = pptx([{ xml: slideXml(frame(bigCell) + sp(null, ap('After'))) }], [1]);
    const cellText = insideCap(timed('huge cell', () => extractOfficeText(cellFile, { maxChars: 1000 })), 1000);
    expect(cellText).not.toContain('After');
    const bigTable = frame(`<a:tr>${tc('word')}${tc('word')}</a:tr>`.repeat(50_000));
    const tableFile = pptx([{ xml: slideXml(bigTable + sp(null, ap('After'))) }], [1]);
    const tableText = insideCap(timed('huge table', () => extractOfficeText(tableFile, { maxChars: 1000 })), 1000);
    expect(tableText).toContain('| word | word |');
    expect(tableText).not.toContain('After');
  });

  it('reads shapes, groups and tables nested 100 thousand deep in linear time', () => {
    const depth = 100_000;
    const groups = pptx([{ xml: slideXml('<p:grpSp>'.repeat(depth) + sp(null, ap('Deep')) + '</p:grpSp>'.repeat(depth)) }], [1]);
    expect(timed('100k nested groups', () => extractOfficeText(groups))).toBe('Slide 1\nDeep');
    const shapes = pptx([{ xml: slideXml('<p:sp><p:txBody><a:p>'.repeat(depth) + '<a:r><a:t>Deep</a:t></a:r>' + '</a:p></p:txBody></p:sp>'.repeat(depth)) }], [1]);
    expect(insideCap(timed('100k nested shapes and paragraphs', () => extractOfficeText(shapes)))).toContain('Deep');
    const tables = pptx([{ xml: slideXml(`<p:graphicFrame>${'<a:tbl><a:tr><a:tc><a:txBody>'.repeat(depth)}${ap('Deep')}${'</a:txBody></a:tc></a:tr></a:tbl>'.repeat(depth)}</p:graphicFrame>`) }], [1]);
    expect(timed('100k nested tables', () => extractOfficeText(tables))).toBe('Slide 1\n| Deep |\n| --- |');
    const fallbacks = pptx([{ xml: slideXml(`<mc:AlternateContent><mc:Fallback>${'<a:x>'.repeat(depth)}${sp(null, ap('Hidden'))}${'</a:x>'.repeat(depth)}</mc:Fallback></mc:AlternateContent>${sp(null, ap('Shown'))}`) }], [1]);
    expect(timed('100k nested fallback', () => extractOfficeText(fallbacks))).toBe('Slide 1\nShown');
  });

  it('reads 300 thousand paragraphs with hostile levels, indenting at most 8 levels', () => {
    const levels = ['-5', '99999999999', '1e999', 'x', '-1e999'];
    const paragraphs = Array.from({ length: 300_000 }, (_, i) => `<a:p><a:pPr lvl="${levels[i % levels.length]}"/><a:r><a:t>t</a:t></a:r></a:p>`).join('');
    const file = pptx([{ xml: slideXml(sp(null, paragraphs)) }], [1]);
    const text = insideCap(timed('300k hostile levels', () => extractOfficeText(file)));
    expect(text).toContain(`\n${'  '.repeat(8)}t\n`);
    expect(text).not.toContain(`${'  '.repeat(9)}t`);
  });

  it('reads 300 thousand empty paragraphs and shapes in linear time', () => {
    const file = pptx([{ xml: slideXml('<p:sp/>'.repeat(300_000) + sp(null, '<a:p/>'.repeat(300_000) + ap('End'))) }], [1]);
    expect(timed('300k empty shapes and paragraphs', () => extractOfficeText(file))).toBe('Slide 1\nEnd');
  });

  it('reads thousands of slides each with a notes chain of its own', () => {
    const count = 3000;
    const slides = Array.from({ length: count }, (_, i) => ({ xml: slideXml(sp('title', ap(`S${i}`))), notes: `N${i}` }));
    const file = pptx(slides, slides.map((_, i) => i + 1));
    const text = insideCap(timed('3000 slides with notes', () => extractOfficeText(file)));
    expect(text).toContain('Slide 3000: S2999\nNotes: N2999');
  });

  it('reads a presentation whose list names 200 thousand slides that have no part', () => {
    const slides = [{ xml: slideXml(sp(null, ap('Real'))) }];
    const file = makeZip([
      { name: 'ppt/presentation.xml', content: `<p:presentation ${NS}><p:sldIdLst>${'<p:sldId id="1" r:id="nope"/>'.repeat(200_000)}<p:sldId id="2" r:id="rId1"/></p:sldIdLst></p:presentation>` },
      { name: 'ppt/_rels/presentation.xml.rels', content: '<Relationships><Relationship Id="rId1" Type="x/slide" Target="slides/slide1.xml"/></Relationships>' },
      { name: 'ppt/slides/slide1.xml', content: slides[0]!.xml },
    ]);
    expect(timed('200k ids without parts', () => extractOfficeText(file))).toBe('Slide 200001\nReal');
  });
});
