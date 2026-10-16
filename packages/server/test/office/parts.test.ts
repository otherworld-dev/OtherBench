import { describe, expect, it } from 'vitest';
import { markdownTable, OFFICE_LIMITS, OfficeParts, resolvePart, TextOut } from '../../src/office/parts.js';
import { makeZip } from '../import/make-zip.js';

describe('OfficeParts', () => {
  it('reads a part whatever the case of its name', () => {
    const parts = new OfficeParts(makeZip([{ name: 'xl/worksheets/Sheet1.xml', content: '<x/>' }]), OFFICE_LIMITS);
    expect(parts.has('xl/worksheets/sheet1.xml')).toBe(true);
    expect(parts.text('xl/worksheets/sheet1.xml')).toBe('<x/>');
    expect(parts.text('missing.xml')).toBeNull();
  });

  it('skips a part over the per-part cap with a note', () => {
    const parts = new OfficeParts(makeZip([{ name: 'word/document.xml', content: 'x'.repeat(2000) }]), { ...OFFICE_LIMITS, maxPartBytes: 1000 });
    expect(parts.text('word/document.xml')).toBeNull();
    expect(parts.notes[0]).toMatch(/^\[OtherBench skipped word\/document\.xml:/);
  });

  it('stops reading once the parts come to more than the total cap', () => {
    const parts = new OfficeParts(
      makeZip([{ name: 'a.xml', content: 'a'.repeat(600) }, { name: 'b.xml', content: 'b'.repeat(600) }]),
      { ...OFFICE_LIMITS, maxTotalBytes: 1000 }
    );
    expect(parts.text('a.xml')).toHaveLength(600);
    expect(parts.text('b.xml')).toBeNull();
    expect(parts.stopped).toBe(true);
    expect(parts.notes[0]).toMatch(/stopped reading/);
  });

  it('inflates a part once however often and in whatever case it is asked for', () => {
    const parts = new OfficeParts(makeZip([{ name: 'A.xml', content: 'a'.repeat(600) }]), OFFICE_LIMITS);
    const first = parts.text('a.xml');
    expect(first).toHaveLength(600);
    // The same string back, not a new inflation of the part.
    for (const name of ['a.xml', 'A.XML', 'A.xml', 'a.xMl']) expect(parts.text(name)).toBe(first);
    expect(parts.notes).toEqual([]);
  });

  it('charges a cached part to the total on every call, so repeated reads still reach the cap and stop', () => {
    const parts = new OfficeParts(makeZip([{ name: 'a.xml', content: 'a'.repeat(300) }, { name: 'b.xml', content: 'b' }]), { ...OFFICE_LIMITS, maxTotalBytes: 1000 });
    // 300 x 3 = 900 fits; the fourth read would come to 1200.
    for (let i = 0; i < 3; i++) expect(parts.text(i % 2 ? 'A.XML' : 'a.xml')).toHaveLength(300);
    expect(parts.stopped).toBe(false);
    expect(parts.text('a.xml')).toBeNull();
    expect(parts.stopped).toBe(true);
    expect(parts.notes).toHaveLength(1);
    expect(parts.notes[0]).toMatch(/stopped reading/);
    // Once stopped, even a part not read before is refused.
    expect(parts.text('b.xml')).toBeNull();
  });

  it('notes an over-cap part once, however often and in whatever case it is asked for', () => {
    const parts = new OfficeParts(makeZip([{ name: 'word/Document.xml', content: 'x'.repeat(2000) }]), { ...OFFICE_LIMITS, maxPartBytes: 1000 });
    for (const name of ['word/document.xml', 'WORD/DOCUMENT.XML', 'word/Document.xml', 'word/document.xml']) expect(parts.text(name)).toBeNull();
    expect(parts.notes).toHaveLength(1);
    expect(parts.notes[0]).toMatch(/^\[OtherBench skipped word\/Document\.xml:/);
  });

  it('keeps ten distinct notes and counts the rest, each note cut to a bounded length', () => {
    const parts = new OfficeParts(
      makeZip([
        ...Array.from({ length: 40 }, (_, i) => ({ name: `part${i}.xml`, content: 'x'.repeat(2000) })),
        { name: `${'long/'.repeat(1000)}name.xml`, content: 'x'.repeat(2000) },
      ]),
      { ...OFFICE_LIMITS, maxPartBytes: 1000 }
    );
    for (let i = 0; i < 40; i++) parts.text(`part${i}.xml`);
    parts.text(`${'long/'.repeat(1000)}name.xml`);
    const notes = parts.notes;
    expect(notes).toHaveLength(11);
    expect(notes[10]).toBe('[OtherBench skipped 31 more parts as well.]');
    expect(notes.every((n) => n.length <= 310)).toBe(true);
  });

  it("resolves a part's relationships, relative and absolute, leaving out external ones", () => {
    const rels = `<Relationships xmlns="x">
      <Relationship Id="rId1" Type="http://x/worksheet" Target="worksheets/sheet1.xml"/>
      <Relationship Id="rId2" Type="http://x/worksheet" Target="/xl/worksheets/sheet2.xml"/>
      <Relationship Id="rId3" Type="http://x/hyperlink" Target="https://example.com" TargetMode="External"/>
    </Relationships>`;
    const parts = new OfficeParts(makeZip([{ name: 'xl/_rels/workbook.xml.rels', content: rels }]), OFFICE_LIMITS);
    expect([...parts.rels('xl/workbook.xml')]).toEqual([
      ['rId1', { target: 'xl/worksheets/sheet1.xml', type: 'http://x/worksheet' }],
      ['rId2', { target: 'xl/worksheets/sheet2.xml', type: 'http://x/worksheet' }],
    ]);
  });

  it('resolves .. in a relative target', () => {
    expect(resolvePart('ppt/slides/', '../notesSlides/notesSlide1.xml')).toBe('ppt/notesSlides/notesSlide1.xml');
  });
});

describe('TextOut', () => {
  it('reports full once it reaches its character cap', () => {
    const out = new TextOut(10);
    expect(out.line('12345')).toBe(true);
    expect(out.line('67890')).toBe(false);
    expect(out.line('more')).toBe(false);
    expect(out.toString()).toBe('12345\n67890');
  });

  it('cuts a line that does not fit so the text ends one character past the cap', () => {
    const out = new TextOut(10);
    expect(out.line('abc')).toBe(true);
    expect(out.line('x'.repeat(1_000_000))).toBe(false);
    expect(out.full).toBe(true);
    expect(out.toString().length).toBe(11);
    expect(out.line('more')).toBe(false);
    expect(out.toString().length).toBe(11);
  });

  it('is full once the reader stops it, whatever its length', () => {
    const out = new TextOut(100);
    out.line('short');
    out.stop();
    expect(out.full).toBe(true);
    expect(out.line('more')).toBe(false);
    expect(out.toString()).toBe('short');
  });
});

describe('markdownTable', () => {
  it('pads short rows and escapes pipes', () => {
    expect(markdownTable([['Item', 'Cost'], ['A|B']])).toEqual(['| Item | Cost |', '| --- | --- |', '| A\\|B |  |']);
  });
});
