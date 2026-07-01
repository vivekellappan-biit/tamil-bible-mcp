#!/usr/bin/env node
// Loads the bundled data/*.json dumps into a Supabase project.
// Run supabase/schema.sql in your project first, then:
//
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/seed.mjs
//
// Safe to re-run: uses insert in batches, so re-running against an
// already-seeded project will fail on unique/PK conflicts rather than
// silently duplicating rows.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

try {
  const envContent = readFileSync(resolve(root, ".env"), "utf-8");
  for (const line of envContent.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) {
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
  }
} catch { /* rely on real env vars */ }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const BATCH_SIZE = 500;
const TABLES = [
  "bible",
  "daily_verses",
  "mass_readings",
  "daily_saints",
  "bible_promise_box",
  "daily_quiz",
];

async function seedTable(table) {
  const path = resolve(root, "data", `${table}.json`);
  const rows = JSON.parse(readFileSync(path, "utf-8"));
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from(table).insert(batch);
    if (error) throw new Error(`${table} (rows ${i}-${i + batch.length}): ${error.message}`);
    inserted += batch.length;
  }
  console.log(`${table}: inserted ${inserted} rows`);
}

for (const table of TABLES) {
  await seedTable(table);
}
