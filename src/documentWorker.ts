import type { ExtractMode } from './extract.js';
import { parseNativeDocument } from './documentParse.js';
import type { DocumentFormat } from './documentFormats.js';
import { DOCUMENT_SETTING_KEYS } from './documentSettings.js';

process.on('disconnect', () => process.exit(0));
process.on('message', async (message: { id: number; bytes: Uint8Array; format: DocumentFormat | 'native'; mode: ExtractMode;
  maxChars: number; settings: Record<string, string> }) => {
  try {
    for (const name of DOCUMENT_SETTING_KEYS) {
      if (message.settings[name]) process.env[name] = message.settings[name]; else delete process.env[name];
    }
    const result = message.format === 'pdf'
      ? { url: '', ...await (await import('./extract-pdf.js')).extractPdfTiered(message.bytes, message.mode, message.maxChars) }
      : message.format === 'image'
        ? await (await import('./extract-image.js')).extractImage(message.bytes, '', message.mode, message.maxChars)
        : await parseNativeDocument(message.bytes, message.mode, message.maxChars);
    process.send?.({ id: message.id, result });
  } catch (error) {
    process.send?.({ id: message.id, result: { url: '', error: `document parse failed: ${(error as Error).message.slice(0, 200)}`,
      extraction_quality: 'metadata_only', quality_reason: 'document_parse_failed' } });
  }
});
