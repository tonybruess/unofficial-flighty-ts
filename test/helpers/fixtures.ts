/**
 * Hand-rolled Flighty sync fixtures. These use tag numbers lifted
 * straight from `src/parse.ts` so the tests exercise the actual parser
 * paths — no cheating with injected mocks.
 */
import { encodeFields, field, str, sub, subMessage, varint, bool } from "./pb.js";

export interface AirportFixture {
  id: string;
  iata?: string;
  country?: string;
  countryCode?: string;
  name?: string;
}

export interface FlightFixture {
  id: string;
  userId: string;
  isMyFlight: boolean;
  isArchived?: boolean;
  isCancelled?: boolean;
  deletedAt?: number | null;
  departureAirportId?: string;
  arrivalAirportId?: string;
  distanceKm?: number;
  number?: string;
  airlineId?: string;
}

export interface ConnectionFixture {
  id: string;
  userId: string;
  inboundFlightId: string;
  outboundFlightId: string;
  airportId: string;
  deletedAt?: number | null;
}

export interface AircraftTypeFixture {
  id?: string | null;
  name: string;
  manufacturer?: string;
  iata?: string;
  icao?: string;
}

export interface TicketFixture {
  flightId: string;
  userId: string;
  pnr?: string;
  seat?: string;
}

export function encodeTicket(t: TicketFixture): Uint8Array {
  const fields = [field(1, str(t.flightId)), field(6, str(t.userId))];
  if (t.pnr != null) fields.push(field(2, str(t.pnr)));
  if (t.seat != null) fields.push(field(3, str(t.seat)));
  return encodeFields(fields);
}

export function encodeAirport(f: AirportFixture): Uint8Array {
  const fields = [field(1, str(f.id)), field(2, str(f.name ?? ""))];
  if (f.iata) fields.push(field(3, str(f.iata)));
  if (f.country) fields.push(field(8, str(f.country)));
  if (f.countryCode) fields.push(field(9, str(f.countryCode)));
  return encodeFields(fields);
}

export function encodeConnection(c: ConnectionFixture): Uint8Array {
  const fields = [
    field(1, str(c.id)),
    field(2, str(c.inboundFlightId)),
    field(3, str(c.outboundFlightId)),
    field(4, sub(subMessage([field(1, str(c.airportId))]))),
    field(5, str(c.userId)),
  ];
  if (c.deletedAt != null) {
    fields.push(field(8, sub(subMessage([field(1, varint(c.deletedAt))]))));
  }
  return encodeFields(fields);
}

export function encodeAircraftType(t: AircraftTypeFixture): Uint8Array {
  const fields = [];
  if (t.id != null) fields.push(field(1, str(t.id)));
  fields.push(field(2, str(t.name)));
  if (t.iata) fields.push(field(3, str(t.iata)));
  if (t.icao) fields.push(field(4, str(t.icao)));
  if (t.manufacturer) fields.push(field(5, str(t.manufacturer)));
  return encodeFields(fields);
}

export function encodeFlight(f: FlightFixture): Uint8Array {
  const coreFields = [field(16, str(f.number ?? ""))];
  if (f.distanceKm != null) coreFields.push(field(17, varint(f.distanceKm)));
  if (f.airlineId) coreFields.push(field(21, str(f.airlineId)));
  if (f.isCancelled) coreFields.push(field(5, bool(true)));
  if (f.departureAirportId) {
    coreFields.push(field(2, sub(subMessage([field(11, str(f.departureAirportId))]))));
  }
  if (f.arrivalAirportId) {
    coreFields.push(field(3, sub(subMessage([field(14, str(f.arrivalAirportId))]))));
  }

  const fields = [
    field(1, str(f.id)),
    field(2, sub(subMessage(coreFields))),
    field(9, str(f.userId)),
  ];
  if (f.isArchived != null) fields.push(field(3, bool(f.isArchived)));
  fields.push(field(5, bool(f.isMyFlight)));
  if (f.deletedAt != null) {
    fields.push(field(13, sub(subMessage([field(1, varint(f.deletedAt))]))));
  }
  return encodeFields(fields);
}

export interface SyncPage {
  /** Flights to include, each wrapped in an Entity envelope. */
  flights?: readonly FlightFixture[];
  connections?: readonly ConnectionFixture[];
  airports?: readonly AirportFixture[];
  aircraftTypes?: readonly AircraftTypeFixture[];
  tickets?: readonly TicketFixture[];
  /** Full cursor payload (base64-encoded JSON). When set, a nextURL is emitted. */
  nextCursor?: string;
  /** Base URL used when building nextURL. Defaults to https://api.flightyapp.com. */
  baseUrl?: string;
}

/**
 * Encode a full sync-page protobuf: top-level envelope with optional
 * nextURL, followed by N entity wrappers (one per record).
 */
export function encodeSyncPage(page: SyncPage): Uint8Array {
  const fields: ReturnType<typeof field>[] = [];
  if (page.nextCursor != null) {
    const base = page.baseUrl ?? "https://api.flightyapp.com";
    const nextUrl = `${base}/v1/sync/full?token=${encodeURIComponent(page.nextCursor)}`;
    fields.push(field(1, sub(subMessage([field(1, str(nextUrl))]))));
  }
  for (const a of page.airports ?? []) {
    const body = encodeAirport(a);
    fields.push(field(2, sub(subMessage([field(1, sub(body))]))));
  }
  for (const c of page.connections ?? []) {
    const body = encodeConnection(c);
    fields.push(field(2, sub(subMessage([field(5, sub(body))]))));
  }
  for (const f of page.flights ?? []) {
    const body = encodeFlight(f);
    fields.push(field(2, sub(subMessage([field(15, sub(body))]))));
  }
  for (const t of page.aircraftTypes ?? []) {
    const body = encodeAircraftType(t);
    fields.push(field(2, sub(subMessage([field(22, sub(body))]))));
  }
  for (const t of page.tickets ?? []) {
    const body = encodeTicket(t);
    fields.push(field(2, sub(subMessage([field(12, sub(body))]))));
  }
  return encodeFields(fields);
}

/** Build a base64 cursor from arbitrary JSON-like state. */
export function buildCursor(payload: Record<string, unknown>): string {
  return btoa(JSON.stringify(payload));
}
