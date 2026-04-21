import { test, expect } from "bun:test";
import { FlightyClient } from "../src/client.js";
import { computeStats } from "../src/stats.js";
import { encodeSyncPage } from "./helpers/fixtures.js";
import { mockFetch } from "./helpers/mockFetch.js";
import { fakeBearer, fakeBuildToken } from "./helpers/jwt.js";

const bearer = fakeBearer("me");
const buildToken = fakeBuildToken();

async function buildSync(page: Parameters<typeof encodeSyncPage>[0]) {
  const { fetch } = mockFetch([encodeSyncPage(page)]);
  const client = new FlightyClient({ bearer, buildToken, fetch });
  return client.sync();
}

test("byCountry counts a domestic flight only once", async () => {
  // SFO → JFK: both in US. Flight should show up under "US" with
  // flightCount=1, not 2.
  const sync = await buildSync({
    airports: [
      { id: "ap-sfo", iata: "SFO", countryCode: "US", country: "United States" },
      { id: "ap-jfk", iata: "JFK", countryCode: "US", country: "United States" },
    ],
    flights: [
      {
        id: "f-dom",
        userId: "me",
        isMyFlight: true,
        distanceKm: 4100,
        departureAirportId: "ap-sfo",
        arrivalAirportId: "ap-jfk",
      },
    ],
  });
  const stats = computeStats(sync);
  const us = stats.byCountry.find((b) => b.key === "US");
  expect(us).toBeDefined();
  expect(us!.flightCount).toBe(1);
  expect(us!.distanceKm).toBe(4100);
});

test("byCountry counts an international flight once per country", async () => {
  const sync = await buildSync({
    airports: [
      { id: "ap-sfo", iata: "SFO", countryCode: "US", country: "United States" },
      { id: "ap-lhr", iata: "LHR", countryCode: "GB", country: "United Kingdom" },
    ],
    flights: [
      {
        id: "f-intl",
        userId: "me",
        isMyFlight: true,
        distanceKm: 8600,
        departureAirportId: "ap-sfo",
        arrivalAirportId: "ap-lhr",
      },
    ],
  });
  const stats = computeStats(sync);
  expect(stats.byCountry.map((b) => b.key).sort()).toEqual(["GB", "US"]);
  for (const b of stats.byCountry) {
    expect(b.flightCount).toBe(1);
    expect(b.distanceKm).toBe(8600);
  }
});

test("onlyMine default drops friends' and unconfirmed-import flights", async () => {
  const sync = await buildSync({
    airports: [
      { id: "ap-sfo", iata: "SFO", countryCode: "US" },
      { id: "ap-jfk", iata: "JFK", countryCode: "US" },
    ],
    flights: [
      {
        id: "mine",
        userId: "me",
        isMyFlight: true,
        distanceKm: 100,
        departureAirportId: "ap-sfo",
        arrivalAirportId: "ap-jfk",
      },
      {
        id: "unconfirmed",
        userId: "me",
        isMyFlight: false,
        distanceKm: 200,
        departureAirportId: "ap-sfo",
        arrivalAirportId: "ap-jfk",
      },
      {
        id: "friend",
        userId: "friend",
        isMyFlight: true,
        distanceKm: 400,
        departureAirportId: "ap-sfo",
        arrivalAirportId: "ap-jfk",
      },
    ],
  });
  const stats = computeStats(sync); // default onlyMine: true
  expect(stats.flightCount).toBe(1);
  expect(stats.totalDistanceKm).toBe(100);
});

test("onlyMine=false counts everything including friends", async () => {
  const sync = await buildSync({
    airports: [
      { id: "ap-sfo", iata: "SFO", countryCode: "US" },
      { id: "ap-jfk", iata: "JFK", countryCode: "US" },
    ],
    flights: [
      {
        id: "mine",
        userId: "me",
        isMyFlight: true,
        distanceKm: 100,
        departureAirportId: "ap-sfo",
        arrivalAirportId: "ap-jfk",
      },
      {
        id: "friend",
        userId: "friend",
        isMyFlight: true,
        distanceKm: 400,
        departureAirportId: "ap-sfo",
        arrivalAirportId: "ap-jfk",
      },
    ],
  });
  const stats = computeStats(sync, { onlyMine: false });
  expect(stats.flightCount).toBe(2);
  expect(stats.totalDistanceKm).toBe(500);
});

test("cancelled flights are excluded by default", async () => {
  const sync = await buildSync({
    airports: [{ id: "ap-sfo", iata: "SFO", countryCode: "US" }],
    flights: [
      {
        id: "normal",
        userId: "me",
        isMyFlight: true,
        distanceKm: 100,
        departureAirportId: "ap-sfo",
        arrivalAirportId: "ap-sfo",
      },
      {
        id: "cancelled",
        userId: "me",
        isMyFlight: true,
        isCancelled: true,
        distanceKm: 500,
        departureAirportId: "ap-sfo",
        arrivalAirportId: "ap-sfo",
      },
    ],
  });
  const stats = computeStats(sync);
  expect(stats.flightCount).toBe(1);
  expect(stats.totalDistanceKm).toBe(100);
});
