export type EvidenceRecord = {
  index: number;
  text: string;
  locator: string;
  dependencies: number[];
};

const CONTEXT_OBJECT = /^(?:contract|evaluation_contract|config(?:uration)?|conditions?|environment|metadata|meta|provenance|physical_ledger|identity|experiment|model|dataset|tokenizer|sampling|seeds|units)$/i;
const CONTEXT_FIELD = /(?:^|_)(?:id|identity|experiment|model|schema|source|path|root|handle|uri|url|revision|tokenizer|dataset|split|seed|context|seqlen|unit|units|denominator|precision|dtype|bpw|target|parent|scope|status|state|done|partial|verified|verification|retained|copied|changed|deleted|included|reexecution|selection|requantization|training|forcing|count|timestamp|recorded_at|created_utc)(?:_|$)/i;
const pointer = (path: string, key: string) => `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;

function jsonRecords(value: unknown): EvidenceRecord[] {
  const records: EvidenceRecord[] = [];
  const add = (path: string, fields: Record<string, unknown>, dependencies: number[]): number => {
    const index = records.length;
    records.push({ index, text: JSON.stringify(fields), locator: `input#${path}`, dependencies });
    return index;
  };
  const visit = (node: unknown, path: string, inherited: number[], context = false): number[] => {
    if (Array.isArray(node)) {
      node.forEach((child, i) => visit(child, pointer(path, String(i)), inherited));
      return [];
    }
    if (!node || typeof node !== 'object') {
      add(path, { value: node }, inherited);
      return [];
    }
    const fields: Record<string, unknown> = Object.create(null);
    const anchors: Record<string, unknown> = Object.create(null);
    const children: [string, unknown][] = [];
    for (const [key, child] of Object.entries(node)) {
      if (child && typeof child === 'object' && !(Array.isArray(child) && child.every(item => item === null || typeof item !== 'object'))) {
        children.push([key, child]);
      } else {
        const compactContext = (context || typeof child === 'boolean' || CONTEXT_FIELD.test(key)) && JSON.stringify(child).length <= 512;
        (compactContext ? anchors : fields)[key] = child;
      }
    }
    if (!children.length && JSON.stringify(node).length <= 1_200) {
      return [add(path, node as Record<string, unknown>, inherited)];
    }
    const own = Object.keys(anchors).length ? [add(path, anchors, inherited)] : [];
    const parent = [...inherited, ...own];
    const conditions = children.filter(([key]) => CONTEXT_OBJECT.test(key))
      .flatMap(([key, child]) => visit(child, pointer(path, key), parent, true));
    const dependencies = [...parent, ...conditions];
    if (Object.keys(fields).length) {
      // Wide inventories must not displace a compact result; split on field boundaries, never inside values.
      if (JSON.stringify(fields).length > 1_200) {
        for (const [key, child] of Object.entries(fields)) add(path, { [key]: child }, dependencies);
      } else add(path, fields, dependencies);
    }
    for (const [key, child] of children.filter(([key]) => !CONTEXT_OBJECT.test(key))) {
      visit(child, pointer(path, key), dependencies);
    }
    if (!Object.keys(anchors).length && !Object.keys(fields).length && !children.length) add(path, {}, inherited);
    return [...own, ...conditions];
  };
  visit(value, '', []);
  return records;
}

function markdownRecords(text: string): EvidenceRecord[] {
  const records: EvidenceRecord[] = [];
  const lines = text.split(/\r?\n/);
  const add = (start: number, end: number, content: string, dependencies: number[]): number => {
    const index = records.length;
    records.push({ index, text: content, locator: `input:L${start + 1}-L${end + 1}`, dependencies });
    return index;
  };
  const headings: { level: number; id: number }[] = [];
  const context = () => headings.map(item => item.id);
  let previousParagraph: number | undefined;
  for (let i = 0; i < lines.length;) {
    if (!lines[i].trim()) { i++; continue; }
    const heading = /^(#{1,6})\s/.exec(lines[i]);
    if (heading) {
      while (headings.length && headings.at(-1)!.level >= heading[1].length) headings.pop();
      headings.push({ level: heading[1].length, id: add(i, i, lines[i], context()) });
      previousParagraph = undefined;
      i++;
    } else if (lines[i].includes('|') && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] ?? '') && (lines[i + 1] ?? '').includes('---')) {
      const header = add(i, i + 1, `${lines[i]}\n${lines[i + 1]}`, context());
      i += 2;
      const start = i;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) i++;
      let after = i;
      while (after < lines.length && !lines[after].trim()) after++;
      const dependencies = [...context(), header];
      if (previousParagraph !== undefined) dependencies.push(previousParagraph);
      if (/^Sources?:/i.test(lines[after] ?? '')) {
        const source = add(after, after, lines[after], context());
        dependencies.push(source);
        after++;
      }
      while (after < lines.length && !lines[after].trim()) after++;
      if (after < lines.length && !/^(?:#{1,6}\s|\s*\||\s*```)/.test(lines[after])) {
        const qualifierStart = after++;
        while (after < lines.length && lines[after].trim() && !/^(?:#{1,6}\s|\s*\||\s*```)/.test(lines[after])) after++;
        dependencies.push(add(qualifierStart, after - 1, lines.slice(qualifierStart, after).join('\n'), context()));
      }
      for (let row = start; row < i; row++) add(row, row, lines[row], dependencies);
      i = after;
      previousParagraph = undefined;
    } else {
      const start = i++;
      if (/^\s*```/.test(lines[start])) {
        while (i < lines.length && !/^\s*```/.test(lines[i])) i++;
        if (i < lines.length) i++;
      } else {
        while (i < lines.length && lines[i].trim() && !/^(?:#{1,6}\s|\s*```)/.test(lines[i])
          && !(lines[i].includes('|') && /^[\s|:-]+$/.test(lines[i + 1] ?? ''))) i++;
      }
      previousParagraph = add(start, i - 1, lines.slice(start, i).join('\n'), context());
    }
  }
  return records;
}

export function evidenceRecords(text: string, sanitize: (value: string) => string = value => value): EvidenceRecord[] | undefined {
  const parse = (value: string) => JSON.parse(value, (_key, child) => typeof child === 'string' ? sanitize(child) : child);
  try {
    const parsed = parse(text);
    if (parsed && typeof parsed === 'object') return jsonRecords(parsed);
  } catch { /* Non-JSON output retains its original text structure. */ }
  const lines = text.split(/\r?\n/).map((line, index) => ({ line, index })).filter(item => item.line.trim());
  if (lines.length > 1 && lines.every(item => item.line.trimStart().startsWith('{'))) {
    try {
      const records: EvidenceRecord[] = [];
      for (const { line, index } of lines) {
        const offset = records.length;
        records.push(...jsonRecords(parse(line)).map(record => ({ ...record,
          index: record.index + offset, locator: record.locator.replace('input#', `input:L${index + 1}#`),
          dependencies: record.dependencies.map(id => id + offset) })));
      }
      return records;
    } catch { /* Mixed or incomplete JSONL remains a plain log. */ }
  }
  if (/^#{1,6}\s|^\s*\|.+\||^[^\n]*\|[^\n]*\r?\n[|:\s-]+$/m.test(text)) return markdownRecords(text);
  return undefined;
}

export function renderEvidence(records: EvidenceRecord[], selected: Set<number>, prefix = ''): string {
  const header = `${prefix}Evidence excerpts ${selected.size}/${records.length}; omitted=${records.length - selected.size}. Pointers refer to original input; source not stored.\n`;
  const order = new Set<number>();
  const include = (id: number) => {
    if (order.has(id)) return;
    records[id].dependencies.forEach(include);
    order.add(id);
  };
  selected.forEach(include);
  return header + [...order].map(index => {
    const record = records[index];
    const dependencies = record.dependencies.filter(id => selected.has(id));
    return `[${index + 1} ${record.locator}${dependencies.length ? ` context=${dependencies.map(id => id + 1).join(',')}` : ''}]\n${record.text}`;
  }).join('\n');
}
