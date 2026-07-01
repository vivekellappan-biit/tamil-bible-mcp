# Tamil Bible MCP Server — Detailed Report

This document explains what the project is, how it works internally, and what you (the project owner) need to
provide or maintain for it to run. It's a companion to `CLAUDE.md` (which is terse guidance for AI coding
agents) — this is the human-readable deep dive.

Note on scope: this report describes the system as it exists in the code today. It is not a build history —
there's no git repository or commit log in this project to draw a timeline from, so the "development" section
below describes *design decisions visible in the code*, not a narrative of who wrote what and when.

---

## 1. What it is, in one paragraph

A small [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server that lets an AI assistant (Claude
Desktop, Claude Code, or any other MCP client) query the Tamil Roman Catholic Bible and related daily-devotional
content — verses, chapters, keyword search, daily readings, saint of the day, promise-box verses, and a daily
quiz. It talks to the assistant over **stdio** (standard input/output), and to its data store over the network
via **Supabase** (hosted Postgres + REST API).

---

## 2. How it works

### 2.1 Process lifecycle

1. An MCP client (e.g. Claude Desktop) launches `node dist/index.js` as a subprocess, per the config in
   `.mcp.json`.
2. On startup, `src/index.ts` (compiled to `dist/index.js`) does, in order:
   - Manually reads `../.env` (relative to `dist/`) and copies each `KEY=VALUE` line into `process.env`. This is
     a ~10-line hand-rolled parser — there is no `dotenv` dependency. If the file is missing, it silently falls
     through to whatever real environment variables are already set (e.g. injected by the MCP client via
     `.mcp.json`'s `env` field).
   - Reads `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` from `process.env`. If either is missing, it prints an
     error to stderr and calls `process.exit(1)` — the server refuses to start rather than run in a degraded
     mode.
   - Creates a Supabase client (`@supabase/supabase-js`) using those credentials.
   - Loads `dist/books.json` (a static copy of `src/books.json`, placed there by the build step) into memory as
     a `Record<bookNo, BookEntry>` map, keyed by zero-padded two-digit strings `"01"`–`"75"`.
   - Registers 11 tools on an `McpServer` instance (see §2.3).
   - Connects a `StdioServerTransport` and starts serving. From this point, the process just reads JSON-RPC-ish
     MCP requests from stdin and writes responses to stdout — it has no HTTP server, no ports, no logging
     beyond stderr.
3. The client calls tools by name with a JSON args object matching each tool's Zod schema; the server validates
   args, executes, and returns `{ content: [{ type: "text", text: "<JSON string>" }], isError?: boolean }`.

### 2.2 Two data sources, used differently

- **`books.json` (static, bundled, in-memory)** — 75 entries, one per Bible book, each with: `bookNo` (string
  "01"–"75"), `bookNameEnglish`, `bookFullnameTamil`, `bookNameTamil`, `bookshortName`, `bookOldName`, `count`
  (chapter count), and `introduction` (an HTML blurb — historical/authorship background, stripped of tags on
  demand by `stripHtml`). This never touches the network; it's loaded once at process start and used for
  metadata lookups and to decorate verse results with human-readable book names in both languages.
- **Supabase Postgres (live, queried per-request)** — actual verse text and all devotional content live here.
  Every `get_verse` / `get_chapter` / `search_verses` / daily-content call is a live network round trip. There
  is no local cache or fallback; if Supabase is unreachable, tools return an error response.

### 2.3 The verse addressing scheme (the trickiest part)

Verses are stored in a single Postgres table `bible` with three flat columns: `field1`, `field2`, `field3`.
There's no `book_id` / `chapter` / `verse` columns — instead, `field1` is an **8-digit packed string**:

```
field1 = BB CCC VVV
         │  │   └── verse number, zero-padded to 3 digits
         │  └────── chapter number, zero-padded to 3 digits
         └───────── book number, zero-padded to 2 digits
```

- `field2` — the verse text (Tamil).
- `field3` — a row-type flag; `"V"` marks an actual verse row (used to filter out non-verse rows during
  keyword search).

Four small helper functions in `src/index.ts` encode/decode this scheme, and **must stay consistent with each
other** if the format ever changes:

| Function | Purpose |
|---|---|
| `bookIdToCode(book, chapter, verse)` | builds the full 8-digit code for an exact verse lookup |
| `bookChapterPrefix(book, chapter)` | builds the 5-digit prefix for a whole-chapter `LIKE 'prefix%'` query |
| `bookPrefix(book)` | builds the 2-digit prefix for a whole-book filter |
| `parseVerseCode(code)` | reverses the encoding, splitting a code back into `{book, chapter, verse}` |

Because there's no dedicated index on decomposed columns, chapter and book-scoped queries rely on Postgres
`LIKE 'prefix%'` on the `field1` text column, ordered by `field1` ascending (which happens to sort correctly
because all three components are fixed-width zero-padded).

### 2.4 The 11 tools

All tools follow the same response envelope: `{ content: [{ type: "text", text: JSON.stringify(...) }] }`,
with `isError: true` added on not-found/failure instead of throwing an exception. This means MCP clients never
see a transport-level error for "verse not found" — they see a normal tool result flagged as an error, with a
human-readable message.

| # | Tool | Input | Behavior |
|---|---|---|---|
| 1 | `list_books` | *(none)* | Returns all 75 books from `books.json`, with `testament` computed as `"Old Testament"` if book number ≤ 48, else `"New Testament"`. |
| 2 | `get_book_info` | `book` (1–75) | Returns one book's metadata plus its `introduction`, with HTML tags stripped via regex (`stripHtml`). |
| 3 | `get_verse` | `book`, `chapter`, `verse` | Encodes the address with `bookIdToCode`, does an exact `.eq("field1", code).single()` query against `bible`. |
| 4 | `get_chapter` | `book`, `chapter` | `LIKE` query on the chapter prefix, returns every row for that chapter, formatted and ordered. |
| 5 | `search_verses` | `query`, `limit` (≤50, default 10), `book?` | Case-insensitive `ILIKE '%query%'` on `field2`, restricted to `field3 = "V"` (real verses only), optionally scoped to one book via prefix `LIKE`. |
| 6 | `get_daily_verse` | `date?` (DD-MM-YYYY, defaults today) | Looks up `daily_verses` table by exact date match. |
| 7 | `get_mass_readings` | `date?` (YYYY-MM-DD, defaults today) | Looks up `mass_readings` table — readings/psalm/gospel for Catholic daily Mass. |
| 8 | `get_daily_saint` | `date?` (YYYY-MM-DD, defaults today) | Looks up `daily_saints` table. |
| 9 | `get_promise_box` | `category?`, `random` (default true) | Queries `bible_promise_box`, optionally filtered by category (case-insensitive), returns either a random row or the first row. |
| 10 | `list_promise_categories` | *(none)* | Pulls all `category` values from `bible_promise_box` and de-duplicates + sorts them client-side (in JS, not SQL). |
| 11 | `get_daily_quiz` | `date?` (YYYY-MM-DD, defaults today) | Looks up `daily_quiz` table. |

**Note the date format inconsistency**: `get_daily_verse` expects `DD-MM-YYYY`, while
`get_mass_readings`/`get_daily_saint`/`get_daily_quiz` expect `YYYY-MM-DD`. This isn't a bug in the code so much
as a reflection of however the underlying tables actually store their `date` column — but it's a sharp edge
worth knowing about if you're calling these tools programmatically or debugging a "not found" response.

### 2.5 formatVerseRow — the shared verse decorator

`get_verse`, `get_chapter`, and `search_verses` all funnel their raw Supabase rows through `formatVerseRow`,
which:
1. Decodes `field1` back into `{book, chapter, verse}` via `parseVerseCode`.
2. Looks up the book's English/Tamil names from the in-memory `BOOKS` map.
3. Emits a consistent shape: `reference` (English, e.g. `"Genesis 1:1"`), `tamil_reference` (Tamil), plus raw
   `book_number`/`chapter`/`verse`, `text` (verse content), and `type` (the raw `field3` flag).

---

## 3. Tech stack

- **Language**: TypeScript, compiled with `tsc` (no bundler — output is plain ES2022/Node16 modules in `dist/`).
- **Runtime**: Node.js, ESM (`"type": "module"` in `package.json`).
- **MCP SDK**: `@modelcontextprotocol/sdk` — provides `McpServer` and `StdioServerTransport`.
- **Data access**: `@supabase/supabase-js` — thin Postgrest client, no ORM.
- **Validation**: `zod`, used to declare each tool's input schema (also drives the argument descriptions shown
  to the calling assistant).
- **No test framework, no linter, no CI** configured in this repo as of writing.

---

## 4. What's needed from you

### 4.1 Credentials

- A Supabase project URL and a **service role key** (`SUPABASE_SERVICE_KEY`) — not the anon/public key, since
  the service key is what's referenced in `.env.example`. Service keys bypass Row Level Security, so treat this
  key as a secret with full data access; `.env` is already gitignored, and there's no git repo yet in this
  directory so nothing has been pushed anywhere.
- These go in `.env` at the project root (already present locally, not committed) as:
  ```
  SUPABASE_URL=https://<your-project>.supabase.co
  SUPABASE_SERVICE_KEY=<your-service-role-key>
  ```

### 4.2 The Supabase schema this server assumes exists

You (or whoever provisioned the Supabase project) need these tables present, since the server does no schema
migration or validation of its own:

- `bible` — columns `field1` (text, 8-digit packed verse code), `field2` (text, verse content), `field3` (text,
  row-type flag, `"V"` for verses).
- `daily_verses` — has a `date` column in `DD-MM-YYYY` string format.
- `mass_readings` — has a `date` column in `YYYY-MM-DD` string format.
- `daily_saints` — has a `date` column in `YYYY-MM-DD` string format.
- `bible_promise_box` — has a `category` column (text) among others.
- `daily_quiz` — has a `date` column in `YYYY-MM-DD` string format.

If you ever need to inspect or change this schema, it lives in Supabase itself (SQL editor / table editor in
the Supabase dashboard) — nothing in this repo defines or migrates it.

### 4.3 Build & run steps

```bash
npm install
npm run build     # tsc compiles src/ -> dist/, then copies books.json -> dist/books.json
npm start          # node dist/index.js — will exit(1) immediately if env vars are missing
```

During active development, `npm run dev` runs `tsc --watch` for incremental compiles; you still need to re-run
`node dist/index.js` (or let your MCP client relaunch it) to pick up changes, since there's no hot reload.

### 4.4 Registering it with an MCP client

`.mcp.json` already registers this server under the name `tamil-bible`, pointing at the absolute path to
`dist/index.js` on this machine. If you move the project directory, update that path. `.claude/settings.local.json`
enables/disables which `.mcp.json`-declared servers are active for Claude Code in this project — note it
currently lists `tamil-bible` (and `supabase`) in *both* `enabledMcpjsonServers` and `disabledMcpjsonServers`,
which is contradictory; worth cleaning up if you notice the server not being picked up as expected.

### 4.5 Known rough edges to be aware of

- **No test suite** — the only correctness signal is `tsc`'s type-check (`strict: true` is on, so type errors
  will be caught, but logic errors won't be).
- **Hardcoded date formats differ per tool** (see §2.4) — easy to pass the wrong format and get a silent "not
  found" instead of an error.
- **`.env` parsing is hand-rolled**, not using `dotenv` — if you ever add quoting, comments, or multi-line
  values to `.env`, the current parser (`src/index.ts:13-23`) won't handle them; it only does a naive
  `indexOf("=")` split per line.
- **No local fallback for verse data** — every verse/chapter/search request is a live Supabase call; if the
  service key is revoked or the project is paused, all content tools fail (metadata tools like `list_books` and
  `get_book_info` still work, since those only use the bundled `books.json`).
- **Not a git repository yet** — there's no version history to fall back on if something regresses; consider
  running `git init` and committing a baseline if you want that safety net.
