import { test, expect } from "bun:test";
import { decodeEntities, extractNextUrl } from "../src/parse.js";
import {
  encodeAircraftType,
  encodeFlight,
  encodeSyncPage,
  type AircraftTypeFixture,
} from "./helpers/fixtures.js";
import { encodeFields, field, sub } from "./helpers/pb.js";

function entityWrapper(tag: number, body: Uint8Array): Uint8Array {
  return encodeFields([field(tag, sub(body))]);
}

test("decodes a basic flight with the authed user as owner", () => {
  const body = encodeFlight({
    id: "flight-1",
    userId: "me",
    number: "UA1",
    distanceKm: 1234,
    airlineId: "airline-ua",
    departureAirportId: "ap-sfo",
    arrivalAirportId: "ap-jfk",
    isMyFlight: true,
  });
  const page = encodeFields([field(2, sub(entityWrapper(15, body)))]);
  const entities = [...decodeEntities(page)];
  expect(entities).toHaveLength(1);
  const entity = entities[0]!;
  expect(entity.kind).toBe("flight");
  if (entity.kind !== "flight") throw new Error("type narrowing");
  expect(entity.id).toBe("flight-1");
  expect(entity.userId).toBe("me");
  expect(entity.number).toBe("UA1");
  expect(entity.distanceKm).toBe(1234);
  expect(entity.isMyFlight).toBe(true);
  expect(entity.deletedAt).toBeNull();
});

test("flight with deletedAt surfaces as a tombstone", () => {
  const body = encodeFlight({
    id: "flight-deleted",
    userId: "me",
    isMyFlight: true,
    deletedAt: 1_700_000_000,
  });
  const entities = [...decodeEntities(encodeFields([field(2, sub(entityWrapper(15, body)))]))];
  expect(entities).toHaveLength(1);
  const entity = entities[0]!;
  if (entity.kind !== "flight") throw new Error("expected flight");
  expect(entity.deletedAt).toBeInstanceOf(Date);
  expect(entity.deletedAt?.getTime()).toBe(1_700_000_000 * 1000);
});

test("aircraft type with a wire id round-trips", () => {
  const fx: AircraftTypeFixture = {
    id: "ac-777",
    name: "Boeing 777",
    manufacturer: "Boeing",
    iata: "777",
    icao: "B777",
  };
  const entities = [
    ...decodeEntities(encodeFields([field(2, sub(entityWrapper(22, encodeAircraftType(fx))))])),
  ];
  expect(entities).toHaveLength(1);
  const entity = entities[0]!;
  if (entity.kind !== "aircraftType") throw new Error("expected aircraftType");
  expect(entity.id).toBe("ac-777");
  expect(entity.syntheticId).toBe(false);
  expect(entity.manufacturer).toBe("Boeing");
});

test("aircraft type without a wire id synthesizes a stable id", () => {
  const fx: AircraftTypeFixture = {
    id: null,
    name: "H-295 Super Courier",
    manufacturer: "Helio",
  };
  const entities = [
    ...decodeEntities(encodeFields([field(2, sub(entityWrapper(22, encodeAircraftType(fx))))])),
  ];
  expect(entities).toHaveLength(1);
  const entity = entities[0]!;
  if (entity.kind !== "aircraftType") throw new Error("expected aircraftType");
  expect(entity.id).toBe("synthetic:Helio:H-295 Super Courier");
  expect(entity.syntheticId).toBe(true);
  expect(entity.name).toBe("H-295 Super Courier");
});

test("aircraft type with no data at all is dropped", () => {
  // No id, no name, no manufacturer — synthesis produces no useful key.
  const body = encodeAircraftType({ id: null, name: "" });
  const entities = [...decodeEntities(encodeFields([field(2, sub(entityWrapper(22, body)))]))];
  expect(entities).toHaveLength(0);
});

test("extractNextUrl reads the nextURL string out of the envelope", () => {
  const page = encodeSyncPage({
    flights: [
      { id: "f1", userId: "me", isMyFlight: true },
    ],
    nextCursor: "AAAA",
  });
  expect(extractNextUrl(page)).toMatch(/[?&]token=AAAA$/);
});

test("extractNextUrl returns null when envelope has no nextURL", () => {
  const page = encodeSyncPage({
    flights: [{ id: "f1", userId: "me", isMyFlight: true }],
  });
  expect(extractNextUrl(page)).toBeNull();
});
