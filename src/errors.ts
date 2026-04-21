export class FlightyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlightyError";
  }
}

export class FlightyApiError extends FlightyError {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly url?: string,
    readonly page?: number,
  ) {
    const where = url ? ` at ${url}` : "";
    const pageCtx = page !== undefined ? ` (page ${page})` : "";
    super(`Flighty API ${status}${pageCtx}${where}: ${body.slice(0, 200)}`);
    this.name = "FlightyApiError";
  }
}

/**
 * Thrown when the transport gives up on a page fetch — either because
 * `timeoutMs` elapsed, the caller aborted via `AbortSignal`, or all
 * retry attempts failed. The underlying cause is attached as `cause`.
 */
export class FlightyTransportError extends FlightyError {
  constructor(
    message: string,
    readonly url: string,
    readonly page: number,
    readonly attempts: number,
    public override readonly cause?: unknown,
  ) {
    super(`${message} at ${url} (page ${page}, attempts=${attempts})`);
    this.name = "FlightyTransportError";
  }
}
