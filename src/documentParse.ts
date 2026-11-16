import { inspectDocumentArchive } from './documentArchive.js';
import { readDocumentCatalog } from './documentCatalog.js';
import { hwpIRToPlainText } from './hwpText.js';
import { extractionProvenance } from './extractionProvenance.js';
import type { ExtractMode, ExtractResult } from './extract.js';
import { containsSensitiveContent } from './research/inventory.js';

export async function parseNativeDocument(bytes: Uint8Array, mode: ExtractMode, maxChars: number): Promise<ExtractResult> {
  if (mode === 'metadata') {
    const { format, catalog, catalogTruncated } = await readDocumentCatalog(bytes, maxChars);
    return { url: '', document_format: format, is_pdf: false, extraction_quality: 'metadata_only',
      ...(catalog ? { document_catalog: catalog } : {}),
      ...(catalogTruncated ? { truncated: true, quality_reason: 'document_catalog_details_exceed_response_budget' } : {}),
      extraction_provenance: extractionProvenance(bytes, format, 'archive') };
  }
  const format = await inspectDocumentArchive(bytes);
  const base = { url: '', document_format: format, is_pdf: false };
  let text: string;
  let contentFormat: 'text' | 'markdown' = 'text';
  let parser: 'xberg' | 'officeparser' | 'hwp-convert';
  let title: string | undefined;
  let pageCount: number | undefined;
  let reason: string | undefined;
  let sensitive = false;
  if (format === 'hwp' || format === 'hwpx') {
    const hwp = await import('hwp-convert');
    if (format === 'hwp') {
      const document = hwp.parseHwp(bytes);
      sensitive = containsSensitiveContent(hwpIRToPlainText(document));
      text = hwp.hwpDocumentToMarkdown(document, { embedImages: false });
    }
    else {
      const reader = new hwp.HwpxReader();
      await reader.loadFromArrayBuffer(Uint8Array.from(bytes).buffer);
      sensitive = containsSensitiveContent(await reader.extractText());
      text = await reader.extractMarkdown({ embedImages: false });
      title = (await reader.getDocumentInfo()).metadata?.title;
    }
    parser = 'hwp-convert'; contentFormat = 'markdown';
    reason = 'native_hwp_body; text boxes, charts, embedded objects and some headers or notes may be omitted';
  } else {
    const configured = process.env.SURF_EXTRACT_OFFICE_PARSER ?? 'auto';
    const preferred = configured === 'kreuzberg' ? 'xberg' : configured;
    if (!['auto', 'officeparser', 'xberg'].includes(preferred)) throw new Error('SURF_EXTRACT_OFFICE_PARSER must be auto, officeparser or xberg');
    let native: typeof import('@xberg-io/xberg') | undefined;
    if (preferred !== 'officeparser') {
      try {
        const moduleName = '@xberg-io/xberg';
        native = await import(moduleName);
      } catch {
        if (preferred === 'xberg') throw new Error('Xberg is unavailable; install optional dependencies with a supported Node version or use SURF_EXTRACT_OFFICE_PARSER=officeparser');
        reason = 'xberg_unavailable; using officeparser';
      }
    }
    if (native) {
      const mime = format === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
      const output = await native.extract({ kind: native.ExtractInputKind.Bytes, bytes, mimeType: mime }, {
        useCache: false, outputFormat: 'plain', disableOcr: true,
        images: { extractImages: false }, maxConcurrentExtractions: 1,
      });
      const result = output.results?.[0];
      if (!result) throw new Error(output.errors?.[0]?.message ?? 'Xberg returned no document');
      text = result.content ?? '';
      for (const table of result.tables ?? []) {
        const plain = table.cells?.map(row => row.join(' ')).join('\n');
        if (plain && table.markdown && text.includes(plain)) { text = text.replace(plain, table.markdown.trim()); contentFormat = 'markdown'; }
      }
      title = result.metadata?.title;
      if (format === 'pptx' && result.counts?.pages) pageCount = result.counts.pages;
      parser = 'xberg';
    } else {
      const { OfficeParser } = await import('officeparser');
      const ast = await OfficeParser.parseOffice(Buffer.from(bytes), { ocr: false, extractAttachments: false,
        ignoreNotes: false, decompressionLimits: { maxUncompressedBytes: 64 * 1024 * 1024,
          maxZipEntries: 4096, maxTableCells: 100_000 } });
      text = String((await ast.to('text', { includeImages: false, renderMetadata: false,
        textConfig: { preserveLayout: true, renderNotes: true } })).value);
      title = ast.metadata.title;
      parser = 'officeparser';
      reason = [reason, ...ast.warnings.map(warning => warning.code)].filter(Boolean).join('; ').slice(0, 200) || undefined;
    }
  }
  const limit = mode === 'abstract' ? Math.min(2000, maxChars) : maxChars;
  const content = text.slice(0, limit);
  return { ...base, ...(title ? { title } : {}), ...(pageCount ? { page_count: pageCount } : {}),
    content, length: content.length, source_length: text.length,
    truncated: text.length > limit || reason?.includes('TABLE_CELL_LIMIT_EXCEEDED') === true,
    ...(sensitive || containsSensitiveContent(text) ? { contains_sensitive_content: true } : {}),
    content_format: contentFormat,
    extraction_quality: text.trim() ? mode === 'abstract' ? 'abstract' : 'full_text' : 'metadata_only',
    ...(reason || !text.trim() ? { quality_reason: reason ?? 'native_document_returned_no_text' } : {}),
    extraction_provenance: extractionProvenance(bytes, format, parser, 'off', undefined, contentFormat) };
}
