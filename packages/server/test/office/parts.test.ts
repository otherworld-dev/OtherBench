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
    expect(parts.notes[0]).toMatch(/^\[Grunt skipped word\/document\.xml:/);
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
});

describe('markdownTable', () => {
  it('pads short rows and escapes pipes', () => {
    expect(markdownTable([['Item', 'Cost'], ['A|B']])).toEqual(['| Item | Cost |', '| --- | --- |', '| A\\|B |  |']);
  });
});
