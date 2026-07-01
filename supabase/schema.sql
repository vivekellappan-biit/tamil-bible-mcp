-- Schema for a fresh Supabase project to back tamil-bible-mcp.
-- Run this in the Supabase SQL editor (or `psql` against your project),
-- then use `node scripts/seed.mjs` to load the bundled data/*.json dumps.

create table if not exists bible (
  field1 text not null,  -- 8-digit packed verse code: BBCCCVVV (book/chapter/verse)
  field2 text not null,  -- verse text (Tamil)
  field3 text not null   -- row type: "V" = verse, other values = headings/annotations
);

-- field1 is NOT unique (a chapter/verse position can have both a "V" verse row
-- and a "T" title/heading row sharing the same code), so no primary key here.
-- text_pattern_ops speeds up the LIKE 'prefix%' queries get_chapter/get_verse rely on.
create index if not exists idx_bible_field1 on bible (field1 text_pattern_ops);
create index if not exists idx_bible_field3 on bible (field3);

create table if not exists daily_verses (
  id bigint generated always as identity primary key,
  date text not null,   -- DD-MM-YYYY
  verse_no text,
  verse text,
  created_at timestamptz not null default now()
);
create index if not exists idx_daily_verses_date on daily_verses (date);

create table if not exists mass_readings (
  date text primary key,   -- YYYY-MM-DD
  day_title text,
  day_subtitle text,
  sections jsonb,
  created_at timestamptz not null default now()
);

create table if not exists daily_saints (
  id bigint generated always as identity primary key,
  date text not null,   -- YYYY-MM-DD
  saint_name text,
  description text,
  image_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_daily_saints_date on daily_saints (date);

create table if not exists bible_promise_box (
  id bigint generated always as identity primary key,
  verse_text text,
  verse_reference text,
  category text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_bible_promise_box_category on bible_promise_box (category);

create table if not exists daily_quiz (
  id uuid primary key default gen_random_uuid(),
  date text,
  category text,
  question text,
  options jsonb,
  correct_index int,
  explanation text,
  created_at timestamptz not null default now()
);
create index if not exists idx_daily_quiz_date on daily_quiz (date);
