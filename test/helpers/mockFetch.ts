/**
 * Build a `fetch` substitute that replays a sequence of pages. Each call
 * pops the next page off the queue; the N-th call receives the N-th
 * buffer. Records every request URL so tests can assert pagination
 * walked the chain as expected.
 */
export interface MockFetchResult {
  readonly fetch: typeof fetch;
  readonly calls: readonly { url: string; signal: AbortSignal | null }[];
}

export function mockFetch(pages: readonly Uint8Array[]): MockFetchResult {
  const calls: { url: string; signal: AbortSignal | null }[] = [];
  let index = 0;
  const impl: typeof fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, signal: init?.signal ?? null });
    const page = pages[index++];
    if (!page) {
      return new Response(new Uint8Array(0), {
        status: 500,
        headers: { "content-type": "application/x-protobuf" },
      });
    }
    return new Response(page, {
      status: 200,
      headers: { "content-type": "application/x-protobuf" },
    });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

/**
 * A fetch that fails a fixed number of times before succeeding. Models
 * transient network errors for retry tests.
 */
export function flakyFetch(
  pages: readonly Uint8Array[],
  options: { transientFailures: number },
): MockFetchResult {
  const calls: { url: string; signal: AbortSignal | null }[] = [];
  let failureBudget = options.transientFailures;
  let pageIndex = 0;
  const impl: typeof fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, signal: init?.signal ?? null });
    if (failureBudget > 0) {
      failureBudget -= 1;
      throw new TypeError("simulated network error");
    }
    const page = pages[pageIndex++];
    if (!page) throw new Error("mockFetch exhausted");
    return new Response(page, { status: 200 });
  }) as typeof fetch;
  return { fetch: impl, calls };
}
