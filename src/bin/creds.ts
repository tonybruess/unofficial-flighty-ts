#!/usr/bin/env node
/**
 * Discover Flighty credentials from the installed macOS app and print shell
 * export lines. Works against the Flighty.app install + its CloudKit record
 * cache, so no manual token wrangling is needed.
 *
 * Usage:
 *   npx flighty-creds              # prints two export lines to stdout
 *   eval "$(npx flighty-creds)"    # ephemeral, this shell only
 *   npx flighty-creds > .env       # project-local (gitignore it!)
 *
 * The bearer is a long-lived account credential — don't paste it into
 * ~/.zshrc or other plaintext dotfiles that get backed up or synced.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const INFO_PLIST = "/Applications/Flighty.app/Contents/Info.plist";
const CLOUDKIT_DB = path.join(
  os.homedir(),
  "Library/Containers/com.flightyapp.flighty/Data/CloudKit/cloudd_db/db",
);
const RECORD_TABLE =
  "container_iCloud.com.flightyapp.flighty_RecordCache_2_RecordCache";
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

function die(msg: string): never {
  console.error(`flighty-creds: ${msg}`);
  process.exit(1);
}

function readBuildToken(): string {
  if (!fs.existsSync(INFO_PLIST)) {
    die(`Flighty.app not installed (expected ${INFO_PLIST})`);
  }
  try {
    const out = execFileSync(
      "plutil",
      ["-extract", "FlightyBuildToken", "raw", "-o", "-", INFO_PLIST],
      { encoding: "utf8" },
    ).trim();
    if (!out.startsWith("eyJ")) throw new Error("not a JWT");
    return out;
  } catch {
    die("FlightyBuildToken missing from Info.plist — app version may be < 4.9");
  }
}

function extractBearerCandidates(): string[] {
  if (!fs.existsSync(CLOUDKIT_DB)) {
    die(
      `CloudKit cache not found (${CLOUDKIT_DB}) — open Flighty.app once to sync`,
    );
  }
  // Scan every row — CloudKit can spread account-token records across
  // multiple entries. Open ro+immutable to bypass the app's write lock.
  const uri = `file:${CLOUDKIT_DB}?mode=ro&immutable=1`;
  const raw = execFileSync(
    "sqlite3",
    [uri, `SELECT hex(recordData) FROM "${RECORD_TABLE}";`],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const rows = raw.split("\n").filter((r) => r.length > 0);
  if (rows.length === 0) die("CloudKit record cache is empty");
  const candidates = new Set<string>();
  for (const hex of rows) {
    const text = Buffer.from(hex, "hex").toString("latin1");
    for (const jwt of text.match(JWT_RE) ?? []) candidates.add(jwt);
  }
  if (candidates.size === 0) die("No JWTs found in CloudKit record blobs");
  return [...candidates];
}

async function probe(bearer: string, buildToken: string): Promise<boolean> {
  const res = await fetch("https://api.flightyapp.com/v1/sync/full", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "X-Flighty-Build-Token": buildToken,
      "X-Flighty-Locale": "en_US",
      "Content-Type": "application/x-protobuf",
      Accept: "application/x-protobuf",
    },
    body: new Uint8Array(0),
  });
  await res.body?.cancel();
  return res.ok;
}

const buildToken = readBuildToken();
const candidates = extractBearerCandidates();

// Probe newest-to-oldest. CloudKit serializes the current token first and the
// `previousTokens` array after, with the known-good one near the end of the
// list. Reversing the scan usually hits on the first try.
let bearer: string | null = null;
let scanned = 0;
for (let i = candidates.length - 1; i >= 0; i--) {
  scanned += 1;
  const jwt = candidates[i]!;
  if (await probe(jwt, buildToken)) {
    bearer = jwt;
    break;
  }
}
if (!bearer) {
  die(
    `None of ${candidates.length} extracted JWT(s) accepted by the API. ` +
      "Open Flighty.app to refresh tokens and retry.",
  );
}

process.stdout.write(`export FLIGHTY_BEARER='${bearer}'\n`);
process.stdout.write(`export FLIGHTY_BUILD_TOKEN='${buildToken}'\n`);
console.error(
  `# verified against /v1/sync/full (${scanned}/${candidates.length} tried)`,
);
