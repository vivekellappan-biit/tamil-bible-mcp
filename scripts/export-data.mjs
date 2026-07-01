#!/usr/bin/env node
// One-off admin script: dumps every row of every table this server reads
// from your Supabase project into data/<table>.json, for seeding a fresh
// Supabase project (see scripts/seed.mjs) or for backup purposes.
//
// Usage: node scripts/export-data.mjs
// Requires SUPABASE_URL / SUPABASE_SERVICE_KEY in .env or the environment.

import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync } from "fs";
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
const PAGE_SIZE = 1000;
const TABLES = [
  "bible",
  "daily_verses",
  "mass_readings",
  "daily_saints",
  "bible_promise_box",
  "daily_quiz",
];

async function exportTable(table) {
  const rows = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  const outPath = resolve(root, "data", `${table}.json`);
  writeFileSync(outPath, JSON.stringify(rows, null, 2));
  console.log(`${table}: ${rows.length} rows -> data/${table}.json`);
}

for (const table of TABLES) {
  await exportTable(table);
}
