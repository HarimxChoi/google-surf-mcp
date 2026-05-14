// On timeout, optionally invoke cleanup() so the underlying long-running op
// cannot leak into the next request sharing the same ctx/page.
export async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
  cleanup?: () => Promise<void>,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      reject(new Error(`${label} timeout after ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([p, timeoutPromise]);
  } catch (e) {
    if (timedOut && cleanup) await cleanup().catch(() => {});
    throw e;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

