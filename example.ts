/**
 * Run with: bun example.ts
 *
 * Requires FLIGHTY_BEARER and FLIGHTY_BUILD_TOKEN in the environment.
 *   FLIGHTY_BEARER       — previousTokens[1] HS512 JWT from CloudKit
 *   FLIGHTY_BUILD_TOKEN  — ES256 JWT from Flighty.app/Contents/Info.plist
 */

import { FlightyClient, resolveFlight } from "./src/index.js";

const bearer = process.env.FLIGHTY_BEARER;
const buildToken = process.env.FLIGHTY_BUILD_TOKEN;
if (!bearer || !buildToken) {
  console.error(
    "Missing credentials. Set FLIGHTY_BEARER and FLIGHTY_BUILD_TOKEN.",
  );
  process.exit(1);
}

const client = new FlightyClient({ bearer, buildToken });

const t0 = performance.now();
const sync = await client.sync();
const elapsed = (performance.now() - t0).toFixed(0);

const mine = sync.flights.filter((f) => f.userId === sync.myUserId && f.isMyFlight);
const friends = sync.flights.length - mine.length;
const totalKm = mine.reduce((acc, f) => acc + f.distanceKm, 0);

console.log(
  `Fetched ${sync.flights.length} flights in ${elapsed}ms ` +
    `(${mine.length} mine, ${friends} from friends; ` +
    `${sync.airports.size} airports, ${sync.airlines.size} airlines, ` +
    `${sync.aircraftTypes.size} aircraft types, ` +
    `${sync.metropolitanAreas.size} metros, ` +
    `${sync.userProfiles.size} friends)`,
);
console.log(`Total distance flown by me: ${totalKm.toLocaleString()} km\n`);

const recent = [...sync.flights]
  .sort(
    (a, b) =>
      (b.departureTime?.getTime() ?? 0) - (a.departureTime?.getTime() ?? 0),
  )
  .slice(0, 10);

console.log("Most recent flights:");
console.log("  date        owner   arch  flight    route         distance   delay");
for (const flight of recent) {
  const resolved = resolveFlight(flight, sync);
  const date = flight.departureTime?.toISOString().slice(0, 10) ?? "----------";
  const owner = resolved.isMine ? "me    " : "friend";
  const arch = flight.isArchived ? "archd" : "live ";
  const flightCode = `${resolved.airline?.iata ?? "??"}${flight.number || "?"}`.padEnd(8);
  const route = `${resolved.departureAirport?.iata ?? "???"} → ${resolved.arrivalAirport?.iata ?? "???"}`;
  const distance = `${flight.distanceKm.toLocaleString()} km`.padStart(10);
  const delay = formatDelay(flight.scheduledDepartureTime, flight.actualDepartureTime);
  console.log(`  ${date}  ${owner}  ${arch} ${flightCode}  ${route}  ${distance}   ${delay}`);
}

const mineSorted = [...mine].sort(
  (a, b) =>
    (b.departureTime?.getTime() ?? 0) - (a.departureTime?.getTime() ?? 0),
);
const latest = mineSorted.find((f) => f.events.length > 0) ?? mineSorted[0];
if (latest) {
  const r = resolveFlight(latest, sync);
  console.log(`\nLatest flight in detail — ${r.airline?.name ?? "??"} ${r.number}`);
  console.log(`  ${r.departureAirport?.displayName ?? "???"} → ${r.arrivalAirport?.displayName ?? "???"}`);
  if (r.aircraftType) {
    console.log(
      `  aircraft: ${r.aircraftType.manufacturer ?? ""} ${r.aircraftType.name}` +
        (r.aircraft?.tailNumber ? ` (${r.aircraft.tailNumber})` : ""),
    );
  }
  if (r.scheduledDepartureTime && r.actualDepartureTime) {
    const mins = Math.round(
      (r.actualDepartureTime.getTime() - r.scheduledDepartureTime.getTime()) / 60000,
    );
    console.log(`  pushback: ${fmtTime(r.actualDepartureTime)} (${mins >= 0 ? "+" : ""}${mins} min vs ${fmtTime(r.scheduledDepartureTime)})`);
  }
  if (r.arrivalWeather) {
    const temp = r.arrivalWeather.temperatureC !== null ? `${r.arrivalWeather.temperatureC}°C` : "";
    console.log(`  arrival weather: ${r.arrivalWeather.condition ?? "?"} ${temp}`.trim());
  }
  if (r.delayForecast) {
    console.log(
      `  on-time history: ${r.delayForecast.delayMeanMinutes} min mean delay over ${r.delayForecast.observations} operations`,
    );
  }
  if (r.codeshares.length > 0) {
    const labels = r.codeshares.slice(0, 3).map((c) => {
      const carrier = c.airlineId ? (sync.airlines.get(c.airlineId)?.iata ?? "??") : "??";
      return `${carrier}${c.number}`;
    });
    console.log(`  codeshares: ${labels.join(", ")}${r.codeshares.length > 3 ? ` (+${r.codeshares.length - 3} more)` : ""}`);
  }
  if (r.sharingUrl) console.log(`  share: ${r.sharingUrl}`);
  if (r.events.length > 0) {
    const shown = r.events.slice(-5);
    console.log(`  change feed (${r.events.length} events, last ${shown.length}):`);
    for (const ev of shown) {
      const when = ev.recordedAt.toISOString().slice(0, 19).replace("T", " ");
      switch (ev.kind) {
        case "gateChange":
          console.log(`    ${when}  ${ev.isArrival ? "arr" : "dep"} gate → terminal ${ev.terminal ?? "?"} gate ${ev.gate ?? "?"}`);
          break;
        case "tailAssignment":
          console.log(`    ${when}  tail → ${ev.tailNumber}`);
          break;
        case "actualGateOut":
          console.log(`    ${when}  pushback at ${fmtTime(ev.at)}`);
          break;
        case "actualGateIn":
          console.log(`    ${when}  block-in at ${fmtTime(ev.at)}`);
          break;
        case "timingRevision":
          console.log(
            `    ${when}  ${ev.isArrival ? "arr" : "dep"} ${ev.isEstimated ? "estimated" : "scheduled"} → ${fmtTime(ev.at)}`,
          );
          break;
      }
    }
  }
}

function formatDelay(scheduled: Date | null, actual: Date | null): string {
  if (!scheduled || !actual) return "    -";
  const mins = Math.round((actual.getTime() - scheduled.getTime()) / 60000);
  if (mins === 0) return "on time";
  return `${mins > 0 ? "+" : ""}${mins} min`.padStart(7);
}

function fmtTime(d: Date): string {
  return d.toISOString().slice(11, 16) + "Z";
}
