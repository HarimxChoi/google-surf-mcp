export interface SearchResult {
  title: string;
  url: string;
  description: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  elapsed_ms: number;
}

export interface ScoredSearchHit extends SearchResult {
  rank: number;
  source_domain: string;
  score: ResultScore;
  bbox?: BBox;
}

export interface ParseSignals {
  h3Count: number;
  externalLinkCount: number;
  hveidCount: number;
  classTokenSize: number;
  layoutSignature: string;
}

export interface ParserStrategy {
  id: string;
  blockSelector: string;
  snippetSelector: string;
  adFilter: string;
  description: string;
}

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GeometricVerification {
  index: number;
  rect: BBox;
  signals: {
    inOrganicRegion: boolean;
    overlapsAdRegion: boolean;
    overlapsRightSidebar: boolean;
    matchesElementFromPoint: boolean;
    hasH3: boolean;
    hasExternalLink: boolean;
  };
  confidence: number;
}

export type ResultClassification =
  | 'organic'
  | 'sponsored'
  | 'knowledge_panel'
  | 'related'
  | 'unknown';

export interface ResultScore {
  overall: number;
  geometric: number;
  structural: number;
  ad_likelihood: number;
  classification: ResultClassification;
  confidence: 'low' | 'medium' | 'high';
}

export type FaultType =
  | 'selector_broken'
  | 'blocked'
  | 'rate_limited'
  | 'network_error'
  | 'unknown';

export interface FaultClassification {
  type: FaultType;
  signals: {
    resultsLen: number;
    h3Count: number;
    responseStatus: number;
    responseTimeMs: number;
    url: string;
    geometricConfidence?: number;
  };
}

export interface RecoveryAction {
  type:
    | 'retry_with_strategy'
    | 'backoff'
    | 'alert_only'
    | 'no_action';
  params?: Record<string, unknown>;
}

export type ErrorCode =
  | 'CAPTCHA_REQUIRED'
  | 'CAPTCHA_RECOVER_FAIL'
  | 'BLOCKED_BY_GOOGLE'
  | 'NAV_TIMEOUT'
  | 'EXTRACT_FAILED'
  | 'PRIVATE_ADDRESS'
  | 'PROFILE_MISSING'
  | 'PARSER_STALE'
  | 'RATE_LIMITED'
  | 'INTERNAL';

export interface ErrorInfo {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  retry_after_ms?: number;
  user_action?: string;
}

export interface CallToolMeta {
  strategy?: string;
  confidence?: number;
  cache?: 'hit' | 'miss';
  resource_uri?: string;
  fetched_at?: string;
  stealth_mode?: 'on' | 'off';
}

export interface BehaviorParams {
  mouse: { steps: [number, number]; speed: number; overshoot: number };
  typing: { delay: [number, number] };
  delays: {
    afterSearch: [number, number];
    betweenActions: [number, number];
  };
}
