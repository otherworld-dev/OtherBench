import { crc32, inflateRawSync } from 'node:zlib';

/**
 * Just enough of the ZIP format to read a claude.ai export without unpacking
 * it to disk (spec 2026-10-09-claude-import-design §1): the central directory,
 * and entries stored or deflated. Anything else (ZIP64, encryption, other
 * compression, a spanned archive) is refused with a message saying so, and
 * every entry's CRC is checked. Entry names are only ever compared, never used
 * as paths, so a hostile name can't write anywhere.
 */

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

export interface ZipEntry {
  /** As stored, with `/` separators. */
  name: string;
  /** Uncompressed size, as the central directory gives it. */
  size: number;
  compressedSize: number;
  method: number;
  crc: number;
  flags: number;
  localHeaderOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_SIZE = 22;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const MAX_COMMENT = 0xffff;
const FLAG_ENCRYPTED = 0x1;
const FLAG_UTF8 = 0x800;
const STORED = 0;
const DEFLATED = 8;

function findEndOfCentralDirectory(zip: Buffer): number {
  const earliest = Math.max(0, zip.length - EOCD_SIZE - MAX_COMMENT);
  for (let i = zip.length - EOCD_SIZE; i >= earliest; i--) {
    if (zip.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new ZipError("This isn't a ZIP file, or it's damaged: its directory is missing.");
}

/** Every entry in the archive's central directory, folders included. */
export function listZipEntries(zip: Buffer): ZipEntry[] {
  if (zip.length < EOCD_SIZE) throw new ZipError("This isn't a ZIP file: it's too short.");
  const eocd = findEndOfCentralDirectory(zip);
  const disk = zip.readUInt16LE(eocd + 4);
  const directoryDisk = zip.readUInt16LE(eocd + 6);
  const total = zip.readUInt16LE(eocd + 10);
  const directorySize = zip.readUInt32LE(eocd + 12);
  const directoryOffset = zip.readUInt32LE(eocd + 16);
  if (disk !== 0 || directoryDisk !== 0) throw new ZipError("This ZIP is split across several files, which the import can't read. Extract it and choose the folder instead.");
  if (total === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new ZipError("This ZIP uses the ZIP64 format, which the import can't read. Extract it and choose the folder instead.");
  }
  if (directoryOffset + directorySize > eocd) throw new ZipError('This ZIP is damaged: its directory points past the end of the file.');

  const entries: ZipEntry[] = [];
  let at = directoryOffset;
  for (let i = 0; i < total; i++) {
    if (at + CENTRAL_SIZE > eocd || zip.readUInt32LE(at) !== CENTRAL_SIGNATURE) throw new ZipError('This ZIP is damaged: an entry in its directory is unreadable.');
    const flags = zip.readUInt16LE(at + 8);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const nameBytes = zip.subarray(at + CENTRAL_SIZE, at + CENTRAL_SIZE + nameLength);
    entries.push({
      name: nameBytes.toString(flags & FLAG_UTF8 ? 'utf8' : 'latin1').replace(/\\/g, '/'),
      method: zip.readUInt16LE(at + 10),
      crc: zip.readUInt32LE(at + 16),
      compressedSize: zip.readUInt32LE(at + 20),
      size: zip.readUInt32LE(at + 24),
      flags,
      localHeaderOffset: zip.readUInt32LE(at + 42),
    });
    at += CENTRAL_SIZE + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** One entry's content. Refuses an entry whose stated size is over `maxBytes`, and never inflates past its stated size. */
export function readZipEntry(zip: Buffer, entry: ZipEntry, maxBytes: number): Buffer {
  if (entry.flags & FLAG_ENCRYPTED) throw new ZipError(`"${entry.name}" is encrypted, which the import can't read.`);
  if (entry.size > maxBytes) throw new ZipError(`"${entry.name}" is ${entry.size.toLocaleString('en-US')} bytes, over the ${maxBytes.toLocaleString('en-US')} the import reads.`);
  const local = entry.localHeaderOffset;
  if (local + LOCAL_SIZE > zip.length || zip.readUInt32LE(local) !== LOCAL_SIGNATURE) throw new ZipError(`This ZIP is damaged: "${entry.name}" can't be found in it.`);
  const start = local + LOCAL_SIZE + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
  const end = start + entry.compressedSize;
  if (end > zip.length) throw new ZipError(`This ZIP is damaged: "${entry.name}" runs past the end of the file.`);
  const raw = zip.subarray(start, end);

  let data: Buffer;
  if (entry.method === STORED) {
    data = Buffer.from(raw);
  } else if (entry.method === DEFLATED) {
    try {
      data = inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) });
    } catch {
      throw new ZipError(`This ZIP is damaged: "${entry.name}" doesn't decompress to the size its directory gives.`);
    }
  } else {
    throw new ZipError(`"${entry.name}" uses a compression method (${entry.method}) the import can't read. Extract the ZIP and choose the folder instead.`);
  }
  if (data.length !== entry.size) throw new ZipError(`This ZIP is damaged: "${entry.name}" isn't the size its directory gives.`);
  if (crc32(data) >>> 0 !== entry.crc) throw new ZipError(`This ZIP is damaged: "${entry.name}" fails its checksum.`);
  return data;
}
