import { createRequire } from 'node:module';
import { inflateRawSync } from 'node:zlib';
import type { Readable } from 'node:stream';
import * as CFB from 'cfb';
import { MAX_DOCUMENT_BYTES, MAX_DOCUMENT_EXPANDED_BYTES, type NativeDocumentFormat } from './documentFormats.js';

interface ZipEntry { fileName: string; uncompressedSize: number; generalPurposeBitFlag: number }
interface ZipFile {
  on(name: 'entry', listener: (entry: ZipEntry) => void): void;
  on(name: 'error', listener: (error: Error) => void): void;
  on(name: 'end', listener: () => void): void;
  readEntry(): void;
  close(): void;
  openReadStream(entry: ZipEntry, callback: (error: Error | null, stream: Readable) => void): void;
}
const require = createRequire(import.meta.url);
const yauzl = require('yauzl') as { fromBuffer(bytes: Buffer, options: object,
  callback: (error: Error | null, zip: ZipFile) => void): void };

export interface ArchiveReadOptions {
  selectEntry: (name: string) => boolean;
  readEntry: (name: string, stream: Readable) => Promise<void>;
}

export async function inspectDocumentArchive(bytes: Uint8Array, options?: ArchiveReadOptions): Promise<NativeDocumentFormat> {
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new Error('document exceeds 25 MiB; split the source');
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.subarray(0, 8).equals(Buffer.from([208, 207, 17, 224, 161, 177, 26, 225]))) {
    const compound = CFB.read(buffer, { type: 'buffer' });
    const header = CFB.find(compound, '/FileHeader');
    const rawHeader = Buffer.from(header?.content ?? []);
    if (rawHeader.subarray(0, 17).toString('ascii') !== 'HWP Document File') throw new Error('unsupported compound document; only HWP 5 is supported');
    const compressed = rawHeader.length >= 40 && (rawHeader.readUInt32LE(36) & 1) !== 0;
    let total = 0;
    for (let i = 0; i < compound.FileIndex.length; i++) {
      const entry = compound.FileIndex[i];
      if (entry.type !== 2) continue;
      const content = Buffer.from(entry.content ?? []);
      const path = compound.FullPaths[i];
      let size = content.length;
      if (content.length && ((compressed && /\/(?:DocInfo|BodyText\/Section\d+)$/.test(path)) || /\/BinData\//.test(path))) {
        try { size = inflateRawSync(content, { maxOutputLength: Math.max(1, MAX_DOCUMENT_EXPANDED_BYTES - total) }).length; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' || !/\/BinData\//.test(path)) throw error;
        }
      }
      total += size;
      if (total > MAX_DOCUMENT_EXPANDED_BYTES) throw new Error('HWP expanded content exceeds 64 MiB; split the source');
    }
    return 'hwp';
  }
  return await new Promise<NativeDocumentFormat>((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(error);
      let count = 0;
      let total = 0;
      let declared = 0;
      let settled = false;
      const names = new Set<string>();
      const paths = new Set<string>();
      const fail = (failure: Error): void => { if (!settled) { settled = true; zip.close(); reject(failure); } };
      zip.on('error', fail);
      zip.on('entry', (entry: ZipEntry) => {
        if (++count > 4096) return fail(new Error('document archive exceeds 4096 entries'));
        if (paths.has(entry.fileName)) return fail(new Error('document archive contains duplicate entries'));
        paths.add(entry.fileName);
        declared += entry.uncompressedSize;
        if (declared > MAX_DOCUMENT_EXPANDED_BYTES || entry.generalPurposeBitFlag & 1) {
          return fail(new Error('document archive is encrypted or exceeds 64 MiB expanded content'));
        }
        names.add(entry.fileName.toLowerCase());
        if (entry.fileName.endsWith('/')) return zip.readEntry();
        if (options && !options.selectEntry(entry.fileName)) return zip.readEntry();
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return fail(streamError);
          stream.on('error', fail);
          stream.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > MAX_DOCUMENT_EXPANDED_BYTES) {
              stream.destroy(); fail(new Error('document decompression exceeds 64 MiB'));
            }
          });
          if (options) options.readEntry(entry.fileName, stream).then(() => {
            if (!settled) zip.readEntry();
          }, failure => { stream.destroy(); fail(failure); });
          else {
            stream.on('end', () => { if (!settled) zip.readEntry(); });
            stream.resume();
          }
        });
      });
      zip.on('end', () => {
        if (settled) return;
        settled = true;
        const format = names.has('word/document.xml') ? 'docx' : names.has('ppt/presentation.xml') ? 'pptx'
          : names.has('contents/header.xml') || names.has('contents/section0.xml') ? 'hwpx' : undefined;
        if (format) resolve(format); else reject(new Error('unsupported archive; expected DOCX, PPTX or HWPX'));
      });
      zip.readEntry();
    });
  });
}
