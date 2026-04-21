import { test, expect } from "bun:test";
import { FlightyClient } from "../src/client.js";
import { FlightyApiError, FlightyError, FlightyTransportError } from "../src/errors.js";
import { buildCursor, encodeSyncPage } from "./helpers/fixtures.js";
import { flakyFetch, mockFetch } from "./helpers/mockFetch.js";
import { fakeBearer, fakeBuildToken } from "./helpers/jwt.js";

const bearer = fakeBearer("me");
const buildToken = fakeBuildToken();

test("sync() strips tombstoned flights by default", async () => {
  const page = encodeSyncPage({
    flights: [
      { id: "live", userId: "me", isMyFlight: true, distanceKm: 100 },
      {
        id: "deleted",
        userId: "me",
        isMyFlight: true,
        deletedAt: 1_700_000_000,
        distanceKm: 200,
      },
    ],
  });
  const { fetch } = mockFetch([page]);
  const client = new FlightyClient({ bearer, buildToken, fetch });
  const sync = await client.sync();
  expect(sync.flights.map((f) => f.id)).toEqual(["live"]);
});

test("sync({ includeDeleted: true }) keeps tombstones so callers can reconcile", async () => {
  const page = encodeSyncPage({
    flights: [
      { id: "live", userId: "me", isMyFlight: true },
      { id: "deleted", userId: "me", isMyFlight: true, deletedAt: 1_700_000_000 },
    ],
  });
  const { fetch } = mockFetch([page]);
  const client = new FlightyClient({ bearer, buildToken, fetch });
  const sync = await client.sync({ includeDeleted: true });
  const ids = sync.flights.map((f) => f.id).sort();
  expect(ids).toEqual(["deleted", "live"]);
  const deleted = sync.flights.find((f) => f.id === "deleted")!;
  expect(deleted.deletedAt).toBeInstanceOf(Date);
});

test("stream() applies the same tombstone filter as sync()", async () => {
  const page = encodeSyncPage({
    flights: [
      { id: "live", userId: "me", isMyFlight: true },
      { id: "deleted", userId: "me", isMyFlight: true, deletedAt: 1_700_000_000 },
    ],
  });
  const { fetch } = mockFetch([page]);
  const client = new FlightyClient({ bearer, buildToken, fetch });
  const ids: string[] = [];
  for await (const e of client.stream()) if (e.kind === "flight") ids.push(e.id);
  expect(ids).toEqual(["live"]);
});

test("stream({ includeDeleted: true }) yields tombstones", async () => {
  const page = encodeSyncPage({
    flights: [
      { id: "live", userId: "me", isMyFlight: true },
      { id: "deleted", userId: "me", isMyFlight: true, deletedAt: 1_700_000_000 },
    ],
  });
  const { fetch } = mockFetch([page]);
  const client = new FlightyClient({ bearer, buildToken, fetch });
  const ids: string[] = [];
  for await (const e of client.stream({ includeDeleted: true })) {
    if (e.kind === "flight") ids.push(e.id);
  }
  expect(ids.sort()).toEqual(["deleted", "live"]);
});

test("onlyMine drops friends' flights and unconfirmed imports", async () => {
  const page = encodeSyncPage({
    flights: [
      { id: "mine", userId: "me", isMyFlight: true },
      { id: "imported-unconfirmed", userId: "me", isMyFlight: false },
      { id: "friend", userId: "friend", isMyFlight: true },
    ],
  });
  const { fetch } = mockFetch([page]);
  const client = new FlightyClient({ bearer, buildToken, fetch, onlyMine: true });
  const sync = await client.sync();
  expect(sync.flights.map((f) => f.id)).toEqual(["mine"]);
});

test("onlyMine also filters tickets and connections but leaves catalogs", async () => {
  const page = encodeSyncPage({
    flights: [{ id: "mine", userId: "me", isMyFlight: true }],
    connections: [
      {
        id: "conn-mine",
        userId: "me",
        inboundFlightId: "mine",
        outboundFlightId: "mine-out",
        airportId: "ap-lhr",
      },
      {
        id: "conn-friend",
        userId: "friend",
        inboundFlightId: "x",
        outboundFlightId: "y",
        airportId: "ap-lhr",
      },
    ],
    airports: [{ id: "ap-lhr", iata: "LHR", name: "Heathrow" }],
  });
  const { fetch } = mockFetch([page]);
  const client = new FlightyClient({ bearer, buildToken, fetch, onlyMine: true });
  const sync = await client.sync();
  expect(sync.connections.map((c) => c.id)).toEqual(["conn-mine"]);
  expect(sync.airports.get("ap-lhr")?.iata).toBe("LHR");
});

test("pagination follows nextURL across pages", async () => {
  const p1 = encodeSyncPage({
    flights: [{ id: "f1", userId: "me", isMyFlight: true }],
    nextCursor: buildCursor({ flight: "cur-1" }),
  });
  const p2 = encodeSyncPage({
    flights: [{ id: "f2", userId: "me", isMyFlight: true }],
  });
  const { fetch, calls } = mockFetch([p1, p2]);
  const client = new FlightyClient({ bearer, buildToken, fetch });
  const sync = await client.sync();
  expect(sync.pagesFetched).toBe(2);
  expect(sync.flights.map((f) => f.id).sort()).toEqual(["f1", "f2"]);
  // Second request must carry the cursor returned on page 1.
  expect(calls[0]!.url).not.toMatch(/token=/);
  expect(calls[1]!.url).toMatch(/token=/);
});

test("pagination stops once cursor fingerprint repeats (heartbeat-only pages)", async () => {
  // Flighty's tail behavior: entity cursors stop advancing but a
  // `usersubscription` heartbeat field keeps mutating, so the raw
  // nextURL never repeats. The SDK must detect the cycle via the
  // fingerprint (cursor minus heartbeats) and halt, rather than hit
  // maxPages.
  const entityCursor = { flight: "cur-final", connection: "cur-c" };
  const page = (hb: number) =>
    encodeSyncPage({
      flights:
        hb === 1 ? [{ id: "f1", userId: "me", isMyFlight: true }] : [],
      nextCursor: buildCursor({ ...entityCursor, usersubscription: hb }),
    });
  const { fetch } = mockFetch([page(1), page(2), page(3), page(4)]);
  const client = new FlightyClient({ bearer, buildToken, fetch, maxPages: 100 });
  const sync = await client.sync();
  // Page 1 sets the fingerprint; page 2 has the same entity fingerprint
  // with a different heartbeat, so the loop exits after page 2.
  expect(sync.pagesFetched).toBe(2);
  expect(sync.truncated).toBe(false);
  expect(sync.flights.map((f) => f.id)).toEqual(["f1"]);
});

test("sync() throws when maxPages is hit with nextURL still present", async () => {
  // Every page advances the entity cursor, so fingerprint cycle
  // detection can't help — maxPages must still be a hard stop.
  const pages = Array.from({ length: 5 }, (_, i) =>
    encodeSyncPage({
      flights: [{ id: `f${i}`, userId: "me", isMyFlight: true }],
      nextCursor: buildCursor({ flight: `cur-${i}` }),
    }),
  );
  const { fetch } = mockFetch(pages);
  const client = new FlightyClient({ bearer, buildToken, fetch, maxPages: 3 });
  expect(client.sync()).rejects.toBeInstanceOf(FlightyError);
});

test("stream() does NOT throw when truncated — sets result instead", async () => {
  const pages = Array.from({ length: 5 }, (_, i) =>
    encodeSyncPage({
      flights: [{ id: `f${i}`, userId: "me", isMyFlight: true }],
      nextCursor: buildCursor({ flight: `cur-${i}` }),
    }),
  );
  const { fetch } = mockFetch(pages);
  const client = new FlightyClient({ bearer, buildToken, fetch, maxPages: 2 });
  const ids: string[] = [];
  for await (const e of client.stream()) {
    if (e.kind === "flight") ids.push(e.id);
  }
  expect(ids).toEqual(["f0", "f1"]);
  // Cursor from the last delivered page is persisted on the client so
  // the caller can resume.
  expect(client.cursor).not.toBeNull();
});

test("transport retries on transient network errors", async () => {
  const page = encodeSyncPage({
    flights: [{ id: "f1", userId: "me", isMyFlight: true }],
  });
  const { fetch, calls } = flakyFetch([page], { transientFailures: 2 });
  const client = new FlightyClient({
    bearer,
    buildToken,
    fetch,
    retry: { retries: 3, backoffMs: 1, backoffFactor: 1, maxBackoffMs: 1 },
  });
  const sync = await client.sync();
  expect(sync.flights).toHaveLength(1);
  expect(calls).toHaveLength(3); // 2 failures + 1 success
});

test("transport gives up after retry budget and throws FlightyTransportError", async () => {
  const page = encodeSyncPage({
    flights: [{ id: "f1", userId: "me", isMyFlight: true }],
  });
  const { fetch } = flakyFetch([page], { transientFailures: 10 });
  const client = new FlightyClient({
    bearer,
    buildToken,
    fetch,
    retry: { retries: 2, backoffMs: 1, backoffFactor: 1, maxBackoffMs: 1 },
  });
  await expect(client.sync()).rejects.toBeInstanceOf(FlightyTransportError);
});

test("4xx from the API does NOT trigger retry (fails fast)", async () => {
  let calls = 0;
  const fetch: typeof globalThis.fetch = (async () => {
    calls += 1;
    return new Response("forbidden", { status: 403 });
  }) as typeof globalThis.fetch;
  const client = new FlightyClient({
    bearer,
    buildToken,
    fetch,
    retry: { retries: 3, backoffMs: 1, backoffFactor: 1, maxBackoffMs: 1 },
  });
  await expect(client.sync()).rejects.toBeInstanceOf(FlightyApiError);
  expect(calls).toBe(1);
});

test("caller AbortSignal rejects in-flight pages", async () => {
  const controller = new AbortController();
  const fetch: typeof globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
  }) as typeof globalThis.fetch;
  const client = new FlightyClient({ bearer, buildToken, fetch, timeoutMs: 0 });
  queueMicrotask(() => controller.abort(new Error("user bail")));
  await expect(client.sync({ signal: controller.signal })).rejects.toBeInstanceOf(
    FlightyTransportError,
  );
});

test("sync() drops a flight tombstoned on a later page (filter runs after dedupe)", async () => {
  // Regression: if filtering happens during the page walk instead of
  // after materialization, a page-2 tombstone gets silently dropped by
  // the default `includeDeleted: false` filter and the page-1 live row
  // survives — so sync() hands back a deleted flight as still alive.
  const p1 = encodeSyncPage({
    flights: [{ id: "f1", userId: "me", isMyFlight: true }],
    nextCursor: buildCursor({ flight: "1" }),
  });
  const p2 = encodeSyncPage({
    flights: [{ id: "f1", userId: "me", isMyFlight: true, deletedAt: 1_700_000_000 }],
  });
  const { fetch } = mockFetch([p1, p2]);
  const client = new FlightyClient({ bearer, buildToken, fetch });
  const sync = await client.sync();
  expect(sync.flights).toHaveLength(0);
});

test("sync({ onlyMine: true }) drops a flight whose isMyFlight flips to false on a later page", async () => {
  // Regression: same shape as the tombstone case, but for the
  // onlyMine filter. The page-2 revision (isMyFlight=false) is the
  // current state and must win over the page-1 `true`.
  const p1 = encodeSyncPage({
    flights: [{ id: "f1", userId: "me", isMyFlight: true }],
    nextCursor: buildCursor({ flight: "1" }),
  });
  const p2 = encodeSyncPage({
    flights: [{ id: "f1", userId: "me", isMyFlight: false }],
  });
  const { fetch } = mockFetch([p1, p2]);
  const client = new FlightyClient({ bearer, buildToken, fetch, onlyMine: true });
  const sync = await client.sync();
  expect(sync.flights).toHaveLength(0);
});

test("tickets are deduped per (flightId, userId) across pages", async () => {
  // Two pages ship a ticket with the same (flightId, userId); the later
  // revision (different PNR) should win.
  const p1 = encodeSyncPage({
    tickets: [{ flightId: "flight-1", userId: "me", pnr: "OLD" }],
    nextCursor: buildCursor({ ticket: "1" }),
  });
  const p2 = encodeSyncPage({
    tickets: [{ flightId: "flight-1", userId: "me", pnr: "NEW" }],
  });
  const { fetch } = mockFetch([p1, p2]);
  const client = new FlightyClient({ bearer, buildToken, fetch });
  const sync = await client.sync();
  const tickets = sync.tickets.get("flight-1") ?? [];
  expect(tickets).toHaveLength(1);
  expect(tickets[0]!.pnr).toBe("NEW");
});
