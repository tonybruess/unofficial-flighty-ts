export interface Airport {
  readonly kind: "airport";
  readonly id: string;
  readonly iata: string | null;
  readonly icao: string | null;
  readonly name: string;
  /** Short display label combining city and IATA, e.g. "Atlanta ATL". */
  readonly displayName: string | null;
  readonly city: string;
  readonly country: string;
  readonly countryCode: string;
  /** Continent/region, e.g. "North America". */
  readonly region: string;
  readonly timezone: string | null;
  readonly website: string | null;
  readonly latitude: number;
  readonly longitude: number;
  /**
   * Search-relevance weight Flighty uses to rank airports in autocomplete.
   * Higher is more prominent (e.g. major hubs ≈ 30000; regional strips ≪).
   */
  readonly relevance: number;
  /** When Flighty first recorded this airport. */
  readonly created: Date | null;
  /** When Flighty last updated this airport's metadata. */
  readonly lastUpdated: Date | null;
}

export interface Airline {
  readonly kind: "airline";
  readonly id: string;
  readonly iata: string | null;
  readonly icao: string | null;
  readonly name: string;
  readonly callsign: string | null;
  /** Alliance membership, e.g. "STAR_ALLIANCE", "Oneworld", "SkyTeam". */
  readonly alliance: string | null;
  readonly website: string | null;
  /** E.164 phone, e.g. "+18004337300". */
  readonly phone: string | null;
  /** Twitter/X handle without the `@`, e.g. `"AmericanAir"`. */
  readonly twitterHandle: string | null;
  /** Facebook page URL, e.g. `"facebook.com/AmericanAirlines"`. */
  readonly facebookUrl: string | null;
  /** Autocomplete-relevance weight (same scheme as `Airport.relevance`). */
  readonly relevance: number;
  readonly created: Date | null;
  readonly lastUpdated: Date | null;
}

export interface AircraftType {
  readonly kind: "aircraftType";
  readonly id: string;
  /**
   * `true` when Flighty shipped this row without a wire id (usually
   * obscure catalog entries like Helio couriers). The SDK synthesizes a
   * stable id of the form `synthetic:<manufacturer>:<name>` so the row
   * still appears in `sync.aircraftTypes`. No flight will reference a
   * synthetic id — they're catalog-only.
   */
  readonly syntheticId: boolean;
  readonly iata: string | null;
  readonly icao: string | null;
  readonly name: string;
  readonly manufacturer: string | null;
  /**
   * Raw wire integer. Not credible as a seat count (777-300 ships as
   * 165, "Bus" as 197), so semantics are unverified — exposed raw.
   */
  readonly passengerCapacityRaw: number | null;
  readonly created: Date | null;
  readonly lastUpdated: Date | null;
}

/**
 * A multi-airport city like "NYC" → JFK+LGA+EWR. Used by Flighty to group
 * airports in autocomplete ("New York City") rather than picking one.
 */
export interface MetropolitanArea {
  readonly kind: "metropolitanArea";
  /** Metropolitan IATA code, e.g. "NYC", "LON", "TYO". */
  readonly id: string;
  readonly name: string;
  /** ISO 3166-1 alpha-2 country code. */
  readonly countryCode: string;
  /** Airport IDs that belong to this metro area. */
  readonly airportIds: string[];
  /** Autocomplete-relevance weight (same scheme as `Airport.relevance`). */
  readonly relevance: number;
  readonly created: Date | null;
  readonly lastUpdated: Date | null;
}

/**
 * A layover linking two flights into a single itinerary — Flighty's
 * stand-in for a "trip" record. Only emitted for the authed user's own
 * feed, never for friends' itineraries.
 */
export interface Connection {
  readonly kind: "connection";
  readonly id: string;
  /** Owner of the itinerary (always matches the authed user in practice). */
  readonly userId: string;
  /** The arriving flight's id — look up in `sync.flights` to resolve. */
  readonly inboundFlightId: string;
  /** The departing flight's id — look up in `sync.flights` to resolve. */
  readonly outboundFlightId: string;
  /** The connection airport's id — look up in `sync.airports`. */
  readonly airportId: string;
  /**
   * Flighty's four connection-time thresholds in minutes, roughly
   * "tight / typical / safe / very safe". Bucketing isn't documented —
   * treat as opaque; "below [0] is risky, above [3] is padded" holds.
   */
  readonly connectionTimeMinutesBuckets: readonly [number, number, number, number];
  readonly created: Date | null;
  readonly lastUpdated: Date | null;
  /** Tombstone timestamp; `null` for live records. Filtered by default. */
  readonly deletedAt: Date | null;
}

/** A connected friend's profile as displayed next to their flights. */
export interface UserProfile {
  readonly kind: "userProfile";
  readonly id: string;
  /** Full display name, e.g. "Jane Doe". */
  readonly name: string;
  /** First name as Flighty renders it in compact UI labels. */
  readonly firstName: string;
  readonly created: Date | null;
  readonly lastUpdated: Date | null;
}

export interface Aircraft {
  /** Registration, e.g. "N37504". */
  readonly tailNumber: string | null;
  /** Model, e.g. "Boeing 737 MAX 9". */
  readonly modelName: string | null;
  readonly manufacturer: string | null;
  /** Owner-given name (rare, e.g. Hawaiian's named tails). */
  readonly planeName: string | null;
  /** ISO 3166-1 alpha-2 country of registration. */
  readonly registrationCountry: string | null;
  /** Date this airframe first flew. */
  readonly firstFlight: Date | null;
  readonly iata: string | null;
  readonly icao: string | null;
  /** Maximum range of this aircraft type, in kilometres. */
  readonly rangeKm: number | null;
  /** Typical cruising speed of this aircraft type, in km/h. */
  readonly cruisingSpeedKmh: number | null;
  /** ID of the `AircraftType` entity this airframe belongs to. */
  readonly aircraftTypeId: string | null;
}

export interface Weather {
  /** Temperature in degrees Celsius. */
  readonly temperatureC: number | null;
  /**
   * OpenWeatherMap condition code (see openweathermap.org/weather-conditions).
   * e.g. 800 = clear, 801–804 = cloud coverage, 5xx = rain, 6xx = snow.
   */
  readonly conditionCode: number | null;
  /** Human-readable condition label, e.g. "Broken Clouds", "Overcast". */
  readonly condition: string | null;
  /** When the reading was taken at the source (OWM observation time). */
  readonly observedAt: Date | null;
}

export interface Codeshare {
  /** Marketing flight number, e.g. "5483". */
  readonly number: string;
  /** Marketing airline id (matches `Airline.id`). */
  readonly airlineId: string | null;
  /** True when this carrier actually operates the aircraft (not just markets). */
  readonly operatesAircraft: boolean;
}

export interface DelayForecast {
  /**
   * How many past operations of this flight Flighty analysed. Higher = more
   * confident signal; single-digit counts are near-noise.
   */
  readonly observations: number;
  /** Mean historical delay in minutes across those observations. */
  readonly delayMeanMinutes: number;
}

/**
 * One entry in a flight's change feed. `recordedAt` is when Flighty
 * first saw the value — genuine per-change on live flights, but often
 * a shared bulk-refresh timestamp on historic ones.
 */
export type FlightEvent =
  | GateChangeEvent
  | TailAssignmentEvent
  | ActualGateOutEvent
  | ActualGateInEvent
  | TimingRevisionEvent;

interface FlightEventBase {
  readonly recordedAt: Date;
}

/** Terminal and/or gate assignment change for the departure or arrival end. */
export interface GateChangeEvent extends FlightEventBase {
  readonly kind: "gateChange";
  /** True if this is the arrival gate/terminal; false for departure. */
  readonly isArrival: boolean;
  readonly terminal: string | null;
  readonly gate: string | null;
}

/** Tail number (aircraft registration) assigned to the flight at that time. */
export interface TailAssignmentEvent extends FlightEventBase {
  readonly kind: "tailAssignment";
  readonly tailNumber: string;
}

/** Gate-out (pushback) time Flighty observed for the flight. */
export interface ActualGateOutEvent extends FlightEventBase {
  readonly kind: "actualGateOut";
  readonly at: Date;
}

/** Gate-in (arrival block-on) time Flighty observed for the flight. */
export interface ActualGateInEvent extends FlightEventBase {
  readonly kind: "actualGateIn";
  readonly at: Date;
}

/**
 * Scheduled or estimated gate time was revised. Fires whenever Flighty learns
 * a new timing value — the most common event kind. Use this to reconstruct the
 * delay-drift timeline ("airline kept pushing back the estimate all afternoon").
 */
export interface TimingRevisionEvent extends FlightEventBase {
  readonly kind: "timingRevision";
  /** True if this revision applies to the arrival end; false for departure. */
  readonly isArrival: boolean;
  /** True when the new value is an airline estimate; false when scheduled. */
  readonly isEstimated: boolean;
  /** The revised timestamp Flighty now believes for this end of the flight. */
  readonly at: Date;
}

/**
 * Active FAA Traffic Management Initiative (Ground Stop, Ground Delay Program,
 * Airspace Flow Program, …) affecting this flight. Flighty populates it while
 * the TMI is live; the record disappears once the TMI clears.
 */
export interface FaaTmi {
  /**
   * Numeric TMI category (1 = ground delay program, 2 = ground stop,
   * …). Full mapping isn't documented; useful for grouping by type.
   */
  readonly code: number;
  /** Freeform reason, e.g. `"thunderstorms"`, `"ATC staffing"`, `"volume"`. */
  readonly reason: string;
  /** When the TMI took effect. */
  readonly startAt: Date | null;
  /** When the TMI is scheduled to lift. */
  readonly endAt: Date | null;
}

/**
 * Summary of an inbound flight Flighty ships alongside the main flight — the
 * previous leg of the same aircraft rotation. Useful to answer "where is my
 * plane coming from, and is it on time?" without a second lookup.
 */
export interface InboundFlight {
  /** Flight id — matches `Flight.id` if the user also owns this leg. */
  readonly id: string;
  /** Airline flight number (IATA). */
  readonly number: string;
  /** Airline Flighty inlined with the inbound leg (operating carrier). */
  readonly airlineId: string | null;
  readonly airlineIata: string | null;
  readonly airlineName: string | null;
  readonly departureAirportId: string | null;
  readonly arrivalAirportId: string | null;
  /** Best-available departure time (actual → estimated → scheduled). */
  readonly departureTime: Date | null;
  readonly scheduledDepartureTime: Date | null;
  readonly estimatedDepartureTime: Date | null;
  readonly actualDepartureTime: Date | null;
  /** Best-available arrival time (actual → estimated → scheduled). */
  readonly arrivalTime: Date | null;
  readonly scheduledArrivalTime: Date | null;
  readonly estimatedArrivalTime: Date | null;
  readonly actualArrivalTime: Date | null;
  readonly departureTerminal: string | null;
  readonly departureGate: string | null;
  readonly arrivalTerminal: string | null;
  readonly arrivalGate: string | null;
  readonly arrivalBaggageBelt: string | null;
}

/**
 * Fare cabin. String mapping inferred from the Mac app's strings table;
 * `"unknown"` is a forward-compat escape hatch for unseen wire values.
 */
export type CabinClass =
  | "economy"
  | "premiumEconomy"
  | "business"
  | "first"
  | "unknown";

export interface Ticket {
  readonly kind: "ticket";
  /** Shares the value of the associated flight's `id`. */
  readonly id: string;
  readonly userId: string;
  readonly pnr: string | null;
  readonly seat: string | null;
  /** Fare cabin; `null` for untagged tickets (the common case). */
  readonly cabinClass: CabinClass | null;
  /** Raw wire integer — branch on this if Flighty ships a new value. */
  readonly cabinClassRaw: number | null;
  readonly created: Date | null;
  readonly lastUpdated: Date | null;
}

export interface Flight {
  readonly kind: "flight";
  readonly id: string;
  /**
   * Owner — authed user OR a connected friend. Compare against
   * `FlightyClient.myUserId` to distinguish.
   */
  readonly userId: string;
  /** Airline flight number (IATA), e.g. "2123". */
  readonly number: string;
  /** Operational callsign (ICAO), e.g. "UAL1089". */
  readonly callsign: string | null;
  readonly airlineId: string | null;
  readonly departureAirportId: string | null;
  /**
   * Actual (or currently scheduled) arrival airport. Differs from
   * `scheduledArrivalAirportId` only on diverted flights.
   */
  readonly arrivalAirportId: string | null;
  readonly scheduledArrivalAirportId: string | null;
  /**
   * Best-available departure timestamp — actual gate-out if known,
   * otherwise estimated, otherwise scheduled.
   */
  readonly departureTime: Date | null;
  /**
   * Best-available arrival timestamp — actual gate-in if known,
   * otherwise estimated, otherwise scheduled.
   */
  readonly arrivalTime: Date | null;
  /** Originally published departure time (gate-out). */
  readonly scheduledDepartureTime: Date | null;
  /** Airline's latest estimate for departure (gate-out), if different from scheduled. */
  readonly estimatedDepartureTime: Date | null;
  /** Actual gate departure (pushback), if the flight has left the gate. */
  readonly actualDepartureTime: Date | null;
  /** Originally published arrival time (gate-in). */
  readonly scheduledArrivalTime: Date | null;
  /** Airline's latest estimate for arrival (gate-in), if different from scheduled. */
  readonly estimatedArrivalTime: Date | null;
  /** Actual gate arrival, if the flight has reached the gate. */
  readonly actualArrivalTime: Date | null;
  readonly departureTerminal: string | null;
  readonly departureGate: string | null;
  readonly arrivalTerminal: string | null;
  readonly arrivalGate: string | null;
  readonly arrivalBaggageBelt: string | null;
  /** Airline's published check-in window open time. */
  readonly checkInOpen: Date | null;
  /** Airline's published check-in window close time. */
  readonly checkInClose: Date | null;
  readonly distanceKm: number;
  readonly aircraft: Aircraft | null;
  readonly isCancelled: boolean;
  /**
   * Per-viewer archive flag. Flighty auto-archives completed flights and
   * hides them from the default "Upcoming" list.
   */
  readonly isArchived: boolean;
  /**
   * Per-viewer flag for "a flight I actually took / will take". Distinct
   * from `userId`: a calendar-imported row can land on the account with
   * `isMyFlight = false` until the user confirms it.
   */
  readonly isMyFlight: boolean;
  /** Public share link (`https://live.flighty.app/...`) if the owner enabled it. */
  readonly sharingUrl: string | null;
  /** Observed conditions at the departure airport (OWM-sourced). */
  readonly departureWeather: Weather | null;
  /** Forecast conditions at the arrival airport. */
  readonly arrivalWeather: Weather | null;
  /** Historical on-time performance for this flight number. */
  readonly delayForecast: DelayForecast | null;
  /**
   * Marketing carriers that also sell this flight. The operating carrier is
   * `airlineId` above; codeshares only appear here.
   */
  readonly codeshares: Codeshare[];
  /**
   * Per-flight change feed — gate changes, tail assignments, actual OUT/IN
   * times, etc. Sorted oldest → newest by `recordedAt`. Empty if Flighty has
   * no tracked history for this flight.
   */
  readonly events: FlightEvent[];
  /** Text reason of an active FAA TMI; shortcut for `faaTmi.reason`. */
  readonly faaTmiReason: string | null;
  /** Active FAA Traffic Management Initiative, if any. */
  readonly faaTmi: FaaTmi | null;
  /**
   * Previous rotations of the same aircraft, oldest → newest. Usually 0-1.
   */
  readonly inboundFlights: InboundFlight[];
  /**
   * Raw import-source wire code (`manual` / `email` / `calendar` / `friend`
   * / `shared` are the suspected labels; integer→string mapping unverified).
   */
  readonly importSourceRaw: number | null;
  /** When Flighty first created this record. */
  readonly created: Date | null;
  /** When Flighty last updated this record on the server. */
  readonly lastUpdated: Date | null;
  /**
   * Tombstone timestamp; `null` for live records. Filtered by default —
   * pass `{ includeDeleted: true }` to `sync()` to keep tombstones.
   */
  readonly deletedAt: Date | null;
}

export type Entity =
  | Airport
  | Airline
  | AircraftType
  | MetropolitanArea
  | UserProfile
  | Ticket
  | Flight
  | Connection;

export interface SyncResult {
  /**
   * Deduped by id (latest wire revision wins). Tombstones filtered unless
   * `includeDeleted` is set.
   */
  readonly flights: Flight[];
  readonly airports: Map<string, Airport>;
  readonly airlines: Map<string, Airline>;
  readonly aircraftTypes: Map<string, AircraftType>;
  readonly metropolitanAreas: Map<string, MetropolitanArea>;
  /** Connected friends' profiles, keyed by user id (matches `Flight.userId`). */
  readonly userProfiles: Map<string, UserProfile>;
  /** Keyed by flight id (which equals ticket id). */
  readonly tickets: Map<string, Ticket[]>;
  /**
   * Layovers linking inbound+outbound flights. Deduped; tombstones filtered
   * unless `includeDeleted` is set.
   */
  readonly connections: Connection[];
  /** Connections indexed by their inbound flight id, for O(1) graph walks. */
  readonly onwardByFlightId: Map<string, Connection[]>;
  /** Connections indexed by their outbound flight id, for O(1) graph walks. */
  readonly inboundByFlightId: Map<string, Connection[]>;
  /** The authenticated user's id, decoded from the bearer's `sub` claim. */
  readonly myUserId: string;
  /**
   * Opaque watermark. Pass back as `cursor` to resume a truncated sync or
   * fetch the delta since this point. `null` when Flighty returned no next URL.
   */
  readonly cursor: string | null;
  /** Pages fetched this sync — useful to detect `maxPages` short-circuits. */
  readonly pagesFetched: number;
  /**
   * `true` when the sync stopped at `maxPages` with a `nextURL` still
   * pending. `sync()` throws instead; `stream()` surfaces this flag.
   */
  readonly truncated: boolean;
}

export interface ResolvedFlight extends Flight {
  readonly airline: Airline | null;
  readonly departureAirport: Airport | null;
  readonly arrivalAirport: Airport | null;
  /** Resolved from `aircraft.aircraftTypeId` → `SyncResult.aircraftTypes`. */
  readonly aircraftType: AircraftType | null;
  readonly tickets: Ticket[];
  /** True when `flight.userId` matches the authenticated user. */
  readonly isMine: boolean;
  /**
   * Connections where this flight is the INBOUND leg — i.e. the user's next
   * flight departs from this arrival airport. Usually 0 or 1.
   */
  readonly onwardConnections: Connection[];
  /**
   * Connections where this flight is the OUTBOUND leg — i.e. the user
   * arrived via a prior flight that connected into this one.
   */
  readonly inboundConnections: Connection[];
}
