import { concat, lengthDelimited } from "./encode.js";
import { FlightyApiError, FlightyError, FlightyTransportError } from "./errors.js";
import {
  decodeEntities,
  decodeSearchResponse,
  decodeSubscribeResponse,
  extractNextUrl,
} from "./parse.js";
import type {
  AircraftType,
  Airline,
  Airport,
  Connection,
  Entity,
  Flight,
  FlightDetails,
  FlightSearchResult,
  MetropolitanArea,
  ResolvedFlight,
  SyncResult,
  Ticket,
  UserProfile,
} from "./types.js";

export interface FlightyClientOptions {
  /** HS512 JWT bearer token from CloudKit `previousTokens[1]`. */
  readonly bearer: string;
  /** ES256 JWT from `Flighty.app/Contents/Info.plist`. */
  readonly buildToken: string;
  /** Override `fetch` (for tests or custom transports). */
  readonly fetch?: typeof fetch;
  /** Override base URL. Defaults to `https://api.flightyapp.com`. */
  readonly baseUrl?: string;
  /**
   * Safety cap on pages per sync call. Default 500. Hitting the cap
   * with a `nextURL` still present throws from `sync()` and sets
   * `SyncResult.truncated = true` on `stream()`.
   */
  readonly maxPages?: number;
  /** `X-Flighty-Locale` header. Defaults to `en_US`. */
  readonly locale?: string;
  /**
   * Resume from a cursor saved on a previous run. `null` is accepted
   * so callers can forward `SyncResult.cursor` unchanged.
   */
  readonly cursor?: string | null;
  /**
   * Restrict to flights the authed user actually flew —
   * `userId === myUserId && isMyFlight`. Drops friends' flights AND
   * calendar-imports the user hasn't claimed. Tickets and connections
   * are scoped too; shared catalogs are untouched. Default `false`.
   */
  readonly onlyMine?: boolean;
  /**
   * Keep tombstoned (deleted) flights and connections in the result.
   * Default `false` — matches the official app.
   */
  readonly includeDeleted?: boolean;
  /**
   * Per-attempt fetch timeout in milliseconds. Default 30_000. Retries
   * get a fresh timer; `0` disables.
   */
  readonly timeoutMs?: number;
  /** Retry policy for transient transport failures. */
  readonly retry?: RetryOptions;
  /**
   * Aborts in-flight and pending retries. `sync()` / `stream()` reject
   * with {@link FlightyTransportError} carrying the reason as `cause`.
   */
  readonly signal?: AbortSignal;
}

export interface RetryOptions {
  /** Retries after the initial fetch. Default 2 (3 attempts total). */
  readonly retries?: number;
  /** Initial backoff in milliseconds. Default 500. */
  readonly backoffMs?: number;
  /** Backoff multiplier between attempts. Default 2. */
  readonly backoffFactor?: number;
  /** Backoff ceiling in milliseconds. Default 8_000. ±20% jitter applied. */
  readonly maxBackoffMs?: number;
}

export interface SyncOptions {
  /** Overrides the client-level `cursor` for this call. `null` accepted. */
  readonly cursor?: string | null;
  /** Overrides the client-level `onlyMine`. */
  readonly onlyMine?: boolean;
  /** Overrides the client-level `includeDeleted`. */
  readonly includeDeleted?: boolean;
  /** Overrides the client-level `signal`. */
  readonly signal?: AbortSignal;
}

/** Search for scheduled flights between two airports on a given date. */
export interface RouteSearchOptions {
  /** Departure airport id (`Airport.id`, not IATA). */
  readonly departureAirportId: string;
  /** Arrival airport id (`Airport.id`, not IATA). */
  readonly arrivalAirportId: string;
  /**
   * Departure date as `YYYY-MM-DD`, in the departure airport's local
   * calendar (what the app sends when you pick a day in the picker).
   */
  readonly date: string;
  /** Overrides the client-level `signal`. */
  readonly signal?: AbortSignal;
}

export interface SubscribeOptions {
  /**
   * `true` (default) marks the flight as one you're flying — it lands in
   * "My Flights" with `isMyFlight = true`. `false` tracks it without
   * claiming it (the app's "just watching" mode).
   */
  readonly isPassenger?: boolean;
  /** Overrides the client-level `signal`. */
  readonly signal?: AbortSignal;
}

const DEFAULT_BASE_URL = "https://api.flightyapp.com";
const DEFAULT_MAX_PAGES = 500;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 500;
const DEFAULT_BACKOFF_FACTOR = 2;
const DEFAULT_MAX_BACKOFF_MS = 8_000;
const SYNC_PATH = "/v1/sync/full";
const SEARCH_PATH = "/v1/search";
const EMPTY_BODY = new Uint8Array(0);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class FlightyClient {
  readonly #bearer: string;
  readonly #buildToken: string;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;
  readonly #maxPages: number;
  readonly #locale: string;
  readonly #onlyMine: boolean;
  readonly #includeDeleted: boolean;
  readonly #timeoutMs: number;
  readonly #retry: Required<RetryOptions>;
  readonly #signal: AbortSignal | undefined;
  /** The authenticated user's id, decoded from the bearer's `sub` claim. */
  readonly myUserId: string;
  /**
   * Latest cursor Flighty returned. Updated as pages stream in. Persist it
   * between processes to resume or delta-sync later.
   */
  cursor: string | null;

  constructor(options: FlightyClientOptions) {
    if (!options.bearer) throw new FlightyError("bearer is required");
    if (!options.buildToken) throw new FlightyError("buildToken is required");
    this.#bearer = options.bearer;
    this.#buildToken = options.buildToken;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.#maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    this.#locale = options.locale ?? "en_US";
    this.cursor = options.cursor ?? null;
    this.#onlyMine = options.onlyMine ?? false;
    this.#includeDeleted = options.includeDeleted ?? false;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#signal = options.signal;
    this.#retry = {
      retries: options.retry?.retries ?? DEFAULT_RETRIES,
      backoffMs: options.retry?.backoffMs ?? DEFAULT_BACKOFF_MS,
      backoffFactor: options.retry?.backoffFactor ?? DEFAULT_BACKOFF_FACTOR,
      maxBackoffMs: options.retry?.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
    };
    this.myUserId = decodeBearerSub(options.bearer);
  }

  /**
   * Fetch every page and materialize a deduped, current-state view.
   * Entities are coalesced by id (latest wire revision wins); onlyMine
   * and includeDeleted apply AFTER dedupe so late-page tombstones and
   * `isMyFlight` flips override earlier revisions. Throws if `maxPages`
   * is hit with more pages to go.
   */
  async sync(options?: SyncOptions): Promise<SyncResult> {
    const airports = new Map<string, Airport>();
    const airlines = new Map<string, Airline>();
    const aircraftTypes = new Map<string, AircraftType>();
    const metropolitanAreas = new Map<string, MetropolitanArea>();
    const userProfiles = new Map<string, UserProfile>();
    const flightsById = new Map<string, Flight>();
    const connectionsById = new Map<string, Connection>();
    const ticketsById = new Map<string, Map<string, Ticket>>();

    const { pagesFetched, truncated } = await this.#drain(options, (entity) => {
      switch (entity.kind) {
        case "airport":
          airports.set(entity.id, entity);
          return;
        case "airline":
          airlines.set(entity.id, entity);
          return;
        case "aircraftType":
          aircraftTypes.set(entity.id, entity);
          return;
        case "metropolitanArea":
          metropolitanAreas.set(entity.id, entity);
          return;
        case "userProfile":
          userProfiles.set(entity.id, entity);
          return;
        case "flight":
          flightsById.set(entity.id, entity);
          return;
        case "connection":
          connectionsById.set(entity.id, entity);
          return;
        case "ticket": {
          // Ticket identity is (flightId, userId); inner map keyed by
          // userId so later revisions overwrite instead of accumulating.
          let bucket = ticketsById.get(entity.id);
          if (!bucket) {
            bucket = new Map();
            ticketsById.set(entity.id, bucket);
          }
          bucket.set(entity.userId, entity);
          return;
        }
      }
    });

    if (truncated) {
      throw new FlightyError(
        `sync truncated at ${pagesFetched} pages (maxPages=${this.#maxPages}). ` +
          `Increase maxPages or call stream() for truncation-tolerant iteration.`,
      );
    }

    const onlyMine = options?.onlyMine ?? this.#onlyMine;
    const includeDeleted = options?.includeDeleted ?? this.#includeDeleted;

    const flights: Flight[] = [];
    for (const f of flightsById.values()) {
      if (!includeDeleted && f.deletedAt !== null) continue;
      if (onlyMine && !(f.userId === this.myUserId && f.isMyFlight)) continue;
      flights.push(f);
    }
    const connections: Connection[] = [];
    for (const c of connectionsById.values()) {
      if (!includeDeleted && c.deletedAt !== null) continue;
      if (onlyMine && c.userId !== this.myUserId) continue;
      connections.push(c);
    }
    const tickets = new Map<string, Ticket[]>();
    for (const [flightId, bucket] of ticketsById) {
      const kept: Ticket[] = [];
      for (const t of bucket.values()) {
        if (onlyMine && t.userId !== this.myUserId) continue;
        kept.push(t);
      }
      if (kept.length > 0) tickets.set(flightId, kept);
    }

    const onwardByFlightId = indexConnections(connections, (c) => c.inboundFlightId);
    const inboundByFlightId = indexConnections(connections, (c) => c.outboundFlightId);

    return {
      flights,
      airports,
      airlines,
      aircraftTypes,
      metropolitanAreas,
      userProfiles,
      tickets,
      connections,
      onwardByFlightId,
      inboundByFlightId,
      myUserId: this.myUserId,
      cursor: this.cursor,
      pagesFetched,
      truncated,
    };
  }

  /**
   * Find scheduled flights between two airports on a date. Flighty returns
   * one row per marketing flight number, so a codeshared departure appears
   * several times with distinct ids — pick the carrier you booked with and
   * pass its `id` to {@link subscribeFlight}. Airport ids come from
   * `sync().airports` (match on `iata`).
   */
  async search(options: RouteSearchOptions): Promise<FlightSearchResult[]> {
    if (!options.departureAirportId) throw new FlightyError("departureAirportId is required");
    if (!options.arrivalAirportId) throw new FlightyError("arrivalAirportId is required");
    if (!DATE_RE.test(options.date)) {
      throw new FlightyError(`date must be YYYY-MM-DD, got ${JSON.stringify(options.date)}`);
    }
    const body = encodeRouteSearch(options);
    const buf = await this.#request(`${this.#baseUrl}${SEARCH_PATH}`, body, options.signal);
    return decodeSearchResponse(buf);
  }

  /**
   * Add a flight to the authed account and return its full record. This
   * is how the app "gets" a flight — there is no read-only lookup by id —
   * so calling it has the side effect of tracking the flight (it will
   * appear in the next `sync()`). Subscribing to an already-tracked flight
   * is idempotent. The returned record inlines airports and airlines so
   * it's usable without a sync.
   */
  async subscribeFlight(flightId: string, options?: SubscribeOptions): Promise<FlightDetails> {
    if (!flightId) throw new FlightyError("flightId is required");
    const isPassenger = options?.isPassenger ?? true;
    // Query string mirrors the app byte-for-byte, including the bare `source`.
    const url =
      `${this.#baseUrl}/v1/flight/${encodeURIComponent(flightId)}/subscribe` +
      `?is_passenger=${isPassenger}&source`;
    const buf = await this.#request(url, EMPTY_BODY, options?.signal);
    const flight = decodeSubscribeResponse(buf);
    if (!flight) throw new FlightyError(`subscribe returned no flight for ${flightId}`);
    return flight;
  }

  /** Single-shot POST with the same retry/timeout/abort policy as page fetches. */
  #request(url: string, body: Uint8Array, signal: AbortSignal | undefined): Promise<Uint8Array> {
    return this.#fetchPage(url, 1, signal ?? this.#signal, body);
  }

  /**
   * Yield entities as pages arrive. Low-memory counterpart to `sync()`:
   * applies the same filters but can't dedupe — the latest revision of
   * an id wins eventually, but earlier revisions may have already been
   * yielded. Callers that need point-in-time state should use `sync()`.
   */
  async *stream(options?: SyncOptions): AsyncGenerator<Entity, void, void> {
    const filter = this.#entityFilter(options);
    for await (const entity of this.#pages(options, filter)) yield entity;
  }

  async #drain(
    options: SyncOptions | undefined,
    onEntity: (entity: Entity) => void,
  ): Promise<{ pagesFetched: number; truncated: boolean }> {
    // Unfiltered so sync() sees every revision and its post-dedupe
    // filter can honor late-page tombstones / isMyFlight flips.
    let pagesFetched = 0;
    let truncated = false;
    const iter = this.#pages(options, acceptAll);
    while (true) {
      const step = await iter.next();
      if (step.done) {
        const result = step.value;
        if (result) ({ pagesFetched, truncated } = result);
        break;
      }
      onEntity(step.value);
    }
    return { pagesFetched, truncated };
  }

  async *#pages(
    options: SyncOptions | undefined,
    filter: (entity: Entity) => boolean,
  ): AsyncGenerator<Entity, { pagesFetched: number; truncated: boolean }, void> {
    const startCursor = options?.cursor ?? this.cursor;
    const signal = options?.signal ?? this.#signal;
    let url: string | null = this.#startUrl(startCursor);
    let pages = 0;
    const seenFingerprints = new Set<string>();
    const startFp = cursorFingerprint(startCursor);
    if (startFp) seenFingerprints.add(startFp);
    while (url && pages < this.#maxPages) {
      pages += 1;
      const body = await this.#fetchPage(url, pages, signal);
      for (const entity of decodeEntities(body)) {
        if (!filter(entity)) continue;
        yield entity;
      }
      const next = extractNextUrl(body);
      if (next) this.cursor = cursorFromUrl(next);
      if (!next || next === url) return { pagesFetched: pages, truncated: false };
      // Tail pages keep ticking the `usersubscription` heartbeat so
      // raw nextURLs never repeat. Fingerprint the non-heartbeat cursor
      // fields and bail on the first repeat.
      const nextFp = cursorFingerprint(cursorFromUrl(next));
      if (nextFp && seenFingerprints.has(nextFp)) {
        return { pagesFetched: pages, truncated: false };
      }
      if (nextFp) seenFingerprints.add(nextFp);
      url = next;
    }
    return { pagesFetched: pages, truncated: url !== null };
  }

  #entityFilter(options: SyncOptions | undefined): (entity: Entity) => boolean {
    const onlyMine = options?.onlyMine ?? this.#onlyMine;
    const includeDeleted = options?.includeDeleted ?? this.#includeDeleted;
    return (entity) => {
      if (onlyMine && !isMineEntity(entity, this.myUserId)) return false;
      if (!includeDeleted && isTombstone(entity)) return false;
      return true;
    };
  }

  #startUrl(cursor: string | null): string {
    const base = `${this.#baseUrl}${SYNC_PATH}`;
    return cursor ? `${base}?token=${encodeURIComponent(cursor)}` : base;
  }

  async #fetchPage(
    url: string,
    page: number,
    callerSignal: AbortSignal | undefined,
    body: Uint8Array = EMPTY_BODY,
  ): Promise<Uint8Array> {
    const totalAttempts = this.#retry.retries + 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      if (callerSignal?.aborted) {
        throw new FlightyTransportError(
          "aborted by caller",
          url,
          page,
          attempt - 1,
          callerSignal.reason,
        );
      }
      try {
        return await this.#fetchOnce(url, page, callerSignal, body);
      } catch (err) {
        lastError = err;
        // Caller aborted mid-attempt: wrap the reason and stop retrying.
        if (callerSignal?.aborted) {
          throw new FlightyTransportError(
            "aborted by caller",
            url,
            page,
            attempt,
            callerSignal.reason,
          );
        }
        if (!isRetryable(err)) throw err;
        if (attempt === totalAttempts) break;
        const delay = computeBackoff(this.#retry, attempt);
        await sleep(delay, callerSignal);
      }
    }
    throw new FlightyTransportError(
      "exhausted retries",
      url,
      page,
      totalAttempts,
      lastError,
    );
  }

  async #fetchOnce(
    url: string,
    page: number,
    callerSignal: AbortSignal | undefined,
    body: Uint8Array,
  ): Promise<Uint8Array> {
    const controller = new AbortController();
    const abortFromCaller = () =>
      controller.abort(callerSignal?.reason ?? new Error("aborted"));
    if (callerSignal) {
      if (callerSignal.aborted) abortFromCaller();
      else callerSignal.addEventListener("abort", abortFromCaller, { once: true });
    }
    const timer =
      this.#timeoutMs > 0
        ? setTimeout(() => controller.abort(new Error(`timeout after ${this.#timeoutMs}ms`)), this.#timeoutMs)
        : null;
    try {
      const res = await this.#fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#bearer}`,
          "X-Flighty-Build-Token": this.#buildToken,
          "X-Flighty-Locale": this.#locale,
          "Content-Type": "application/x-protobuf",
          Accept: "application/x-protobuf",
        },
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new FlightyApiError(res.status, text, url, page);
      }
      return new Uint8Array(await res.arrayBuffer());
    } finally {
      if (timer !== null) clearTimeout(timer);
      if (callerSignal) callerSignal.removeEventListener("abort", abortFromCaller);
    }
  }
}

// SearchRequestProto: field 2 = route query { 1: { 1: { 1: depId } },
// 2: { 1: { 1: arrId } } }, field 3 = date, field 4 = "ROUTE". Field 1
// is unused in captures (presumably the flight-number variant).
function encodeRouteSearch(options: RouteSearchOptions): Uint8Array {
  const airportRef = (id: string) => lengthDelimited(1, lengthDelimited(1, id));
  const route = concat([
    lengthDelimited(1, airportRef(options.departureAirportId)),
    lengthDelimited(2, airportRef(options.arrivalAirportId)),
  ]);
  return concat([
    lengthDelimited(2, route),
    lengthDelimited(3, options.date),
    lengthDelimited(4, "ROUTE"),
  ]);
}

function acceptAll(_entity: Entity): boolean {
  return true;
}

function isRetryable(err: unknown): boolean {
  // 5xx + 429 retry; 4xx fails fast; anything else is a network-level
  // TypeError/DOMException from fetch and treated as transient.
  if (err instanceof FlightyApiError) return err.status >= 500 || err.status === 429;
  if (err instanceof FlightyError) return false;
  return true;
}

function computeBackoff(retry: Required<RetryOptions>, attempt: number): number {
  const raw = retry.backoffMs * retry.backoffFactor ** (attempt - 1);
  const capped = Math.min(raw, retry.maxBackoffMs);
  // ±20% jitter to avoid synchronized retries.
  const jitter = capped * 0.2 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function resolveFlight(flight: Flight, sync: SyncResult): ResolvedFlight {
  const aircraftTypeId = flight.aircraft?.aircraftTypeId ?? null;
  return {
    ...flight,
    airline: flight.airlineId ? (sync.airlines.get(flight.airlineId) ?? null) : null,
    departureAirport: flight.departureAirportId
      ? (sync.airports.get(flight.departureAirportId) ?? null)
      : null,
    arrivalAirport: flight.arrivalAirportId
      ? (sync.airports.get(flight.arrivalAirportId) ?? null)
      : null,
    aircraftType: aircraftTypeId ? (sync.aircraftTypes.get(aircraftTypeId) ?? null) : null,
    tickets: sync.tickets.get(flight.id) ?? [],
    isMine: flight.userId === sync.myUserId,
    onwardConnections: sync.onwardByFlightId.get(flight.id) ?? [],
    inboundConnections: sync.inboundByFlightId.get(flight.id) ?? [],
  };
}

function indexConnections(
  connections: readonly Connection[],
  key: (c: Connection) => string,
): Map<string, Connection[]> {
  const map = new Map<string, Connection[]>();
  for (const c of connections) {
    const k = key(c);
    const bucket = map.get(k);
    if (bucket) bucket.push(c);
    else map.set(k, [c]);
  }
  return map;
}

function decodeBearerSub(bearer: string): string {
  const parts = bearer.split(".");
  if (parts.length !== 3) throw new FlightyError("bearer is not a JWT");
  try {
    const payload = JSON.parse(decodeBase64Url(parts[1]!)) as { sub?: unknown };
    if (typeof payload.sub !== "string" || !payload.sub) {
      throw new FlightyError("bearer missing `sub` claim");
    }
    return payload.sub;
  } catch (err) {
    if (err instanceof FlightyError) throw err;
    throw new FlightyError("bearer payload is not valid JSON");
  }
}

function decodeBase64Url(input: string): string {
  const pad = input.length % 4 === 2 ? "==" : input.length % 4 === 3 ? "=" : "";
  return decodeBase64(input.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

function decodeBase64(input: string): string {
  // `atob` returns a binary string; re-decode as UTF-8 for JSON.parse.
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function cursorFromUrl(url: string): string | null {
  const match = /[?&]token=([^&]+)/.exec(url);
  return match ? decodeURIComponent(match[1]!) : null;
}

// Cursor is base64(JSON) of per-entity sub-cursors + heartbeat fields
// that tick every response. Fingerprint strips heartbeats so cycle
// detection sees "same real state" across pages; unparseable → null.
const HEARTBEAT_CURSOR_FIELDS = new Set(["usersubscription"]);

function cursorFingerprint(cursor: string | null): string | null {
  if (!cursor) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(decodeBase64(cursor));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const keys = Object.keys(payload)
    .filter((k) => !HEARTBEAT_CURSOR_FIELDS.has(k))
    .sort();
  return JSON.stringify(keys.map((k) => [k, payload[k]]));
}

// Only flights and connections carry `deletedAt`; tickets follow their
// flight, and shared catalogs are never soft-deleted.
function isTombstone(entity: Entity): boolean {
  return (
    (entity.kind === "flight" || entity.kind === "connection") &&
    entity.deletedAt !== null
  );
}

function isMineEntity(entity: Entity, myUserId: string): boolean {
  switch (entity.kind) {
    case "flight":
      return entity.userId === myUserId && entity.isMyFlight;
    case "ticket":
    case "connection":
      return entity.userId === myUserId;
    default:
      return true;
  }
}
