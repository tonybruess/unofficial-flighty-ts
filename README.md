# unofficial-flighty-ts

Unofficial, zero-dependency TypeScript client for Flighty's private
protobuf sync API.

> Not affiliated with, endorsed by, or supported by Flighty, Inc.
> "Flighty" is a trademark of its respective owner and is used here only
> nominatively to identify the API this library speaks to. Use at your own
> risk; expect breakage without notice. You must supply your own credentials
> from your own Flighty account.

## Install

```bash
npm  install unofficial-flighty-ts
pnpm add     unofficial-flighty-ts
bun  add     unofficial-flighty-ts
```

Runs in Node 20+, Bun, Deno, and modern browsers (needs `fetch`,
`TextDecoder`, `atob`). The bundled `flighty-creds` CLI is Node-only —
it shells out to `plutil` and `sqlite3` against the local Flighty.app
install.

## Usage

```ts
import { FlightyClient, resolveFlight } from "unofficial-flighty-ts";

const client = new FlightyClient({
  bearer: process.env.FLIGHTY_BEARER!,
  buildToken: process.env.FLIGHTY_BUILD_TOKEN!,
});

// Batch: fetch everything, then resolve relations as needed.
const sync = await client.sync();
for (const flight of sync.flights) {
  const { airline, departureAirport, arrivalAirport, isMine } = resolveFlight(flight, sync);
  console.log(
    `${isMine ? "me" : "friend"}  ` +
      `${airline?.iata ?? "??"}${flight.number}  ` +
      `${departureAirport?.iata ?? "???"} → ${arrivalAirport?.iata ?? "???"}  ` +
      `${flight.departureTime?.toISOString() ?? "-"}`,
  );
}

// Stream: process entities as pages arrive (low memory, cursor-friendly).
// Honors the same `onlyMine` and `includeDeleted` options as `sync()`.
for await (const entity of client.stream()) {
  if (
    entity.kind === "flight" &&
    entity.userId === client.myUserId &&
    entity.isMyFlight
  ) {
    // ...my own flights only
  }
}
```

## Credentials

Two JWTs are required:

| Env var                | What it is                                                                      | Where to find it                              |
| ---------------------- | ------------------------------------------------------------------------------- | --------------------------------------------- |
| `FLIGHTY_BEARER`       | HS512 JWT for your user session                                                 | CloudKit record cache (`previousTokens[1]`)   |
| `FLIGHTY_BUILD_TOKEN`  | ES256 JWT identifying the Flighty app build                                     | `Flighty.app/Contents/Info.plist`             |

The `build` token is tied to a Flighty app version and expires on the
schedule Flighty sets. Rotate when the app updates.

### Auto-discover from the Mac app

If you have Flighty for Mac installed and have opened it at least once,
`flighty-creds` reads both tokens out of the app bundle and the CloudKit
cache, probes each candidate against the API, and prints ready-to-source
`export` lines:

```bash
eval "$(npx flighty-creds)"          # ephemeral, this shell only
npx flighty-creds > .env             # for a project (add .env to .gitignore!)
```

Uses only macOS built-ins (`plutil`, `sqlite3`) — no extra deps, no
keychain prompts.

## API

### `new FlightyClient(options)`

```ts
interface FlightyClientOptions {
  bearer: string;             // required
  buildToken: string;         // required
  fetch?: typeof fetch;       // override the transport (tests, proxies)
  baseUrl?: string;           // default: https://api.flightyapp.com
  maxPages?: number;          // safety cap, default 500
  locale?: string;            // X-Flighty-Locale header, default "en_US"
  cursor?: string | null;     // resume from a previously-saved cursor
  onlyMine?: boolean;         // drop friends' flights/tickets (default false)
  includeDeleted?: boolean;   // keep server-side deleted rows in output
                              //   (default false — they're filtered out)
  timeoutMs?: number;         // per-page fetch timeout, default 30_000.
                              //   Applied per attempt; retries get a fresh
                              //   timer. Set to 0 to disable.
  retry?: {
    retries?: number;         // extra attempts after the first, default 2
    backoffMs?: number;       // initial backoff, default 500
    backoffFactor?: number;   // multiplier between attempts, default 2
    maxBackoffMs?: number;    // ceiling, default 8_000 (±20% jitter)
  };
  signal?: AbortSignal;       // aborts in-flight + pending retries; sync()
                              //   and stream() reject with
                              //   FlightyTransportError carrying the reason
                              //   as `cause`.
}
```

Retries fire on transient failures only: network errors, 5xx responses,
and 429 rate limits. 4xx responses (auth, bad request) and programmer
errors surface immediately. Exhausted retries and caller aborts are
wrapped in `FlightyTransportError` with the original error on `.cause`.

### `client.sync(options?): Promise<SyncResult>`

Fetches all pages and returns fully-collected entities:

```ts
interface SyncResult {
  flights: Flight[];
  airports: Map<string, Airport>;
  airlines: Map<string, Airline>;
  aircraftTypes: Map<string, AircraftType>;
  metropolitanAreas: Map<string, MetropolitanArea>; // NYC, LON, TYO, …
  userProfiles: Map<string, UserProfile>;           // connected friends
  tickets: Map<string, Ticket[]>; // keyed by flight id
  connections: Connection[];      // layovers linking two flights
  onwardByFlightId: Map<string, Connection[]>;  // keyed by inbound flight
  inboundByFlightId: Map<string, Connection[]>; // keyed by outbound flight
  myUserId: string;               // decoded from the bearer's `sub` claim
  cursor: string | null;          // delta watermark for the next sync
  pagesFetched: number;           // pages drained this call
  truncated: boolean;             // true only if `maxPages` was hit;
                                  //   sync() throws instead of returning
                                  //   when this happens, so you only see
                                  //   `false` here.
}
```

Pass `{ cursor }` on a later call — or set `cursor` in the constructor —
to receive only entities that changed since the cursor was issued. The
cursor is an opaque string; treat it as a watermark to persist between
processes. Flighty ships entity mutations AND server-side deletions
through the same delta, so the SDK surfaces tombstones via
`Flight.deletedAt` / `Connection.deletedAt` and filters them out of
`sync.flights` / `sync.connections` by default. Flip
`{ includeDeleted: true }` when you need to reconcile deletes with a
local store.

```ts
const first = await client.sync();
savePersistent(first.cursor);
// ...later...
const delta = await client.sync({ cursor: loadPersistent(), includeDeleted: true });
// `delta.flights` contains both mutated rows and tombstoned rows
// (`flight.deletedAt !== null`). Merge into your own store by id;
// tombstones should trigger a local delete.
```

`sync()` throws `FlightyError` if Flighty serves more pages than
`maxPages`. Bump the cap or switch to `stream()` if you're reconciling
an unusually large account. `stream()` returns the cursor on
`client.cursor` as each page arrives, so you can persist progress even
mid-drain.

### `client.myUserId: string`

The authenticated user's id, decoded once from the bearer's `sub` claim.
Compare against `flight.userId` to tell your own flights from flights
Flighty surfaces for connected friends.

### `client.stream(options?): AsyncGenerator<Entity>`

Yields `Airport | Airline | AircraftType | Ticket | Flight |
MetropolitanArea | UserProfile | Connection` as pages arrive. Each has
a `kind` discriminator for TS narrowing. Accepts the same
`{ cursor, onlyMine, includeDeleted }` options as `sync()`. The latest
cursor Flighty returns is written to `client.cursor` as each page
streams in, so you can persist progress even if the stream is
interrupted. Unlike `sync()`, `stream()` does not throw if `maxPages`
is reached — it simply stops yielding.

### `computeStats(sync, options?): FlightyStats`

Aggregates a `SyncResult` into the same buckets the Flighty app's
Profile "Stats" tab renders — `totalDistanceKm`, `totalDurationSeconds`,
per-airline / airport / country / aircraft-type / tail / route / cabin /
year breakdowns, and unique counts. Flighty has **no** server-side stats
endpoint; the official app derives stats locally from the same sync
payload, and this helper applies the same shape. Totals won't match the
app to the kilometre in every case — the app blends in-flight bumps
(archived flights with no actual times, edge rounding) that aren't
reproducible from sync data alone — but airline / airport / route
rankings line up.

Defaults match the app: cancelled flights are excluded and only the
authed user's flights are counted. Pass `{ includeCancelled: true }` or
`{ onlyMine: false }` to loosen.

```ts
const sync = await client.sync();
const stats = computeStats(sync);
console.log(`${stats.flightCount} flights, ${stats.totalDistanceKm.toFixed(0)} km`);
for (const row of stats.byAirline.slice(0, 5)) {
  console.log(`  ${row.label}  ${row.flightCount}`);
}
```

### `resolveFlight(flight, sync): ResolvedFlight`

Joins a `Flight` with its airline, airports, aircraft type, and tickets.
Adds `isMine` (true when the flight's owner is the authenticated user).
Also adds `onwardConnections` (layovers where this flight is the inbound
leg) and `inboundConnections` (layovers where this flight is the outbound
leg) so you can walk multi-leg itineraries without rescanning
`sync.connections`.

### Decoded fields

What's pulled off the wire per entity:

- **Flight** — `id`, `userId`, `number`, `callsign`, `airlineId`,
  `departureAirportId`, `arrivalAirportId`, `scheduledArrivalAirportId`
  (differs from `arrivalAirportId` only on diverted flights),
  `departureTime` / `arrivalTime` (best-available), plus split
  `scheduledDepartureTime`, `estimatedDepartureTime`,
  `actualDepartureTime`, `scheduledArrivalTime`, `estimatedArrivalTime`,
  `actualArrivalTime` (all gate-to-gate). `departureTerminal`,
  `departureGate`, `arrivalTerminal`, `arrivalGate`, `arrivalBaggageBelt`,
  `checkInOpen`, `checkInClose`, `distanceKm`, `aircraft`, `isCancelled`,
  `isArchived` (per-viewer — auto-set on past flights once they complete),
  `isMyFlight` (per-viewer — matches the app's `UserFlight.isMyFlight`
  flag; `false` on rows imported but not claimed, e.g. calendar imports
  the user hasn't confirmed), `sharingUrl` (public `live.flighty.app`
  link), `departureWeather`,
  `arrivalWeather`, `delayForecast`, `codeshares`, `events`,
  `faaTmiReason`, `faaTmi` (full TMI record with code + active window),
  `inboundFlights` (prior legs of the same aircraft),
  `importSourceRaw` (raw integer on the wire — mapping to
  `"manual"`/`"email"`/… varies and is left to callers until it's
  confirmed against the app), `created`, `lastUpdated`, `deletedAt`
  (non-null on tombstones; filtered by default — see `includeDeleted`).
- **FlightEvent** (embedded in `Flight.events`) — per-flight change feed.
  Discriminated union on `kind`: `gateChange` (terminal/gate updates for
  `isArrival` end), `tailAssignment` (aircraft tail swap),
  `actualGateOut` / `actualGateIn` (observed OUT/IN moments),
  `timingRevision` (airline/Flighty revised the scheduled or estimated
  gate time for either end — the dominant event type; carries the
  revised `time` and which leg was revised). Every event carries
  `recordedAt` — the moment Flighty first recorded that change.
- **InboundFlight** (embedded in `Flight.inboundFlights`) — the previous
  leg(s) of the same aircraft rotation. Fields: `id`, `number`,
  `airlineId` / `airlineIata` / `airlineName` (inlined), dep/arr airport
  IDs, full dep/arr timing split (scheduled/estimated/actual + best),
  terminals, gates, baggage belt. Useful to answer "where is my plane
  coming from, and is it on time?" without a second lookup.
- **FaaTmi** (embedded in `Flight.faaTmi`) — active FAA Traffic
  Management Initiative: `code` (initiative type, e.g. 1 = ground delay
  program), `reason` (freeform text like `"thunderstorms"`),
  `startAt` / `endAt` (effective window).
- **Aircraft** (embedded in `Flight`) — `tailNumber`, `modelName`,
  `manufacturer`, `planeName`, `registrationCountry`, `firstFlight`,
  `iata`, `icao`, `rangeKm`, `cruisingSpeedKmh`, `aircraftTypeId`
  (joins to `AircraftType`).
- **Weather** (embedded in `Flight.departureWeather` and
  `Flight.arrivalWeather`) — `temperatureC`, `conditionCode`
  (OpenWeatherMap), `condition` (human label), `observedAt` (when
  the reading was taken).
- **Codeshare** (embedded in `Flight.codeshares`) — marketing carrier
  `number`, `airlineId`, `operatesAircraft`.
- **DelayForecast** (embedded in `Flight.delayForecast`) — `observations`,
  `delayMeanMinutes`.
- **Airport** — `id`, `iata`, `icao`, `name`, `displayName`, `city`,
  `country`, `countryCode`, `region`, `timezone`, `website`, `latitude`,
  `longitude`, `relevance` (autocomplete ranking weight), `created`,
  `lastUpdated`.
- **Airline** — `id`, `iata`, `icao`, `name`, `callsign`, `alliance`,
  `website`, `phone`, `twitterHandle`, `facebookUrl`, `relevance`,
  `created`, `lastUpdated`.
- **AircraftType** — `id`, `iata`, `icao`, `name`, `manufacturer`,
  `passengerCapacityRaw` (raw wire integer; its meaning is not yet
  confirmed against the app — don't surface it as "seats" without
  checking), `created`, `lastUpdated`.
- **MetropolitanArea** — `id` (metro IATA like `"NYC"`, `"LON"`),
  `name`, `countryCode`, `airportIds` (repeated — all airports in the
  metro), `relevance`, `created`, `lastUpdated`.
- **UserProfile** — `id` (matches `Flight.userId`), `name`, `firstName`,
  `created`, `lastUpdated`. One row per connected friend whose flights
  appear in `sync.flights`.
- **Ticket** — `id` (equals flight id), `userId`, `pnr`, `seat`,
  `cabinClass` (`"economy" | "premiumEconomy" | "business" | "first" |
  "unknown" | null` — string mapping derived from the Flighty Mac
  app's resource strings; `null` when Flighty has no cabin on record),
  `cabinClassRaw` (the raw integer from the wire, kept for
  forward-compat with values Flighty may start shipping), `created`,
  `lastUpdated`.
- **Connection** — the "layover" edge linking two flights into one
  itinerary. Fields: `id`, `userId`, `inboundFlightId`,
  `outboundFlightId`, `airportId` (the layover airport — join against
  `sync.airports`), `connectionTimeMinutesBuckets` (four varints Flighty
  uses internally for connection-time risk tiers — exposed raw until
  the bucket semantics are confirmed), `created`, `lastUpdated`,
  `deletedAt` (non-null on tombstones; filtered by default). Flighty
  has no separate "Trip" entity; multi-leg trips are reconstructed by
  walking connections.

## Mine vs. friends

Flighty's sync returns your own logged flights **and** flights from
connected friends, plus any rows imported onto your account (calendar,
email, shared trips) that you haven't confirmed as yours. Two ways to
scope to flights you actually took:

```ts
// Option 1 — let the SDK drop friends' flights and unconfirmed imports.
// Matches the app's "My Flights" view: userId === myUserId AND isMyFlight.
const client = new FlightyClient({ bearer, buildToken, onlyMine: true });
const sync = await client.sync();
// sync.flights / sync.tickets only contain yours.
// Shared entities (airports, airlines, user profiles, …) are untouched.

// Option 2 — fetch everything, filter where you need it.
const sync = await client.sync();
const mine = sync.flights.filter(
  (f) => f.userId === sync.myUserId && f.isMyFlight,
);
```

Filtering on `userId` alone is not enough: Flighty can seed
calendar-imported flights onto your account with `userId === myUserId`
but `isMyFlight === false` until you claim them. `onlyMine` is also
accepted per-call on `client.sync({ onlyMine: true })` and
`client.stream({ onlyMine: true })`.

## Known gaps

- `delayForecast` exposes observation count and mean delay; the
  per-bucket histogram is on the wire but its bucket schema doesn't
  cleanly sum to observations, so it's left for future work.
- Eight of Flighty's ~20 entity kinds are surfaced (flights, airports,
  airlines, aircraft types, tickets, metropolitan areas, user profiles,
  connections). Subscriptions, friend-request pairings, user settings,
  and a few low-volume bookkeeping kinds are silently skipped.
- `Flight.importSourceRaw` and `AircraftType.passengerCapacityRaw` are
  emitted as raw integers rather than labelled enums/units — the field
  mappings aren't cross-checked against the Flighty Mac app's resources
  yet, so making up pretty labels would be lying. File an issue if you
  confirm either mapping.
- `created` / `lastUpdated` on low-churn shared catalogs (airports,
  airlines, aircraft types, metros) reflect when Flighty last touched
  that record on its side, not when your account first saw it.

## Contributing

Workflow is [Bun](https://bun.sh)-first (`curl -fsSL https://bun.sh/install | bash`):

```bash
bun install
bun test               # runs against bun:test directly
bun run build          # tsc → dist/
bun run typecheck      # tsc --noEmit for src + test
bun src/bin/creds.ts   # exercise flighty-creds against your tree
```

The library itself is pure ESM TypeScript with zero runtime deps —
installed SDK consumers only need a `fetch`-capable runtime (see
above). Bun is only required for the local dev loop.

## License

MIT
