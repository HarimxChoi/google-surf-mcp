import { extname } from 'node:path';

export type NativeDocumentFormat = 'docx' | 'pptx' | 'hwp' | 'hwpx';
export type DocumentFormat = NativeDocumentFormat | 'pdf' | 'image';
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
export const MAX_DOCUMENT_EXPANDED_BYTES = 64 * 1024 * 1024;

export function documentFormatFromPath(path: string): DocumentFormat | undefined {
  const extension = extname(path).toLowerCase().slice(1);
  if (['docx', 'pptx', 'hwp', 'hwpx', 'pdf'].includes(extension)) return extension as DocumentFormat;
  if (['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff'].includes(extension)) return 'image';
  return undefined;
}

export function isNativeDocumentCandidate(bytes: Uint8Array, contentType: string, url: string): boolean {
  const magic = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 8));
  if (magic.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))
    || magic.equals(Buffer.from([208, 207, 17, 224, 161, 177, 26, 225]))) return true;
  const format = documentFormatFromPath(new URL(url).pathname);
  return !!format && !['pdf', 'image'].includes(format)
    || /(?:wordprocessingml|presentationml|x-hwp|haansoft|hwp\+zip)/i.test(contentType);
}
