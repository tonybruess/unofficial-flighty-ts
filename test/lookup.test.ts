import { test, expect } from "bun:test";
import { FlightyClient } from "../src/client.js";
import { FlightyApiError, FlightyError } from "../src/errors.js";
import { decodeSearchResponse, decodeSubscribeResponse } from "../src/parse.js";
import {
  encodeSearchResponse,
  encodeSubscribeResponse,
  type HydratedFlightFixture,
} from "./helpers/fixtures.js";
import { mockFetch } from "./helpers/mockFetch.js";
import { fakeBearer, fakeBuildToken } from "./helpers/jwt.js";

const bearer = fakeBearer("me");
const buildToken = fakeBuildToken();

const lhr = { id: "ap-lhr", iata: "LHR", name: "London Heathrow" };
const ewr = { id: "ap-ewr", iata: "EWR", name: "Newark" };
const bos = { id: "ap-bos", iata: "BOS", name: "Boston" };
const united = { id: "al-ua", iata: "UA", name: "United" };
const airCanada = { id: "al-ac", iata: "AC", name: "Air Canada" };

const ua123: HydratedFlightFixture = {
  id: "f-ua123",
  number: "123",
  airline: united,
  departureAirport: lhr,
  arrivalAirport: ewr,
  scheduledDeparture: 1_788_417_900,
  codeshares: [
    { number: "5424", airline: airCanada },
    { number: "123", airline: united, operatesAircraft: true },
  ],
  inboundFlights: [{ id: "f-ua122", number: "122", airline: united, departureAirport: ewr }],
};

// Captured `/v1/search` body for LHR→EWR on 2026-09-03 (ids swapped for
// fixtures): field 2 = route { 1: {1:{1: dep}}, 2: {1:{1: arr}} },
// field 3 = date, field 4 = "ROUTE".
function expectedSearchBody(dep: string, arr: string, date: string): Uint8Array {
  const utf8 = new TextEncoder();
  const ld = (tag: number, payload: Uint8Array) =>
    Uint8Array.from([(tag << 3) | 2, payload.length, ...payload]);
  const ref = (id: string) => ld(1, ld(1, utf8.encode(id)));
  const route = new Uint8Array([...ld(1, ref(dep)), ...ld(2, ref(arr))]);
  return new Uint8Array([
    ...ld(2, route),
    ...ld(3, utf8.encode(date)),
    ...ld(4, utf8.encode("ROUTE")),
  ]);
}

test("search() POSTs the route query and decodes hydrated rows", async () => {
  const { fetch, calls } = mockFetch([encodeSearchResponse([ua123])]);
  const client = new FlightyClient({ bearer, buildToken, fetch });
  const results = await client.search({
    departureAirportId: "ap-lhr",
    arrivalAirportId: "ap-ewr",
    date: "2026-09-03",
  });

  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("https://api.flightyapp.com/v1/search");
  expect(calls[0]!.method).toBe("POST");
  expect([...calls[0]!.body]).toEqual([...expectedSearchBody("ap-lhr", "ap-ewr", "2026-09-03")]);

  expect(results).toHaveLength(1);
  const r = results[0]!;
  expect(r.kind).toBe("flightSearchResult");
  expect(r.id).toBe("f-ua123");
  expect(r.number).toBe("123");
  expect(r.airlineId).toBe("al-ua");
  expect(r.airline?.iata).toBe("UA");
  expect(r.departureAirportId).toBe("ap-lhr");
  expect(r.departureAirport?.iata).toBe("LHR");
  expect(r.arrivalAirport?.iata).toBe("EWR");
  expect(r.scheduledArrivalAirport?.iata).toBe("EWR");
  expect(r.scheduledDepartureTime?.getTime()).toBe(1_788_417_900 * 1000);
  expect(r.codeshares.map((c) => c.airlineId)).toEqual(["al-ac", "al-ua"]);
  expect(r.codeshares[1]!.operatesAircraft).toBe(true);
  expect(r.airlines.get("al-ac")?.name).toBe("Air Canada");
  expect(r.inboundFlights[0]!.departureAirportId).toBe("ap-ewr");
  expect(r.inboundFlights[0]!.airlineIata).toBe("UA");
  expect([...r.airports.keys()].sort()).toEqual(["ap-ewr", "ap-lhr"]);
});

test("search() rejects malformed dates before hitting the network", async () => {
  const { fetch, calls } = mockFetch([]);
  const client = new FlightyClient({ bearer, buildToken, fetch });
  await expect(
    client.search({ departureAirportId: "a", arrivalAirportId: "b", date: "09/03/2026" }),
  ).rejects.toBeInstanceOf(FlightyError);
  expect(calls).toHaveLength(0);
});

test("search() returns an empty list when Flighty has no rows", async () => {
  const { fetch } = mockFetch([encodeSearchResponse([])]);
  const client = new FlightyClient({ bearer, buildToken, fetch });
  const results = await client.search({
    departureAirportId: "a",
    arrivalAirportId: "b",
    date: "2026-09-03",
  });
  expect(results).toEqual([]);
});

test("subscribeFlight() hits the app's URL shape and returns the per-viewer record", async () => {
  const { fetch, calls } = mockFetch([
    encodeSubscribeResponse({ ...ua123, userId: "me", isMyFlight: true }),
  ]);
  const client = new FlightyClient({ bearer, buildToken, fetch });
  const flight = await client.subscribeFlight("f-ua123");

  expect(calls[0]!.url).toBe(
    "https://api.flightyapp.com/v1/flight/f-ua123/subscribe?is_passenger=true&source",
  );
  expect(calls[0]!.method).toBe("POST");
  expect(calls[0]!.body).toHaveLength(0);
  expect(flight.kind).toBe("flight");
  expect(flight.id).toBe("f-ua123");
  expect(flight.userId).toBe("me");
  expect(flight.isMyFlight).toBe(true);
  expect(flight.airline?.name).toBe("United");
  expect(flight.departureAirport?.iata).toBe("LHR");
  expect(flight.arrivalAirportId).toBe("ap-ewr");
});

test("subscribeFlight({ isPassenger: false }) flips the query flag", async () => {
  const { fetch, calls } = mockFetch([
    encodeSubscribeResponse({ ...ua123, userId: "me", isMyFlight: false }),
  ]);
  const client = new FlightyClient({ bearer, buildToken, fetch });
  await client.subscribeFlight("f-ua123", { isPassenger: false });
  expect(calls[0]!.url).toMatch(/\?is_passenger=false&source$/);
});

test("subscribeFlight() fails fast on 4xx without retrying", async () => {
  const { fetch, calls } = mockFetch([], { exhaustedStatus: 404 });
  const client = new FlightyClient({ bearer, buildToken, fetch, retry: { backoffMs: 1 } });
  await expect(client.subscribeFlight("missing")).rejects.toBeInstanceOf(FlightyApiError);
  expect(calls).toHaveLength(1);
});

test("diverted flight keeps scheduled vs actual arrival airports apart", () => {
  const diverted: HydratedFlightFixture = {
    ...ua123,
    arrivalAirport: bos,
    scheduledArrivalAirport: ewr,
  };
  const [r] = decodeSearchResponse(encodeSearchResponse([diverted]));
  expect(r!.arrivalAirportId).toBe("ap-bos");
  expect(r!.scheduledArrivalAirportId).toBe("ap-ewr");
  expect(r!.arrivalAirport?.iata).toBe("BOS");
  expect(r!.scheduledArrivalAirport?.iata).toBe("EWR");
});

test("decodeSubscribeResponse() returns null for an empty payload", () => {
  expect(decodeSubscribeResponse(new Uint8Array(0))).toBeNull();
});

test("sync-style flights (id references) still decode through the shared core parser", async () => {
  const { encodeSyncPage } = await import("./helpers/fixtures.js");
  const page = encodeSyncPage({
    flights: [
      {
        id: "f1",
        userId: "me",
        isMyFlight: true,
        airlineId: "al-ua",
        departureAirportId: "ap-lhr",
        arrivalAirportId: "ap-ewr",
      },
    ],
  });
  const { fetch } = mockFetch([page]);
  const client = new FlightyClient({ bearer, buildToken, fetch });
  const sync = await client.sync();
  expect(sync.flights[0]!.airlineId).toBe("al-ua");
  expect(sync.flights[0]!.departureAirportId).toBe("ap-lhr");
  expect(sync.flights[0]!.arrivalAirportId).toBe("ap-ewr");
});
