<img src="./assets/icon256.png" width="128" align="right" alt="google-surf-mcp"/>

# google-surf-mcp

[English](./README.md) | 한국어

[![npm version](https://img.shields.io/npm/v/google-surf-mcp)](https://www.npmjs.com/package/google-surf-mcp)
[![npm downloads](https://img.shields.io/npm/dm/google-surf-mcp)](https://www.npmjs.com/package/google-surf-mcp)
[![ci](https://github.com/HarimxChoi/google-surf-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/HarimxChoi/google-surf-mcp/actions/workflows/ci.yml)
[![google-surf-mcp MCP server](https://glama.ai/mcp/servers/HarimxChoi/google-surf-mcp/badges/score.svg)](https://glama.ai/mcp/servers/HarimxChoi/google-surf-mcp)

![demo](./assets/demo.gif)

> 실제 사용은 기본 **headless**로 동작합니다 (Chrome 창 안 보임). 영상처럼 보이게 하려면 `SURF_HEADLESS=false` 설정

무료 Google 검색 MCP가 전부 안 돼서 직접 만든 MCP

MCP 1개가 3개 역할: 검색 + URL fetcher + 학술 페이퍼 추출

✅ 실제로 작동 (무료 MCP 6개 테스트, 전부 fail)  
✅ 1개 MCP로 검색 + 본문 + 학술 PDF 추출 (기존: search + fetch + 학술검색 MCP 3개 조합)  
✅ 학술 PDF 인라인 추출: arxiv, biorxiv, Nature, OpenReview, NeurIPS, JMLR, PMLR, Springer, PubMed (PMC 경유)  
✅ `search_extract` 기본 abstract 모드 (~1500자/결과, 토큰 절약), `mode="full"`로 본문 전체  
✅ 스폰서 광고 + 지식 패널 자동 제거 (geometric verification, 텍스트 매칭 아님)  
✅ CAPTCHA 자동 복구 4모드: OS 알림 (기본) / `SURF_HEADLESS=false` / `SURF_REMOTE_DEBUG` / `SURF_CLOUD_MODE` (fail-fast)  
✅ API 키 / 프록시 / 솔버 X  

도구 5개: `search` / `search_parallel` / `extract` / `search_extract` / `health`

## How

MCP 클라이언트에 설정시 Google 검색 도구로 사용 가능, anti-bot은 warm Chrome profile + stealth로 처리  
CAPTCHA는 사람이 직접 함 (프로필 평판 유지 → 지속가능한 운영)

첫 호출 시 프로필 자동 부트스트랩. 로컬 전용 — headless / 서버리스 환경은 `SURF_CLOUD_MODE=true` (CAPTCHA fail-fast, 워커 풀 비활성)

## Numbers

| | 결과 |
|---|---|
| sequential | ~1.5s/query (첫 호출은 ~4s, 셋업 포함) |
| parallel x4 | ~1.5s wall (첫 호출은 ~9s, pool warm 포함) |
| parallel x10 | ~4.5s wall |
| search_extract x5 (abstract, 기본) | ~3s wall |
| search_extract x5 (full) | ~5s wall (검색 + 5개 병렬 추출) |

워크스테이션 1Gbps 환경에서 측정

## Stack

- Playwright + 영구 Chrome 프로필
- `playwright-extra` stealth (cascade fallback tier)
- Multi-strategy SERP parser + geometric verification (sponsored / knowledge_panel / related 드롭)
- PDF는 `unpdf`, HTML 본문은 Mozilla Readability + Turndown
- 이미지 / 미디어 / 폰트 차단 (속도)
- 첫 호출 자동 부트스트랩, pool warm 3회 실패 시 single-context로 폴백

## Install

Node 18+, 시스템에 Google Chrome (또는 Chromium) 필요

```bash
npx google-surf-mcp   # 실제 MCP, 클라이언트 config에 등록
```

첫 호출 시 프로필 자동 워밍 (Chrome 창이 잠깐 보일 수 있음)

또는 로컬 클론:

```bash
git clone https://github.com/HarimxChoi/google-surf-mcp
cd google-surf-mcp
npm install
```

자동 부트스트랩 실패 시 (드묾) 수동 실행:
```bash
npm run bootstrap
```

경로 오버라이드:
```bash
CHROME_PATH=/path/to/chrome SURF_TZ=America/New_York npm run bootstrap
```

## Claude Code에서 사용

`~/.claude.json`에 이거 붙여넣기:

```json
{
  "mcpServers": {
    "google-surf": {
      "command": "npx",
      "args": ["-y", "google-surf-mcp"]
    }
  }
}
```

Claude Code 재시작

다른 MCP 클라이언트도 같은 JSON 구조 그대로 (config 파일 경로만 다름)

로컬 클론 사용 시:
```json
{
  "mcpServers": {
    "google-surf": {
      "command": "node",
      "args": ["/abs/path/to/google-surf-mcp/build/index.js"]
    }
  }
}
```

## Tools

- `search(query, limit?)` - 단일 검색, ~1.5초. title / url / snippet 반환. 스폰서 광고 + 지식 패널 자동 제거 (응답에 `dropped` 카운트 + `dropped_reasons` 포함). 결과 24h 캐시 (`SURF_CACHE_TTL_SEARCH_MS=0`으로 우회)
- `search_parallel(queries[], limit?)` - 4-워커 풀, 호출당 최대 10개 쿼리
- `extract(url, max_chars?, mode?)` - URL 가져와서 본문 반환
  - `mode="full"` (기본): 본문 전체. HTML은 Readability, PDF는 `unpdf`
  - `mode="abstract"`: ~1500자 요약 (PDF 1페이지 또는 HTML meta description). 본문 가져오기 전 관련성 판단용
  - `mode="metadata"`: PDF 페이지 수만
  - 응답: `content`, `title`, `excerpt`, `length`, `is_pdf`, `page_count`, `extraction_quality`. 실패는 `{ error }` 반환, throw 안 함
- `search_extract(query, limit?, max_chars?, mode?)` - 검색 + 병렬 추출 한 번에. 기본 `mode="abstract"`는 SERP 결과에 ~1500자 요약 붙여서 반환 (저렴한 트리아지). 실제 본문 필요 시 `mode="full"` (느림, 토큰 많이 씀)
- `health()` - 서버 상태: cascade 모드, rate-limiter 사용량, 캐시 크기, 설정. 검색이 실패하기 시작하면 호출

## Env vars

| 변수 | 기본값 | 설명 |
|---|---|---|
| `CHROME_PATH` | 자동 감지 | Chrome 바이너리 절대 경로 |
| `SURF_PROFILE_ROOT` | `~/.google-surf-mcp` | warm 프로필 위치 |
| `SURF_LOCALE` | `en-US` | 브라우저 로케일 |
| `SURF_TZ` | 시스템 tz | 예: `America/New_York` |
| `SURF_HEADLESS` | `true` | `false`로 설정 시 Chrome 보이게 동작 (데모 / 디버깅용). `false`면 CAPTCHA 복구 시 OS 알림 생략 (사용자가 이미 보고 있음). |
| `SURF_REMOTE_DEBUG` | `false` | headless 서버 + 원격 DevTools 환경에서 `true`. CAPTCHA 발생 시 DevTools 포트 안내 후 throw, 별도 창 안 띄움. 로컬 머신에서 SSH 포트포워드 + `chrome://inspect`로 풀고 재시도. |
| `SURF_IDLE_CLOSE_MS` | `30000` | sequential ctx와 pool을 idle 후 닫는 ms. `0`이면 비활성화. 낮으면 빠른 정리, 높으면 띄엄띄엄 호출에 캐시 유지. |
| `SURF_ALLOW_PRIVATE` | `false` | `true`로 설정 시 `extract`가 사설/loopback 주소(`localhost`, `127.0.0.1`, `10.x`, `192.168.x`, `169.254.x` 등) 접근 허용. 기본은 SSRF 차단으로 막음. |
| `SURF_CLOUD_MODE` | `false` | headless/서버리스 모드: TLS 우회 + `--no-sandbox` + `--disable-dev-shm-usage` + 워커 풀 비활성 + CAPTCHA fail-fast |
| `SURF_CASCADE_DISABLED` | `false` | 3-tier cascade 대신 단일 stealth 모드로 고정 |
| `SURF_USE_STEALTH` | `true` | 초기 stealth tier — `SURF_CASCADE_DISABLED=true`일 때만 적용 |
| `SURF_HUMANLIKE_MODE` | `off` | `off` / `background` / `inline` — opt-in humanlike 브라우징 동작 |
| `SURF_RATE_LIMIT_PER_MIN` | `10` | 분당 Google 요청 내부 상한 |
| `SURF_CACHE_TTL_SEARCH_MS` | `86400000` | search 캐시 TTL (24h); `0`이면 캐시 비활성화 |
| `SURF_CACHE_MAX_ENTRIES` | `1000` | 캐시 namespace별 LRU 상한 |
| `SURF_CACHE_ROOT` | `<profile>/cache` | 캐시 디렉토리 |
| `SURF_INSECURE_TLS` | `=SURF_CLOUD_MODE` | `--ignore-certificate-errors` (cloud 모드에서 자동 on) |
| `SURF_NO_SANDBOX` | `=SURF_CLOUD_MODE` | `--no-sandbox` (cloud 모드에서 자동 on) |
| `SURF_TELEMETRY` | `false` | `true`로 설정 시 jsonl 이벤트 로깅 활성화 (검색 결과, 캐시 hit/miss, tool 에러, parser staleness 기록). self-healing 파이프라인의 입력으로 사용. 기본 OFF. |
| `SURF_TELEMETRY_ROOT` | `<profile>/telemetry` | jsonl 파일 디렉토리. UTC 기준 날짜별 파일 1개 (`YYYY-MM-DD.jsonl`). |
## Troubleshooting

- CAPTCHA 4모드 (env로 자동 결정):
  - 기본 (로컬 데스크탑): OS 알림 발송, headed Chrome 열림, 사람이 풀면 자동 재시도
  - `SURF_HEADLESS=false`: headed Chrome 열림, 알림 생략
  - `SURF_REMOTE_DEBUG=true`: DevTools 포트 안내 출력, 로컬에서 `chrome://inspect`로 attach해서 풀기
  - `SURF_CLOUD_MODE=true`: `CAPTCHA_REQUIRED` 에러로 fail-fast
- "Chrome not found": Chrome 설치 또는 `CHROME_PATH` 설정
- 셀렉터 깨짐: Google이 클래스명 바꿈. v0.4.5+는 multi-strategy parser + 일일 self-healing 워크플로우로 draft PR 자동 생성 (사람 리뷰 필수)
- SSRF: `extract`는 기본적으로 `localhost`, 사설 IP, AWS metadata 차단. `SURF_ALLOW_PRIVATE=true`로 우회

## Changelog

[CHANGELOG.md](./CHANGELOG.md)

## License

MIT
