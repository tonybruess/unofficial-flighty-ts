import { Message, readFields } from "./wire.js";
import type {
  Aircraft,
  AircraftType,
  Airline,
  Airport,
  Codeshare,
  Connection,
  DelayForecast,
  Entity,
  FaaTmi,
  Flight,
  FlightEvent,
  InboundFlight,
  MetropolitanArea,
  Ticket,
  UserProfile,
  Weather,
} from "./types.js";

export function* decodeEntities(buf: Uint8Array): Generator<Entity> {
  for (const f of readFields(buf)) {
    if (f.tag !== 2 || f.wire !== 2) continue;
    const entity = parseEntity(f.value as Uint8Array);
    if (entity) yield entity;
  }
}

export function extractNextUrl(buf: Uint8Array): string | null {
  const root = new Message(buf);
  return root.sub(1)?.str(1) ?? null;
}

function parseEntity(buf: Uint8Array): Entity | null {
  for (const f of readFields(buf)) {
    if (f.wire !== 2) return null;
    const body = f.value as Uint8Array;
    switch (f.tag) {
      case 1:
        return parseAirport(body);
      case 2:
        return parseAirline(body);
      case 5:
        return parseConnection(body);
      case 8:
        return parseUserProfile(body);
      case 12:
        return parseTicket(body);
      case 15:
        return parseFlight(body);
      case 19:
        return parseMetropolitanArea(body);
      case 22:
        return parseAircraftType(body);
      default:
        return null;
    }
  }
  return null;
}

function parseAirport(buf: Uint8Array): Airport | null {
  const m = new Message(buf);
  const id = m.str(1);
  if (!id) return null;
  const coord = m.sub(6);
  return {
    kind: "airport",
    id,
    name: m.str(2) ?? "",
    iata: m.str(3),
    icao: m.str(4),
    timezone: m.str(5),
    city: m.str(7) ?? "",
    country: m.str(8) ?? "",
    countryCode: m.str(9) ?? "",
    region: m.str(10) ?? "",
    website: m.str(15),
    displayName: m.str(16),
    latitude: coord?.double(1) ?? 0,
    longitude: coord?.double(2) ?? 0,
    relevance: m.int(11) ?? 0,
    created: toDate(m.sub(12)?.int(1) ?? null),
    lastUpdated: toDate(m.sub(13)?.int(1) ?? null),
  };
}

function parseAirline(buf: Uint8Array): Airline | null {
  const m = new Message(buf);
  const id = m.str(1);
  if (!id) return null;
  return {
    kind: "airline",
    id,
    name: m.str(2) ?? "",
    iata: m.str(3),
    icao: m.str(4),
    website: m.str(5),
    twitterHandle: m.str(6),
    callsign: m.str(7),
    phone: m.str(8),
    facebookUrl: m.str(9),
    alliance: m.str(10),
    relevance: m.int(12) ?? 0,
    created: toDate(m.sub(13)?.int(1) ?? null),
    lastUpdated: toDate(m.sub(14)?.int(1) ?? null),
  };
}

function parseMetropolitanArea(buf: Uint8Array): MetropolitanArea | null {
  // Repeated airport IDs on tag 4 — need manual collection to preserve order.
  let id: string | null = null;
  let name: string | null = null;
  let countryCode: string | null = null;
  let relevance = 0;
  let created: number | null = null;
  let lastUpdated: number | null = null;
  const airportIds: string[] = [];
  const utf8 = new TextDecoder();
  for (const f of readFields(buf)) {
    switch (f.tag) {
      case 1:
        if (f.wire === 2) id = utf8.decode(f.value as Uint8Array);
        break;
      case 2:
        if (f.wire === 2) name = utf8.decode(f.value as Uint8Array);
        break;
      case 3:
        if (f.wire === 2) countryCode = utf8.decode(f.value as Uint8Array);
        break;
      case 4:
        if (f.wire === 2) airportIds.push(utf8.decode(f.value as Uint8Array));
        break;
      case 5:
        if (f.wire === 0) relevance = Number(f.value);
        break;
      case 6:
        if (f.wire === 2) created = new Message(f.value as Uint8Array).int(1);
        break;
      case 7:
        if (f.wire === 2) lastUpdated = new Message(f.value as Uint8Array).int(1);
        break;
    }
  }
  if (!id) return null;
  return {
    kind: "metropolitanArea",
    id,
    name: name ?? "",
    countryCode: countryCode ?? "",
    airportIds,
    relevance,
    created: toDate(created),
    lastUpdated: toDate(lastUpdated),
  };
}

function parseConnection(buf: Uint8Array): Connection | null {
  const m = new Message(buf);
  const id = m.str(1);
  const inboundFlightId = m.str(2);
  const outboundFlightId = m.str(3);
  const airport = m.sub(4);
  const airportId = airport?.str(1) ?? null;
  const userId = m.str(5);
  if (!id || !inboundFlightId || !outboundFlightId || !airportId || !userId) return null;
  const bucketMsg = m.sub(9);
  const buckets: [number, number, number, number] = [
    bucketMsg?.int(1) ?? 0,
    bucketMsg?.int(2) ?? 0,
    bucketMsg?.int(3) ?? 0,
    bucketMsg?.int(4) ?? 0,
  ];
  return {
    kind: "connection",
    id,
    userId,
    inboundFlightId,
    outboundFlightId,
    airportId,
    connectionTimeMinutesBuckets: buckets,
    created: toDate(m.sub(6)?.int(1) ?? null),
    lastUpdated: toDate(m.sub(7)?.int(1) ?? null),
    deletedAt: toDate(m.sub(8)?.int(1) ?? null),
  };
}

function parseUserProfile(buf: Uint8Array): UserProfile | null {
  const m = new Message(buf);
  const id = m.str(1);
  if (!id) return null;
  return {
    kind: "userProfile",
    id,
    name: m.str(2) ?? "",
    firstName: m.str(3) ?? "",
    created: toDate(m.sub(4)?.int(1) ?? null),
    lastUpdated: toDate(m.sub(5)?.int(1) ?? null),
  };
}

function parseAircraftType(buf: Uint8Array): AircraftType | null {
  const m = new Message(buf);
  const wireId = m.str(1);
  const name = m.str(2) ?? "";
  const iata = m.str(3);
  const icao = m.str(4);
  const manufacturer = m.str(5);
  // Some catalog rows ship without a wire id (obscure types like Helio
  // couriers). Synthesize a stable key so they still land in
  // `sync.aircraftTypes`; no flight will reference a synthetic id.
  const hasAnyData = Boolean(name || iata || icao || manufacturer);
  const id = wireId ?? (hasAnyData ? `synthetic:${manufacturer ?? ""}:${name}` : null);
  if (!id) return null;
  return {
    kind: "aircraftType",
    id,
    syntheticId: wireId === null,
    name,
    iata,
    icao,
    manufacturer,
    passengerCapacityRaw: m.int(9),
    created: toDate(m.sub(6)?.int(1) ?? null),
    lastUpdated: toDate(m.sub(7)?.int(1) ?? null),
  };
}

function parseTicket(buf: Uint8Array): Ticket | null {
  const m = new Message(buf);
  const id = m.str(1);
  const userId = m.str(6);
  if (!id || !userId) return null;
  const cabinRaw = m.int(5);
  return {
    kind: "ticket",
    id,
    userId,
    pnr: m.str(2),
    seat: m.str(3),
    cabinClass: cabinClassFromCode(cabinRaw),
    cabinClassRaw: cabinRaw,
    created: toDate(m.sub(7)?.int(1) ?? null),
    lastUpdated: toDate(m.sub(8)?.int(1) ?? null),
  };
}

function cabinClassFromCode(code: number | null): import("./types.js").CabinClass | null {
  switch (code) {
    case null:
    case 0:
      return null;
    case 1:
      return "economy";
    case 2:
      return "premiumEconomy";
    case 3:
      return "business";
    case 4:
      return "first";
    default:
      return "unknown";
  }
}

function parseFlight(buf: Uint8Array): Flight | null {
  const m = new Message(buf);
  const id = m.str(1);
  const core = m.sub(2);
  if (!id || !core) return null;

  const dep = core.sub(2);
  const arr = core.sub(3);
  const ac = core.sub(7);

  let departureAirportId: string | null = null;
  let departureTerminal: string | null = null;
  let departureGate: string | null = null;
  let checkInOpen: number | null = null;
  let checkInClose: number | null = null;
  let departureWeather: Weather | null = null;
  let depTiming: TimingValues = EMPTY_TIMING;
  if (dep) {
    departureAirportId = dep.str(11);
    depTiming = readTiming(dep.sub(4));
    departureTerminal = dep.str(2);
    departureGate = dep.str(3);
    const checkIn = dep.sub(8);
    checkInOpen = checkIn?.sub(1)?.int(1) ?? null;
    checkInClose = checkIn?.sub(2)?.int(1) ?? null;
    departureWeather = parseWeather(dep.sub(9));
  }
  let arrivalAirportId: string | null = null;
  let scheduledArrivalAirportId: string | null = null;
  let arrivalTerminal: string | null = null;
  let arrivalGate: string | null = null;
  let arrivalBaggageBelt: string | null = null;
  let arrivalWeather: Weather | null = null;
  let arrTiming: TimingValues = EMPTY_TIMING;
  if (arr) {
    scheduledArrivalAirportId = arr.str(13);
    arrivalAirportId = arr.str(14) ?? scheduledArrivalAirportId;
    arrTiming = readTiming(arr.sub(7));
    arrivalTerminal = arr.str(3);
    arrivalGate = arr.str(4);
    arrivalBaggageBelt = arr.str(5);
    arrivalWeather = parseWeather(arr.sub(6));
  }

  let aircraft: Aircraft | null = null;
  if (ac) {
    const firstFlightStr = ac.str(7);
    aircraft = {
      tailNumber: ac.str(1),
      modelName: ac.str(2),
      manufacturer: ac.str(11),
      planeName: ac.str(9),
      registrationCountry: ac.str(10),
      firstFlight: firstFlightStr ? new Date(`${firstFlightStr}T00:00:00Z`) : null,
      iata: ac.str(5),
      icao: ac.str(6),
      rangeKm: ac.int(3),
      cruisingSpeedKmh: ac.int(4),
      aircraftTypeId: ac.str(12),
    };
  }

  const codeshares: Codeshare[] = core.subs(6).flatMap((cs) => {
    const number = cs.str(2);
    return number
      ? [{ number, airlineId: cs.str(4), operatesAircraft: cs.bool(3) ?? false }]
      : [];
  });

  const events = parseEvents(core.subs(11));
  const inboundFlights = core.subs(10).flatMap(parseInboundFlight);
  const faaTmi = parseFaaTmi(core.sub(18));

  return {
    kind: "flight",
    id,
    userId: m.str(9) ?? "",
    number: core.str(16) ?? "",
    callsign: core.str(8),
    airlineId: core.str(21),
    departureAirportId,
    arrivalAirportId,
    scheduledArrivalAirportId,
    departureTime: toDate(depTiming.best),
    arrivalTime: toDate(arrTiming.best),
    scheduledDepartureTime: toDate(depTiming.scheduled),
    estimatedDepartureTime: toDate(depTiming.estimated),
    actualDepartureTime: toDate(depTiming.actualGate),
    scheduledArrivalTime: toDate(arrTiming.scheduled),
    estimatedArrivalTime: toDate(arrTiming.estimated),
    actualArrivalTime: toDate(arrTiming.actualGate),
    departureTerminal,
    departureGate,
    arrivalTerminal,
    arrivalGate,
    arrivalBaggageBelt,
    checkInOpen: toDate(checkInOpen),
    checkInClose: toDate(checkInClose),
    distanceKm: core.int(17) ?? 0,
    aircraft,
    isCancelled: core.bool(5) ?? false,
    isArchived: m.bool(3) ?? false,
    isMyFlight: m.bool(5) ?? false,
    sharingUrl: m.str(10),
    departureWeather,
    arrivalWeather,
    delayForecast: parseDelayForecast(core.sub(12)),
    codeshares,
    events,
    faaTmiReason: faaTmi?.reason ?? null,
    faaTmi,
    inboundFlights,
    importSourceRaw: m.int(7),
    created: toDate(core.sub(13)?.int(1) ?? null),
    lastUpdated: toDate(core.sub(14)?.int(1) ?? null),
    deletedAt: toDate(m.sub(13)?.int(1) ?? null),
  };
}

function parseInboundFlight(m: Message): InboundFlight[] {
  const id = m.str(1);
  if (!id) return [];
  const dep = m.sub(2);
  const arr = m.sub(3);
  const airline = m.sub(4);
  const depTiming = readTiming(dep?.sub(4));
  const arrTiming = readTiming(arr?.sub(7));
  return [
    {
      id,
      number: m.str(16) ?? "",
      airlineId: airline?.str(1) ?? null,
      airlineIata: airline?.str(3) ?? null,
      airlineName: airline?.str(2) ?? null,
      departureAirportId: dep?.str(11) ?? null,
      arrivalAirportId: arr?.str(14) ?? arr?.str(13) ?? null,
      departureTime: toDate(depTiming.best),
      scheduledDepartureTime: toDate(depTiming.scheduled),
      estimatedDepartureTime: toDate(depTiming.estimated),
      actualDepartureTime: toDate(depTiming.actualGate),
      arrivalTime: toDate(arrTiming.best),
      scheduledArrivalTime: toDate(arrTiming.scheduled),
      estimatedArrivalTime: toDate(arrTiming.estimated),
      actualArrivalTime: toDate(arrTiming.actualGate),
      departureTerminal: dep?.str(2) ?? null,
      departureGate: dep?.str(3) ?? null,
      arrivalTerminal: arr?.str(3) ?? null,
      arrivalGate: arr?.str(4) ?? null,
      arrivalBaggageBelt: arr?.str(5) ?? null,
    },
  ];
}

function parseFaaTmi(m: Message | undefined): FaaTmi | null {
  if (!m) return null;
  const reason = m.str(4);
  if (!reason) return null;
  return {
    code: m.int(1) ?? 0,
    reason,
    startAt: toDate(m.sub(2)?.int(1) ?? null),
    endAt: toDate(m.sub(3)?.int(1) ?? null),
  };
}

function parseEvents(records: Message[]): FlightEvent[] {
  const events: FlightEvent[] = [];
  for (const rec of records) {
    const recordedSec = rec.sub(1)?.int(1) ?? null;
    if (!recordedSec || recordedSec <= 0) continue;
    const recordedAt = new Date(recordedSec * 1000);
    const gate = rec.sub(6);
    if (gate) {
      events.push({
        kind: "gateChange",
        recordedAt,
        isArrival: gate.bool(1) ?? false,
        terminal: gate.str(2),
        gate: gate.str(3),
      });
      continue;
    }
    const tail = rec.sub(10)?.str(1);
    if (tail) {
      events.push({ kind: "tailAssignment", recordedAt, tailNumber: tail });
      continue;
    }
    const ooi = rec.sub(5);
    if (ooi) {
      const which = ooi.int(1) ?? 0;
      const at = toDate(ooi.sub(2)?.int(1) ?? null);
      if (at && (which === 1 || which === 4)) {
        events.push({
          kind: which === 1 ? "actualGateOut" : "actualGateIn",
          recordedAt,
          at,
        });
        continue;
      }
    }
    const timing = rec.sub(9);
    if (timing) {
      const at = toDate(timing.sub(4)?.int(1) ?? null);
      if (at) {
        events.push({
          kind: "timingRevision",
          recordedAt,
          isArrival: timing.bool(1) ?? false,
          isEstimated: timing.bool(2) ?? false,
          at,
        });
      }
    }
  }
  events.sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());
  return events;
}

function parseWeather(m: Message | undefined): Weather | null {
  if (!m) return null;
  const temperatureC = m.int(1);
  const conditionCode = m.int(2);
  const condition = m.str(5);
  const observedAt = toDate(m.sub(8)?.int(1) ?? null);
  if (
    temperatureC === null &&
    conditionCode === null &&
    !condition &&
    !observedAt
  ) {
    return null;
  }
  return { temperatureC, conditionCode, condition, observedAt };
}

function parseDelayForecast(m: Message | undefined): DelayForecast | null {
  if (!m) return null;
  const observations = m.int(1);
  const delayMeanMinutes = m.int(2);
  if (observations === null || delayMeanMinutes === null) return null;
  return { observations, delayMeanMinutes };
}

interface TimingValues {
  /** Scheduled gate time (out for departure, in for arrival). */
  scheduled: number | null;
  /** Airline's current estimate for the gate time. */
  estimated: number | null;
  /** Actual gate time — pushback (dep) or block-on (arr). */
  actualGate: number | null;
  /** Best-available value: actualGate → estimated → scheduled. */
  best: number | null;
}

const EMPTY_TIMING: TimingValues = {
  scheduled: null,
  estimated: null,
  actualGate: null,
  best: null,
};

function readTiming(timing: Message | undefined): TimingValues {
  if (!timing) return EMPTY_TIMING;
  const seconds = (tag: number): number | null => {
    const s = timing.sub(tag)?.int(1);
    return s && s > 0 ? s : null;
  };
  const scheduled = seconds(1);
  const estimated = seconds(2);
  const actualGate = seconds(6);
  return {
    scheduled,
    estimated,
    actualGate,
    best: actualGate ?? estimated ?? scheduled,
  };
}

function toDate(seconds: number | null): Date | null {
  return seconds && seconds > 0 ? new Date(seconds * 1000) : null;
}
