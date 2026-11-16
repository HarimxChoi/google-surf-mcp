import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { SaxesParser, type SaxesTagNS } from 'saxes';
import { inspectDocumentArchive } from './documentArchive.js';
import { boundDocumentCatalog } from './documentCatalogBudget.js';
import type { NativeDocumentFormat } from './documentFormats.js';

interface Property { part: string; name: string; value: string }
interface Section { name: string; slide_indexes: number[] }
interface PresentationCatalog {
  slide_count: number;
  slide_parts_complete: boolean;
  hidden_slide_count: number;
  hidden_slide_indexes: number[];
  notes_relationship_slide_count: number;
  notes_relationship_slide_indexes: number[];
  nonempty_note_slide_count: number;
  nonempty_note_slide_indexes: number[];
  note_body_scope_complete: boolean;
  unresolved_slide_indexes: number[];
  sections: Section[];
}
export interface DocumentCatalog {
  version: 1;
  source_sha256: string;
  format: 'docx' | 'pptx';
  producer_properties: Property[];
  presentation?: PresentationCatalog;
  source_parts: Array<{ part: string; sha256: string }>;
  details_truncated: boolean;
}
interface Relation { id: string; type: string; target: string; external: boolean }
interface Shape { type?: string; index?: string; chars: number }
interface Part {
  sha256: string;
  rootValid?: boolean;
  rootKind?: string;
  hidden?: boolean;
  relations: Relation[];
  slides: Array<{ id: string; relation: string }>;
  sections: Array<{ id: string; name: string; members: string[] }>;
  shapes: Shape[];
}
const presentationUris = new Set(['http://schemas.openxmlformats.org/presentationml/2006/main', 'http://purl.oclc.org/ooxml/presentationml/main']);
const drawingUris = new Set(['http://schemas.openxmlformats.org/drawingml/2006/main', 'http://purl.oclc.org/ooxml/drawingml/main']);
const relationUris = new Set(['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships']);
const packageUris = new Set(['http://schemas.openxmlformats.org/package/2006/relationships', 'http://purl.oclc.org/ooxml/package/relationships']);
const relationIs = (relation: Relation, kind: string): boolean => [...relationUris].some(uri => relation.type === `${uri}/${kind}`);
const selectedPart = (name: string): boolean => /^docProps\/[^/]+\.xml$/.test(name)
  || /^ppt\/(?:presentation\.xml|_rels\/presentation\.xml\.rels)$/.test(name)
  || /^ppt\/(?:slides|notesSlides|notesMasters)\/(?:_rels\/)?[^/]+\.xml(?:\.rels)?$/.test(name);
const relationPart = (part: string): string => posix.join(posix.dirname(part), '_rels', `${posix.basename(part)}.rels`);
const targetPart = (part: string, relation: Relation): string | undefined => relation.external ? undefined
  : posix.normalize(relation.target.startsWith('/') ? relation.target.slice(1) : posix.join(posix.dirname(part), relation.target));
const attribute = (tag: SaxesTagNS, name: string): string | undefined => Object.values(tag.attributes).find(row => row.local === name && !row.uri)?.value;

export async function readDocumentCatalog(bytes: Uint8Array, maxChars: number): Promise<{
  format: NativeDocumentFormat; catalog?: DocumentCatalog; catalogTruncated: boolean;
}> {
  const properties: Property[] = [], parts = new Map<string, Part>();
  let propertyTruncated = false;
  const format = await inspectDocumentArchive(bytes, {
    selectEntry: selectedPart,
    async readEntry(name, stream) {
      const part: Part = { sha256: '', relations: [], slides: [], sections: [], shapes: [] };
      const parser = new SaxesParser({ xmlns: true }), digest = createHash('sha256');
      let decoder: TextDecoder | undefined, prefix = Buffer.alloc(0);
      const stack: Array<{ tag: SaxesTagNS; text: string; leaf: boolean }> = [];
      const shapes: Array<{ depth: number; value: Shape }> = [];
      let paragraph: { depth: number; shape?: Shape; chars: number; trailing: number } | undefined;
      let section: { depth: number; value: Part['sections'][number] } | undefined;
      parser.on('doctype', () => { throw new Error('document catalog does not accept DOCTYPE'); });
      parser.on('error', error => { throw error; });
      parser.on('opentag', tag => {
        if (stack.length >= 128) throw new Error('document XML nesting exceeds 128 levels');
        if (stack.length) stack[stack.length - 1].leaf = false;
        stack.push({ tag, text: '', leaf: true });
        const p = presentationUris.has(tag.uri), depth = stack.length;
        if (depth === 1) part.rootKind = tag.local;
        if (depth === 1 && name.endsWith('.rels')) part.rootValid = packageUris.has(tag.uri) && tag.local === 'Relationships';
        else if (depth === 1 && name.startsWith('ppt/')) {
          const root = name === 'ppt/presentation.xml' ? 'presentation' : name.startsWith('ppt/notesMasters/') ? 'notesMaster'
            : name.startsWith('ppt/notesSlides/') ? 'notes' : 'sld';
          part.rootValid = p && tag.local === root;
        }
        if (packageUris.has(tag.uri) && tag.local === 'Relationship') {
          part.relations.push({ id: attribute(tag, 'Id') ?? '', type: attribute(tag, 'Type') ?? '',
            target: attribute(tag, 'Target') ?? '', external: attribute(tag, 'TargetMode') === 'External' });
        }
        if (name === 'ppt/presentation.xml') {
          if (tag.local === 'section' && tag.uri === 'http://schemas.microsoft.com/office/powerpoint/2010/main') {
            const value = { id: attribute(tag, 'id') ?? '', name: attribute(tag, 'name') ?? '', members: [] as string[] };
            part.sections.push(value); section = { depth, value };
          }
          if (tag.local === 'sldId') {
            const relation = Object.values(tag.attributes).find(row => row.local === 'id' && relationUris.has(row.uri))?.value;
            const parent = stack.at(-2)?.tag;
            if (p && relation && parent?.local === 'sldIdLst' && presentationUris.has(parent.uri)) part.slides.push({ id: attribute(tag, 'id') ?? '', relation });
            else if (section && tag.uri === 'http://schemas.microsoft.com/office/powerpoint/2010/main'
              && attribute(tag, 'id')) section.value.members.push(attribute(tag, 'id')!);
          }
        }
        if (depth === 1 && p && tag.local === 'sld') part.hidden = ['0', 'false'].includes(attribute(tag, 'show') ?? '');
        if (!/^ppt\/(?:notesSlides|notesMasters)\//.test(name) || name.endsWith('.rels')) return;
        if (p && ['sp', 'grpSp', 'graphicFrame', 'pic', 'cxnSp'].includes(tag.local)) {
          const value: Shape = { chars: 0 }; part.shapes.push(value); shapes.push({ depth, value });
        }
        if (p && tag.local === 'ph' && shapes.length) Object.assign(shapes[shapes.length - 1].value,
          { type: attribute(tag, 'type'), index: attribute(tag, 'idx') });
        if (drawingUris.has(tag.uri) && tag.local === 'p') paragraph = { depth, shape: shapes.at(-1)?.value, chars: 0, trailing: 0 };
      });
      const text = (value: string): void => {
        const node = stack.at(-1);
        if (!node) return;
        if (name.startsWith('docProps/')) {
          const available = 6000 - node.text.length;
          let length = Math.min(value.length, available);
          if (length < value.length && value.charCodeAt(length - 1) >= 0xd800 && value.charCodeAt(length - 1) <= 0xdbff) length--;
          node.text += value.slice(0, length);
          if (value.length > available) propertyTruncated = true;
        }
        if (!paragraph || !drawingUris.has(node.tag.uri) || node.tag.local !== 't') return;
        if (!paragraph.chars) value = value.trimStart();
        const trailing = value.length - value.trimEnd().length;
        paragraph.trailing = trailing === value.length ? paragraph.trailing + trailing : trailing;
        paragraph.chars += value.length;
      };
      parser.on('text', text); parser.on('cdata', text);
      parser.on('closetag', () => {
        const depth = stack.length, node = stack.pop()!;
        if (name.startsWith('docProps/') && node.leaf && node.text.trim()) {
          const parent = stack.at(-1)?.tag;
          const key = parent?.local === 'property' ? attribute(parent, 'name') : node.tag.name;
          if (properties.length < 256) properties.push({ part: name, name: key ?? node.tag.name, value: node.text.trim() });
          else propertyTruncated = true;
        }
        if (paragraph?.depth === depth) {
          const chars = paragraph.chars - paragraph.trailing;
          if (chars > 0) {
            if (paragraph.shape) paragraph.shape.chars += chars;
            else part.shapes.push({ chars });
          }
          paragraph = undefined;
        }
        if (shapes.at(-1)?.depth === depth) shapes.pop();
        if (section?.depth === depth) section = undefined;
      });
      for await (const chunk of stream) {
        digest.update(chunk);
        if (!decoder) {
          prefix = Buffer.concat([prefix, chunk]);
          if (prefix.length < 4) continue;
          const little = prefix[0] === 0xff && prefix[1] === 0xfe || prefix[0] === 0x3c && prefix[1] === 0;
          const big = prefix[0] === 0xfe && prefix[1] === 0xff || prefix[0] === 0 && prefix[1] === 0x3c;
          decoder = new TextDecoder(little ? 'utf-16le' : big ? 'utf-16be' : 'utf-8', { fatal: true });
          parser.write(decoder.decode(prefix, { stream: true })); prefix = Buffer.alloc(0);
        } else parser.write(decoder.decode(chunk, { stream: true }));
      }
      parser.write(decoder ? decoder.decode() : new TextDecoder('utf-8', { fatal: true }).decode(prefix)); parser.close();
      part.sha256 = digest.digest('hex'); parts.set(name, part);
    },
  });
  if (format !== 'docx' && format !== 'pptx') return { format, catalogTruncated: false };
  const catalog: DocumentCatalog = { version: 1, source_sha256: createHash('sha256').update(bytes).digest('hex'), format,
    producer_properties: properties, source_parts: [...parts].map(([part, value]) => ({ part, sha256: value.sha256 })),
    details_truncated: propertyTruncated };
  if (format === 'pptx') {
    const source = parts.get('ppt/presentation.xml');
    if (!source?.rootValid) throw new Error('document presentation XML has an unsupported root or namespace');
    const presentationRelations = parts.get('ppt/_rels/presentation.xml.rels');
    const relationships = presentationRelations?.rootValid ? presentationRelations.relations : [];
    const slides = (source?.slides ?? []).map((slide, index) => {
      const relation = relationships.find(row => row.id === slide.relation && relationIs(row, 'slide'));
      const part = relation ? targetPart('ppt/presentation.xml', relation) : undefined;
      return { index: index + 1, id: slide.id, part };
    });
    const presentation: PresentationCatalog = { slide_count: slides.length, slide_parts_complete: true, hidden_slide_count: 0, hidden_slide_indexes: [],
      notes_relationship_slide_count: 0, notes_relationship_slide_indexes: [], nonempty_note_slide_count: 0,
      nonempty_note_slide_indexes: [], note_body_scope_complete: Boolean(source), unresolved_slide_indexes: [],
      sections: (source?.sections ?? []).map(section => ({ name: section.name,
        slide_indexes: section.members.flatMap(id => slides.filter(slide => slide.id === id).map(slide => slide.index)) })) };
    for (const slide of slides) {
      const part = slide.part ? parts.get(slide.part) : undefined;
      if (!part?.rootValid || part.rootKind !== 'sld' || !slide.part) { presentation.unresolved_slide_indexes.push(slide.index);
        presentation.slide_parts_complete = presentation.note_body_scope_complete = false; continue; }
      if (part.hidden) presentation.hidden_slide_indexes.push(slide.index);
      const slideRelations = parts.get(relationPart(slide.part));
      if (slideRelations && !slideRelations.rootValid) presentation.note_body_scope_complete = false;
      const notes = (slideRelations?.rootValid ? slideRelations.relations : []).filter(row => relationIs(row, 'notesSlide'));
      if (notes.length) presentation.notes_relationship_slide_indexes.push(slide.index);
      let bodyChars = 0;
      for (const relation of notes) {
        const notePart = targetPart(slide.part, relation), note = notePart ? parts.get(notePart) : undefined;
        if (!note?.rootValid || note.rootKind !== 'notes' || !notePart) { presentation.note_body_scope_complete = false; continue; }
        const noteRelations = parts.get(relationPart(notePart));
        const masterRelation = noteRelations?.rootValid ? noteRelations.relations.find(row => relationIs(row, 'notesMaster')) : undefined;
        const masterPart = masterRelation ? targetPart(notePart, masterRelation) : undefined;
        const master = masterPart ? parts.get(masterPart) : undefined;
        for (const shape of note.shapes) {
          let type = shape.type;
          // Only explicit matching indexes resolve an inherited role; unknown text is not an absence.
          if (!type && shape.index !== undefined && master?.rootValid && master.rootKind === 'notesMaster') {
            const matching = master.shapes.filter(row => row.index === shape.index && row.type);
            if (new Set(matching.map(row => row.type)).size === 1) type = matching[0]?.type;
          }
          if (type === 'body') bodyChars += shape.chars;
          else if (shape.chars && !['sldImg', 'sldNum', 'hdr', 'ftr', 'dt'].includes(type ?? '')) presentation.note_body_scope_complete = false;
        }
      }
      if (bodyChars) presentation.nonempty_note_slide_indexes.push(slide.index);
    }
    presentation.hidden_slide_count = presentation.hidden_slide_indexes.length;
    presentation.notes_relationship_slide_count = presentation.notes_relationship_slide_indexes.length;
    presentation.nonempty_note_slide_count = presentation.nonempty_note_slide_indexes.length;
    catalog.presentation = presentation;
  }
  const bounded = boundDocumentCatalog(catalog, maxChars);
  return { format, catalog: bounded, catalogTruncated: !bounded || bounded.details_truncated };
}
