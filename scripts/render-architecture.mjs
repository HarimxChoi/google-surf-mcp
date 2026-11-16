import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const copy = {
  en: {
    subtitle: 'Live discovery / source reading / local project knowledge',
    client: ['Any MCP client', 'Codex / Claude Code / Cursor / others'],
    web: ['search / search_parallel', 'Discover new web sources'],
    extract: ['extract', 'Read a known public URL'],
    local: ['project_memory_search', 'Search stored project knowledge'],
    browser: ['Chrome / Playwright', 'Shared native browser broker', 'Up to four reusable search tabs', 'Human CAPTCHA handoff'],
    reader: ['Source reader', 'HTTP / isolated headless context', 'LiteParse CPU OCR when enabled', 'Xberg Office / native HWP'],
    store: ['Local project store', 'SurrealDB / embedded RocksDB', 'Catalog / payloads / indexes', 'Typed graph and provenance'],
    webRank: ['Lightweight web ranking', 'Provider order + BM25 + RRF'],
    localRank: ['Hybrid local retrieval', 'Exact / BM25 / E5 / Graph', 'RRF + cached E5 reranking'],
    evidence: ['Bounded, source-backed evidence', 'Relevant passages / source references / follow-up reads'],
    read: 'read', save: 'save*',
    footer: '* Auto Ontology enabled. Live-only search does not open the project DB or load E5.',
  },
  ko: {
    subtitle: '새 웹 자료 검색 / 원문 읽기 / 저장된 프로젝트 지식 조회',
    client: ['MCP 클라이언트', 'Codex / Claude Code / Cursor 등'],
    web: ['search / search_parallel', '새 웹 자료 찾기'],
    extract: ['extract', '알고 있는 공개 URL 읽기'],
    local: ['project_memory_search', '저장된 프로젝트 지식 검색'],
    browser: ['Chrome / Playwright', '여러 세션이 공유하는 브라우저', '최대 4개 검색 탭 재사용', 'CAPTCHA는 사용자에게 요청'],
    reader: ['원문 리더', 'HTTP / 분리된 헤드리스 컨텍스트', 'LiteParse CPU OCR (선택)', 'Xberg Office / 전용 HWP 파서'],
    store: ['로컬 프로젝트 저장소', 'SurrealDB / 내장 RocksDB', 'Catalog / 본문 / 파생 색인', '지식그래프와 출처 연결'],
    webRank: ['가벼운 웹 결과 정렬', '기존 순위 + BM25 + RRF'],
    localRank: ['로컬 하이브리드 검색', 'Exact / BM25 / E5 / Graph', 'RRF + E5 재랭크 벡터 재사용'],
    evidence: ['질문에 필요한 근거와 출처 반환', '관련 구간 / 원문 위치 / 필요한 부분만 후속 읽기'],
    read: '읽기', save: '저장*',
    footer: '* Auto Ontology 사용 시 저장합니다. 웹 검색 전용 모드에서는 프로젝트 DB와 E5를 열지 않습니다.',
  },
};

export function architectureSpec(locale = 'en') {
  const text = copy[locale];
  const node = (id, x, y, w, h, theme, lines) => ({ id, x, y, w, h, theme, lines });
  return { locale, width: 1400, height: 1100, subtitle: text.subtitle, footer: text.footer,
    nodes: [
      node('client', 460, 124, 480, 94, 'neutral', text.client),
      node('web', 80, 290, 360, 100, 'blue', text.web),
      node('extract', 520, 290, 360, 100, 'green', text.extract),
      node('local', 960, 290, 360, 100, 'amber', text.local),
      node('browser', 80, 472, 360, 156, 'blue', text.browser),
      node('reader', 520, 472, 360, 156, 'green', text.reader),
      node('store', 960, 472, 360, 156, 'amber', text.store),
      node('webRank', 80, 710, 360, 100, 'blue', text.webRank),
      node('localRank', 960, 710, 360, 122, 'amber', text.localRank),
      node('evidence', 340, 922, 720, 108, 'neutral', text.evidence),
    ], edges: [
      { d: 'M700 218 V252 H260 V278' }, { d: 'M700 218 V278' }, { d: 'M700 252 H1140 V278' },
      { d: 'M260 390 V460' }, { d: 'M700 390 V460' }, { d: 'M1140 390 V460' },
      { d: 'M440 550 H508', label: text.read, x: 480, y: 537 },
      { d: 'M880 550 H948', dashed: true, label: text.save, x: 920, y: 537 },
      { d: 'M260 628 V698' }, { d: 'M1140 628 V698' },
      { d: 'M260 810 V872 H700 V910' }, { d: 'M1140 832 V872 H700' }, { d: 'M700 628 V910' },
    ] };
}

function svgFor(spec) {
  const themes = { neutral: '#cbd7df', blue: '#77dcea', green: '#7fb491', amber: '#ef907c' };
  const paths = spec.edges.map(edge => `<path d="${edge.d}"${edge.dashed ? ' stroke-dasharray="6 6"' : ''} marker-end="url(#arrow)"/>`).join('');
  const labels = spec.edges.filter(edge => edge.label).map(edge => `<text x="${edge.x}" y="${edge.y}" class="edge">${escape(edge.label)}</text>`).join('');
  const nodes = spec.nodes.map(node => {
    const accent = themes[node.theme];
    const lineHeight = 25;
    const first = node.y + node.h / 2 - (node.lines.length - 1) * lineHeight / 2;
    const lines = node.lines.map((line, i) => `<text x="${node.x + node.w / 2}" y="${first + i * lineHeight}" class="${i ? 'body' : 'title'}">${escape(line)}</text>`).join('');
    return `<g id="${node.id}"><circle cx="${node.x + node.w / 2}" cy="${node.y + 12}" r="5" fill="${accent}"/>${lines}</g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="1100" viewBox="0 0 1400 1100" role="img" aria-labelledby="diagram-title">
<title id="diagram-title">Google Surf MCP architecture</title>
<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10z" fill="#6c8693"/></marker></defs>
<style>text{font-family:"Segoe UI","Malgun Gothic",Arial,sans-serif;text-anchor:middle;dominant-baseline:middle;letter-spacing:0;fill:#e8edf2}.title{font-size:22px;font-weight:650}.body{font-size:18px;fill:#b5cee4}.edge{font-size:14px;fill:#8cb5cb}.heading{font-size:34px;font-weight:700;text-anchor:start}.subtitle{font-size:19px;fill:#a9c9e3;text-anchor:start}.footer{font-size:17px;fill:#a9c9e3}</style>
<rect width="1400" height="1100" fill="#14191e"/>
<text x="80" y="43" class="heading">Google Surf MCP</text>
<text x="80" y="81" class="subtitle">${escape(spec.subtitle)}</text>
<g fill="none" stroke="#405b67" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${paths}</g>${nodes}${labels}
<text x="700" y="1070" class="footer">${escape(spec.footer)}</text>
</svg>`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await mkdir(resolve(root, 'assets'), { recursive: true });
  for (const locale of Object.keys(copy)) {
    const svg = svgFor(architectureSpec(locale));
    const base = resolve(root, `assets/architecture-${locale}`);
    await writeFile(`${base}.svg`, svg);
    await sharp(Buffer.from(svg), { density: 144 }).png().toFile(`${base}.png`);
    console.log(`Rendered assets/architecture-${locale}.{svg,png}`);
  }
}
