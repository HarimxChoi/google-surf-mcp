import type { ErrorInfo, ErrorCode, CallToolMeta } from './types.js';
import { CaptchaError } from './search.js';

export type CallToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

export function toErrorInfo(
  e: unknown,
  ctx: { cloudMode: boolean },
): ErrorInfo {
  const message = e instanceof Error ? e.message : String(e);

  if (e instanceof CaptchaError) {
    if (ctx.cloudMode) {
      return {
        code: 'CAPTCHA_REQUIRED',
        message: 'Google CAPTCHA encountered. Cloud mode cannot solve interactively.',
        retryable: false,
        user_action: 'Run on an interactive desktop session, or refresh profile: npm run bootstrap',
      };
    }
    return {
      code: 'CAPTCHA_RECOVER_FAIL',
      message,
      retryable: false,
      user_action: 'Solve CAPTCHA in opened browser, or run: npm run bootstrap',
    };
  }

  if (/profile not initialized/i.test(message)) {
    return {
      code: 'PROFILE_MISSING',
      message,
      retryable: false,
      user_action: 'Run: npm run bootstrap',
    };
  }

  if (/timeout/i.test(message)) {
    return { code: 'NAV_TIMEOUT', message, retryable: true, retry_after_ms: 1000 };
  }

  if (/429|too many requests|rate.?limit/i.test(message)) {
    return { code: 'RATE_LIMITED', message, retryable: true, retry_after_ms: 60_000 };
  }

  if (/parser.?stale|h3.+but.+0 results/i.test(message)) {
    return {
      code: 'PARSER_STALE',
      message,
      retryable: false,
      user_action: 'Selector may need update. Check repo for newer version.',
    };
  }

  if (/private\/internal address|loopback/i.test(message)) {
    return { code: 'PRIVATE_ADDRESS', message, retryable: false };
  }

  return { code: 'INTERNAL', message: message.slice(0, 500), retryable: false };
}

const FENCE_BEGIN = '--- BEGIN UNTRUSTED CONTENT ---';
const FENCE_END = '--- END UNTRUSTED CONTENT ---';

export function fenceUntrustedContent(content: string): string {
  return `\n${FENCE_BEGIN}\n${content}\n${FENCE_END}\n`;
}

export function formatToolResponse(
  data: Record<string, unknown> | null,
  error?: ErrorInfo,
  meta?: CallToolMeta,
): CallToolResult {
  if (error) {
    const humanText = `Error [${error.code}]: ${error.message}`
      + (error.user_action ? `\nAction: ${error.user_action}` : '')
      + (error.retry_after_ms ? `\nRetry after: ${error.retry_after_ms}ms` : '');

    return {
      content: [{ type: 'text', text: humanText }],
      structuredContent: { error, ...(meta ? { meta } : {}) },
      isError: true,
    };
  }

  const payload = meta ? { ...data, meta } : data ?? {};
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as Record<string, unknown>,
  };
}

export function isErrorCode(s: string): s is ErrorCode {
  return [
    'CAPTCHA_REQUIRED', 'CAPTCHA_RECOVER_FAIL', 'BLOCKED_BY_GOOGLE',
    'NAV_TIMEOUT', 'EXTRACT_FAILED', 'PRIVATE_ADDRESS', 'PROFILE_MISSING',
    'PARSER_STALE', 'RATE_LIMITED', 'INTERNAL',
  ].includes(s);
}
