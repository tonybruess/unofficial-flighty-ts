import type {
  CabinClass,
  Flight,
  SyncResult,
  Ticket,
} from "./types.js";

/**
 * Lifetime aggregates computed from a {@link SyncResult}. Flighty has
 * no server-side stats endpoint — this reproduces the Profile "Stats"
 * tab's breakdowns (totals, per-airline, per-airport, per-route,
 * per-aircraft-type, per-tail, per-country, per-cabin, per-year).
 */
export interface FlightyStats {
  /** How many flights contributed to the totals (post-filter). */
  readonly flightCount: number;
  /** Sum of `distanceKm` across counted flights (nulls skipped). */
  readonly totalDistanceKm: number;
  /**
   * Sum of gate-to-gate block time across counted flights, in seconds.
   * Uses the best-available departure and arrival timestamps.
   */
  readonly totalDurationSeconds: number;
  /** Distinct airports visited (departure or arrival). */
  readonly uniqueAirports: number;
  /** Distinct airlines flown. */
  readonly uniqueAirlines: number;
  /** Distinct countries visited (by airport). */
  readonly uniqueCountries: number;
  /** Distinct aircraft types flown. */
  readonly uniqueAircraftTypes: number;
  /** Distinct airframes flown (by tail number). */
  readonly uniqueTails: number;
  readonly byAirline: readonly StatBucket[];
  readonly byAirport: readonly StatBucket[];
  readonly byCountry: readonly StatBucket[];
  readonly byAircraftType: readonly StatBucket[];
  readonly byTail: readonly StatBucket[];
  readonly byRoute: readonly RouteBucket[];
  readonly byCabinClass: readonly CabinBucket[];
  readonly byYear: readonly YearBucket[];
}

export interface StatBucket {
  /** Stable identifier to join against `sync.{airlines,airports,...}`. */
  readonly key: string;
  /** Short label (IATA code, tail number, …) suitable for display. */
  readonly label: string;
  readonly flightCount: number;
  readonly distanceKm: number;
}

export interface RouteBucket {
  /** Stable key: `"<originId>-<destinationId>"`. */
  readonly key: string;
  readonly originAirportId: string;
  readonly destinationAirportId: string;
  /** `"<originIata>→<destinationIata>"` when both IATAs are known. */
  readonly label: string;
  readonly flightCount: number;
  readonly distanceKm: number;
}

export interface CabinBucket {
  readonly cabinClass: CabinClass | null;
  readonly flightCount: number;
  readonly distanceKm: number;
}

export interface YearBucket {
  /** Calendar year from the flight's best-available departure time. */
  readonly year: number;
  readonly flightCount: number;
  readonly distanceKm: number;
  readonly durationSeconds: number;
}

export interface ComputeStatsOptions {
  /** Include cancelled flights in the aggregates. Default `false`. */
  readonly includeCancelled?: boolean;
  /**
   * Restrict to flights the viewer actually took
   * (`userId === sync.myUserId && isMyFlight`). Drops friends' flights
   * and unclaimed calendar imports. Default `true`.
   */
  readonly onlyMine?: boolean;
}

export function computeStats(sync: SyncResult, options: ComputeStatsOptions = {}): FlightyStats {
  const includeCancelled = options.includeCancelled ?? false;
  const onlyMine = options.onlyMine ?? true;
  const flights = sync.flights.filter((f) => {
    if (!includeCancelled && f.isCancelled) return false;
    if (onlyMine && !(f.userId === sync.myUserId && f.isMyFlight)) return false;
    return true;
  });

  let totalDistanceKm = 0;
  let totalDurationSeconds = 0;
  const airlineTotals = new Map<string, MutableBucket>();
  const airportTotals = new Map<string, MutableBucket>();
  const countryTotals = new Map<string, MutableBucket>();
  const typeTotals = new Map<string, MutableBucket>();
  const tailTotals = new Map<string, MutableBucket>();
  const routeTotals = new Map<string, MutableRoute>();
  const cabinTotals = new Map<CabinClass | "null", MutableCabin>();
  const yearTotals = new Map<number, MutableYear>();

  const visitedAirports = new Set<string>();

  for (const f of flights) {
    const dist = f.distanceKm ?? 0;
    const duration = durationSeconds(f);
    totalDistanceKm += dist;
    totalDurationSeconds += duration;

    if (f.airlineId) {
      const airline = sync.airlines.get(f.airlineId);
      bump(airlineTotals, f.airlineId, airline?.iata ?? airline?.name ?? f.airlineId, dist);
    }

    const dep = f.departureAirportId;
    const arr = f.arrivalAirportId;
    const flightCountries = new Map<string, string>();
    if (dep) {
      visitedAirports.add(dep);
      const ap = sync.airports.get(dep);
      bump(airportTotals, dep, ap?.iata ?? ap?.name ?? dep, dist);
      if (ap?.countryCode) flightCountries.set(ap.countryCode, ap.country ?? ap.countryCode);
    }
    if (arr) {
      visitedAirports.add(arr);
      const ap = sync.airports.get(arr);
      bump(airportTotals, arr, ap?.iata ?? ap?.name ?? arr, dist);
      if (ap?.countryCode) flightCountries.set(ap.countryCode, ap.country ?? ap.countryCode);
    }
    // Dedupe domestic flights: same country at both endpoints counts once.
    for (const [code, label] of flightCountries) bump(countryTotals, code, label, dist);

    if (dep && arr) {
      const key = `${dep}-${arr}`;
      const row = routeTotals.get(key);
      const depIata = sync.airports.get(dep)?.iata ?? dep;
      const arrIata = sync.airports.get(arr)?.iata ?? arr;
      if (row) {
        row.flightCount++;
        row.distanceKm += dist;
      } else {
        routeTotals.set(key, {
          originAirportId: dep,
          destinationAirportId: arr,
          label: `${depIata}→${arrIata}`,
          flightCount: 1,
          distanceKm: dist,
        });
      }
    }

    const typeId = f.aircraft?.aircraftTypeId ?? null;
    if (typeId) {
      const type = sync.aircraftTypes.get(typeId);
      bump(typeTotals, typeId, type?.iata ?? type?.name ?? typeId, dist);
    }
    const tail = f.aircraft?.tailNumber ?? null;
    if (tail) bump(tailTotals, tail, tail, dist);

    const cabin = chooseCabin(sync.tickets.get(f.id));
    bumpCabin(cabinTotals, cabin, dist);

    const year = flightYear(f);
    if (year != null) {
      const row = yearTotals.get(year);
      if (row) {
        row.flightCount++;
        row.distanceKm += dist;
        row.durationSeconds += duration;
      } else {
        yearTotals.set(year, { flightCount: 1, distanceKm: dist, durationSeconds: duration });
      }
    }
  }

  return {
    flightCount: flights.length,
    totalDistanceKm,
    totalDurationSeconds,
    uniqueAirports: visitedAirports.size,
    uniqueAirlines: airlineTotals.size,
    uniqueCountries: countryTotals.size,
    uniqueAircraftTypes: typeTotals.size,
    uniqueTails: tailTotals.size,
    byAirline: sortBuckets(airlineTotals),
    byAirport: sortBuckets(airportTotals),
    byCountry: sortBuckets(countryTotals),
    byAircraftType: sortBuckets(typeTotals),
    byTail: sortBuckets(tailTotals),
    byRoute: sortRouteBuckets(routeTotals),
    byCabinClass: sortCabinBuckets(cabinTotals),
    byYear: [...yearTotals.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([year, row]) => ({ year, ...row })),
  };
}

interface MutableBucket {
  label: string;
  flightCount: number;
  distanceKm: number;
}
interface MutableRoute {
  originAirportId: string;
  destinationAirportId: string;
  label: string;
  flightCount: number;
  distanceKm: number;
}
interface MutableCabin {
  flightCount: number;
  distanceKm: number;
}
interface MutableYear {
  flightCount: number;
  distanceKm: number;
  durationSeconds: number;
}

function bump(map: Map<string, MutableBucket>, key: string, label: string, dist: number): void {
  const row = map.get(key);
  if (row) {
    row.flightCount++;
    row.distanceKm += dist;
  } else {
    map.set(key, { label, flightCount: 1, distanceKm: dist });
  }
}

function bumpCabin(
  map: Map<CabinClass | "null", MutableCabin>,
  cabin: CabinClass | null,
  dist: number,
): void {
  const key = cabin ?? "null";
  const row = map.get(key);
  if (row) {
    row.flightCount++;
    row.distanceKm += dist;
  } else {
    map.set(key, { flightCount: 1, distanceKm: dist });
  }
}

function sortBuckets(map: Map<string, MutableBucket>): StatBucket[] {
  return [...map.entries()]
    .map(([key, row]) => ({ key, ...row }))
    .sort((a, b) => b.flightCount - a.flightCount);
}

function sortRouteBuckets(map: Map<string, MutableRoute>): RouteBucket[] {
  return [...map.entries()]
    .map(([key, row]) => ({ key, ...row }))
    .sort((a, b) => b.flightCount - a.flightCount);
}

function sortCabinBuckets(map: Map<CabinClass | "null", MutableCabin>): CabinBucket[] {
  return [...map.entries()]
    .map(([key, row]) => ({
      cabinClass: key === "null" ? null : key,
      flightCount: row.flightCount,
      distanceKm: row.distanceKm,
    }))
    .sort((a, b) => b.flightCount - a.flightCount);
}

function chooseCabin(tickets: Ticket[] | undefined): CabinClass | null {
  if (!tickets || tickets.length === 0) return null;
  for (const t of tickets) if (t.cabinClass) return t.cabinClass;
  return null;
}

function durationSeconds(f: Flight): number {
  const dep = f.departureTime?.getTime();
  const arr = f.arrivalTime?.getTime();
  if (dep == null || arr == null || arr < dep) return 0;
  return Math.round((arr - dep) / 1000);
}

function flightYear(f: Flight): number | null {
  const t = f.departureTime ?? f.scheduledDepartureTime ?? f.actualDepartureTime ?? null;
  return t ? t.getUTCFullYear() : null;
}
