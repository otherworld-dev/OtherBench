import { describe, expect, it } from 'vitest';
import { listZipEntries, readZipEntry, ZipError } from '../../src/import/zip.js';
import { makeZip } from './make-zip.js';

describe('zip reader', () => {
  it('lists entries and reads stored and deflated ones', () => {
    const zip = makeZip([
      { name: 'conversations.json', content: '[{"a":1}]' },
      { name: 'projects/p1.json', content: 'stored text', method: 0 },
    ]);
    const entries = listZipEntries(zip);
    expect(entries.map((e) => [e.name, e.size, e.method])).toEqual([
      ['conversations.json', 9, 8],
      ['projects/p1.json', 11, 0],
    ]);
    expect(readZipEntry(zip, entries[0]!, 1000).toString()).toBe('[{"a":1}]');
    expect(readZipEntry(zip, entries[1]!, 1000).toString()).toBe('stored text');
  });

  it('reads a UTF-8 name and an empty entry', () => {
    const zip = makeZip([{ name: 'memories/é.json', content: '' }]);
    const [entry] = listZipEntries(zip);
    expect(entry!.name).toBe('memories/é.json');
    expect(readZipEntry(zip, entry!, 10).length).toBe(0);
  });

  it('refuses an entry over the size limit before reading it', () => {
    const zip = makeZip([{ name: 'big.json', content: 'x'.repeat(100) }]);
    expect(() => readZipEntry(zip, listZipEntries(zip)[0]!, 99)).toThrow(/over the 99/);
  });

  it('refuses encryption, other compression methods and a bad checksum', () => {
    const encrypted = makeZip([{ name: 'a', content: 'x', flags: 0x801 }]);
    expect(() => readZipEntry(encrypted, listZipEntries(encrypted)[0]!, 10)).toThrow(/encrypted/);

    const bzip = makeZip([{ name: 'a', content: 'x', method: 0 }]);
    const entry = { ...listZipEntries(bzip)[0]!, method: 12 };
    expect(() => readZipEntry(bzip, entry, 10)).toThrow(/compression method \(12\)/);

    const corrupt = makeZip([{ name: 'a', content: 'abc', method: 0 }]);
    corrupt[30 + 1] = 'z'.charCodeAt(0);
    expect(() => readZipEntry(corrupt, listZipEntries(corrupt)[0]!, 10)).toThrow(/checksum/);
  });

  it("refuses what isn't a ZIP, a truncated one and ZIP64", () => {
    expect(() => listZipEntries(Buffer.from('not a zip at all, just text in a file'))).toThrow(ZipError);
    expect(() => listZipEntries(Buffer.alloc(5))).toThrow(/too short/);

    const zip = makeZip([{ name: 'a', content: 'x' }]);
    expect(() => listZipEntries(zip.subarray(0, zip.length - 30))).toThrow(ZipError);

    const zip64 = Buffer.from(zip);
    zip64.writeUInt32LE(0xffffffff, zip64.length - 22 + 16);
    expect(() => listZipEntries(zip64)).toThrow(/ZIP64/);
  });

  it('refuses a deflated entry that inflates past its stated size', () => {
    const zip = makeZip([{ name: 'a', content: 'x'.repeat(1000) }]);
    const entry = { ...listZipEntries(zip)[0]!, size: 10 };
    expect(() => readZipEntry(zip, entry, 2000)).toThrow(ZipError);
  });
});
