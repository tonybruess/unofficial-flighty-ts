/**
 * Build a `fetch` substitute that replays a sequence of pages. Each call
 * pops the next page off the queue; the N-th call receives the N-th
 * buffer. Records every request URL so tests can assert pagination
 * walked the chain as expected.
 */
export interface MockCall {
  readonly url: string;
  readonly signal: AbortSignal | null;
  readonly method: string;
  /** Raw request body as sent (empty for page fetches). */
  readonly body: Uint8Array;
}

export interface MockFetchResult {
  readonly fetch: typeof fetch;
  readonly calls: readonly MockCall[];
}

export interface MockFetchOptions {
  /** Status when the page queue is exhausted (default 500). */
  readonly exhaustedStatus?: number;
}

export function mockFetch(
  pages: readonly Uint8Array[],
  options: MockFetchOptions = {},
): MockFetchResult {
  const calls: MockCall[] = [];
  let index = 0;
  const impl: typeof fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body instanceof Uint8Array ? init.body : new Uint8Array(0);
    calls.push({ url, signal: init?.signal ?? null, method: init?.method ?? "GET", body });
    const page = pages[index++];
    if (!page) {
      return new Response(new Uint8Array(0), {
        status: options.exhaustedStatus ?? 500,
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
  const calls: MockCall[] = [];
  let failureBudget = options.transientFailures;
  let pageIndex = 0;
  const impl: typeof fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body instanceof Uint8Array ? init.body : new Uint8Array(0);
    calls.push({ url, signal: init?.signal ?? null, method: init?.method ?? "GET", body });
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
