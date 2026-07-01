# Architecture — Tamil Bible MCP Server (plain-English guide)

This document explains, in simple terms, what this project is, how the pieces fit together, and how it
got to its current state (based on the real git history). It's meant to be readable by someone who is
new to the codebase.

---

## 1. What this project actually is

It's a small background program (a "server") that lets an AI assistant like Claude read the Tamil Roman
Catholic Bible and some daily devotional content — verses, chapters, keyword search, Mass readings, saint
of the day, promise-box verses, a daily quiz.

It speaks a standard called **MCP (Model Context Protocol)**. Think of MCP as a plug: any AI assistant
that supports MCP (Claude Desktop, Claude Code, Cursor, etc.) can "plug into" this server and call its
tools, the same way a phone app calls an API.

The whole server is **one file**: `src/index.ts`. There's no framework, no folders of controllers/models —
just a single script that starts up, registers 11 tools, and waits for requests.

---

## 2. The two places data lives

There are two very different data sources, and the project intentionally keeps them separate:

1. **`src/books.json`** — a static list of all 75 Bible books (numbers, English/Tamil names, chapter
   counts, an HTML intro blurb). This file is bundled with the code, loaded into memory once when the
   server starts, and never touched again. It never needs the internet.

2. **Supabase (a hosted Postgres database)** — this is where the actual verse text and all the daily
   devotional content live. Every time a tool needs verse text, a Mass reading, a saint bio, etc., the
   server makes a live network call to Supabase. There is no offline copy of this data inside the server
   itself — if Supabase is down or unreachable, those tools simply fail.

Why split it this way? Book metadata (names, chapter counts) rarely changes and is small, so it's cheap to
keep in memory. Verse text and daily content is large and needs to be queried/searched, so it lives in a
real database instead.

---

## 3. How a request flows through the system

1. An MCP client (say, Claude Desktop) starts the server by running `node dist/index.js` as a subprocess.
   It knows to do this because of `.mcp.json`, a small config file that says "here's how to launch the
   tamil-bible server."
2. On startup, the server:
   - Manually reads a `.env` file line by line to pull out `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`
     (there's no `dotenv` library — just a ~10-line hand-written parser). If `.env` isn't found, it falls
     back to whatever real environment variables are already set.
   - If either credential is missing, it prints an error and shuts down immediately — it refuses to run
     in a half-working state.
   - Connects to Supabase using those credentials.
   - Loads `books.json` into memory.
   - Registers its 11 tools (see below) and starts listening on **stdio** (standard input/output — not a
     network port). This means the server only talks to whatever process launched it; it's not reachable
     over the network at all.
3. When the AI assistant wants to look something up, it sends a tool call (e.g. "get_verse, book 43,
   chapter 3, verse 16"). The server validates the input, does the lookup (in memory or via Supabase),
   and sends back a JSON text response.

---

## 3.1 Worked example — what happens when a user types a question

This is the actual path data takes, end to end, when a person asks Claude something in plain English.
Nothing here is hidden magic — it's five concrete hand-offs.

**User types:** *"What does John 3:16 say in Tamil?"*

```
┌──────────┐   1. plain English question    ┌───────────────┐
│  User    │ ──────────────────────────────▶│ Claude (the AI)│
└──────────┘                                 └───────┬────────┘
                                                      │ 2. Claude decides which MCP
                                                      │    tool fits, and turns the
                                                      │    question into structured
                                                      │    arguments
                                                      ▼
                                          get_verse({ book: 43, chapter: 3, verse: 16 })
                                                      │
                                                      │ 3. sent over stdio (stdin) as
                                                      │    a JSON-RPC tool call
                                                      ▼
                                         ┌─────────────────────────┐
                                         │ tamil-bible-mcp server   │
                                         │ (src/index.ts, running   │
                                         │ as a subprocess)         │
                                         └────────────┬─────────────┘
                                                      │ 4. Zod validates the args
                                                      │    (book/chapter/verse must
                                                      │    be integers in range)
                                                      ▼
                                       bookIdToCode(43, 3, 16) → "43003016"
                                                      │
                                                      │ 5. live network query to
                                                      │    Supabase Postgres
                                                      ▼
                       select * from bible where field1 = '43003016' and field3 = 'V' limit 1
                                                      │
                                                      ▼
                                        row back: { field1, field2 (Tamil text), field3 }
                                                      │
                                                      │ 6. formatVerseRow() looks up
                                                      │    book 43 in the in-memory
                                                      │    BOOKS map (from books.json)
                                                      │    to attach English + Tamil
                                                      │    book names
                                                      ▼
                       { reference: "John 3:16", tamil_reference: "...", text: "..." }
                                                      │
                                                      │ 7. wrapped as
                                                      │    { content: [{ type: "text",
                                                      │      text: "<JSON above>" }] }
                                                      │    and written to stdout
                                                      ▼
                                         ┌───────────────┐
                                         │ Claude (the AI)│ ── 8. reads the JSON, turns
                                         └───────┬────────┘     it into a natural-language
                                                 │              answer
                                                 ▼
                                         ┌──────────┐
                                         │  User    │  ◀── "In Tamil, John 3:16 says: ..."
                                         └──────────┘
```

Key point: **the server never talks to the user directly, and it never generates language.** It only ever
does one job — take structured arguments in, run a lookup, hand structured JSON back out. All of the
"understanding what the user meant" and "phrasing the answer nicely" happens on Claude's side, not inside
`src/index.ts`.

### Step-by-step: which side does which step

It's worth being precise about this, because it's the single most common confusion about MCP servers in
general: **this codebase is not an AI.** It contains zero language understanding, zero prompting, zero
model calls. Every step above belongs to exactly one of two sides:

| # | Step | Who does it | Where |
|---|---|---|---|
| 1 | Understand the English question | **Claude** | Anthropic's model, outside this repo entirely |
| 2 | Decide *which* tool fits, and turn the sentence into `{ book: 43, chapter: 3, verse: 16 }` | **Claude** | Claude's own reasoning — this repo has no say in it |
| 3 | Ship that JSON over stdio to the subprocess | MCP SDK (plumbing, not "our" logic) | `@modelcontextprotocol/sdk` |
| 4 | Check the JSON matches the declared shape (right types, in-range numbers) | **Our code** | Zod schema passed to `server.tool(...)` in `src/index.ts` |
| 5 | Turn `(43, 3, 16)` into the string `"43003016"` | **Our code** | `bookIdToCode()` in `src/index.ts` |
| 6 | Run the actual database query | **Our code** (calling out to Supabase, which just executes SQL — no logic of its own here) | the `supabase.from("bible")...` call |
| 7 | Attach English/Tamil book names to the raw row | **Our code** | `formatVerseRow()`, using the in-memory `BOOKS` map from `books.json` |
| 8 | Package the result as `{ content: [...] }` and write it to stdout | **Our code** | the `return { content: [...] }` at the end of each tool handler |
| 9 | Read that JSON and turn it into a friendly English sentence | **Claude** | back outside this repo |
| 10 | Show the answer to the user | **Claude** (via whatever client app — Claude Desktop/Code) | outside this repo |

So in short: **our code is steps 4–8 only** — validate, look up, format, respond. Everything about
understanding the question and phrasing the answer (steps 1, 2, 9, 10) is Claude's job, running entirely
outside `src/index.ts`. This project doesn't call any AI model, doesn't hold an API key for Claude, and
doesn't do any natural-language processing — it's a plain data-lookup layer that Claude happens to be the
one calling.

A good sanity check: if you deleted this server entirely, Claude could still chat about the Bible from its
own training knowledge — it just wouldn't be able to fetch this exact Tamil translation's verse text,
today's specific Mass reading, or the promise-box category list, because those live only in this project's
Supabase database.

### Where user input actually gets validated

Every tool declares its expected arguments as a [Zod](https://zod.dev) schema right where it's registered,
e.g. for `get_verse`:

```ts
{
  book: z.number().int().min(1).max(MAX_BOOK),
  chapter: z.number().int().min(1).max(999),
  verse: z.number().int().min(1).max(999),
}
```

If Claude (or any other MCP client) sends something that doesn't match — a string instead of a number, a
book number out of range — the MCP SDK rejects the call *before* the handler function even runs. So by the
time your code inside the `async (...) => { ... }` handler executes, the arguments are already
guaranteed to be well-formed. This is the main "input validation" layer in the whole project — there's no
separate validation step written by hand.

For free-text input specifically — `search_verses`' `query` param and `get_promise_box`'s `category`
param — Zod only guarantees "it's a non-empty string," not that it's *safe* to drop into a SQL `LIKE`
pattern. That's why `escapeLikePattern()` exists: it escapes `%`, `_`, and `\` so a search for `100%` or
`a_b` matches those literal characters instead of being interpreted as SQL wildcards.

### Two different data-flow shapes, depending on the tool

- **Lookup tools** (`get_verse`, `get_book_info`, `get_daily_verse`, `get_mass_readings`,
  `get_daily_saint`, `get_daily_quiz`): user input → build an exact key (verse code or date string) →
  fetch at most one row → format → return. Simple in, simple out.
- **Range/search tools** (`get_chapter`, `search_verses`, `list_books`, `list_promise_categories`,
  `get_promise_box`): user input → build a *prefix* or *pattern* → fetch many rows → map each one through
  `formatVerseRow` (or similar) → return an array. The shape of the response depends on how many rows
  come back, not a fixed one-record shape.

In both cases, the flow is one-way and stateless: the server keeps no memory of previous questions. Every
tool call is independent — if a user asks a follow-up question, Claude re-sends fresh arguments; the
server doesn't remember "the last verse someone looked up."

---

## 3.2 Second worked example — a search, not a single lookup

The `get_verse` example above is the simplest shape: one input → one row out. But several tools
(`search_verses`, `get_chapter`, `get_promise_box`) return a *variable number* of rows, and one of them
(`search_verses`) also has to defend against special characters in free-text input. Here's that path.

**User types:** *"Find Tamil Bible verses about 'அன்பு' (love)"*

```
┌──────────┐  1. plain English request       ┌───────────────┐
│  User    │ ────────────────────────────────▶│ Claude (the AI)│
└──────────┘                                  └───────┬────────┘
                                                       │ 2. Claude picks search_verses
                                                       │    and extracts the keyword
                                                       ▼
                                    search_verses({ query: "அன்பு", limit: 10 })
                                                       │
                                                       │ 3. sent over stdio
                                                       ▼
                                          ┌─────────────────────────┐
                                          │ tamil-bible-mcp server   │
                                          └────────────┬─────────────┘
                                                       │ 4. Zod checks query is a
                                                       │    non-empty string, limit
                                                       │    is 1-50 (defaults to 10)
                                                       ▼
                               escapeLikePattern("அன்பு") → "அன்பு"  (unchanged here —
                                                       │               only %, _, \ get escaped)
                                                       │ 5. live query to Supabase
                                                       ▼
              select * from bible where field2 ilike '%அன்பு%' and field3 = 'V'
              order by field1 limit 10
                                                       │
                                                       ▼
                                many rows back (0 to 10 of them)
                                                       │
                                                       │ 6. .map(formatVerseRow) runs
                                                       │    once PER ROW, attaching
                                                       │    book names to each
                                                       ▼
                       [ { reference: "1 John 4:8", text: "..." }, { reference: "...", ... }, ... ]
                                                       │
                                                       │ 7. wrapped as one JSON array,
                                                       │    same { content: [...] } shape
                                                       │    as every other tool
                                                       ▼
                                          ┌───────────────┐
                                          │ Claude (the AI)│ ── 8. summarizes / lists the
                                          └───────┬────────┘     matches for the user
                                                  ▼
                                          ┌──────────┐
                                          │  User    │ ◀── "Here are a few verses about love: ..."
                                          └──────────┘
```

**Who does what, same breakdown as before:**

| Step | Who | Notes |
|---|---|---|
| Understand "find verses about love" and pick a Tamil keyword | **Claude** | Claude translates the *intent* into a search term; our code never sees English |
| Choose `search_verses` tool + build `{ query, limit }` | **Claude** | |
| Validate `query`/`limit`/optional `book` | **Our code** | Zod schema on the tool definition |
| Escape `%`, `_`, `\` in the query | **Our code** | `escapeLikePattern()` — this is the one place the server actively defends itself against user input, since raw text goes straight into a SQL pattern |
| Run the `ilike` search, capped at `limit` rows | **Our code** | the `supabase.from("bible").ilike(...)` call |
| Turn each raw row into a friendly object | **Our code** | `formatVerseRow`, run once per result |
| Turn the array of matches into readable prose | **Claude** | |

The important difference from the `get_verse` example: this time **our code doesn't know in advance how
many results it'll get.** Zero rows returns a plain "no verses found" message (not an error — an empty
search result is a normal outcome, not a failure); one or more rows returns an array. Claude is the one
that decides how to present "3 matches" vs. "47 matches" to the user — the server just hands back
whatever it found, unopinionated about presentation.

---

## 4. The trickiest part: how a verse's "address" is encoded

Instead of separate `book`, `chapter`, `verse` columns, the database packs all three into a single text
column called `field1`, as an 8-character code:

```
field1 = BB CCC VVV
         │  │    └── verse number, zero-padded to 3 digits
         │  └─────── chapter number, zero-padded to 3 digits
         └────────── book number, zero-padded to 2 digits
```

So John 3:16 (book 43, chapter 3, verse 16) becomes `"43003016"`.

- `field2` holds the actual verse text (in Tamil).
- `field3` marks what kind of row it is — `"V"` means "this is a real verse." (Some rows are headings or
  annotations, not verses, and get filtered out.)

Four small helper functions build/read this code (`bookIdToCode`, `bookChapterPrefix`, `bookPrefix`,
`parseVerseCode`). Whole-chapter or whole-book lookups just do a `LIKE 'prefix%'` match on this same text
column rather than using indexed numeric columns — simple, but it means all four helpers must always
agree on the exact format.

---

## 5. The 11 tools, grouped by purpose

**Bible metadata & text**
- `list_books` — list all 75 books
- `get_book_info` — details/intro for one book
- `get_verse` — one specific verse
- `get_chapter` — every verse in a chapter
- `search_verses` — keyword search (Tamil script), optionally scoped to one book

**Daily devotional content** (each defaults to "today" if no date is given)
- `get_daily_verse`
- `get_mass_readings`
- `get_daily_saint`
- `get_daily_quiz`

**Promise box**
- `get_promise_box` — a verse, random or by category
- `list_promise_categories`

Every tool follows the same reply shape: `{ content: [{ type: "text", text: "<JSON>" }] }`, with an
`isError: true` flag added for "not found" or failure cases — the server never throws an unhandled
exception back at the client.

---

## 6. Two date formats, on purpose

`get_daily_verse` uses dates like `DD-MM-YYYY` (matching how the `daily_verses` table stores dates), while
`get_mass_readings`, `get_daily_saint`, and `get_daily_quiz` all use `YYYY-MM-DD` (matching their tables).
This looks like an inconsistency, but it's intentional — each tool matches whatever format its underlying
table already uses. Unifying it would require a data migration, which hasn't been done.

---

## 7. How the project actually developed (from git history)

Unlike a project that grew commit-by-commit from a blank slate, this repository's history shows the
codebase was already working privately, and git tracking began right when the author decided to open-source
it. The commits since then read like this:

1. **"Prepare tamil-bible-mcp for public open-source release"** (first commit) — this single commit added
   almost everything at once: the working `src/index.ts`, `books.json`, the Supabase schema
   (`supabase/schema.sql`), a data export/seed pipeline (`scripts/seed.mjs`), npm publishing metadata, an
   MIT license, a public README, and a CI build check (`.github/workflows/build.yml`). This tells us the
   core design (stdio + Supabase + single-file server) was already settled before the project went public.

2. **"Fill in GitHub repository URL placeholders"** — small cleanup, replacing placeholder URLs in
   `README.md`/`package.json` with the real repo link.

3. **"Document claude mcp add one-liner for easy Claude Code setup"** — after publishing the package to
   npm, the author verified that `claude mcp add ... -- npx -y tamil-bible-mcp` actually works end-to-end,
   and updated the README to recommend that as the easiest setup path (no cloning needed).

4. **"Bump version to 1.0.1"** and **"Sync package-lock.json version to 1.0.1"** — routine version bump
   because the README ships inside the published npm package, so a docs-only change still needed a new
   release. The lockfile had to be fixed up separately since the version bump was done by hand rather than
   via `npm version`.

5. **"Stop tracking data/ folder and add to .gitignore"** — the large data dumps (`data/*.json`, tens of
   MB) were removed from git tracking so they don't bloat the public repo history; they're still used
   locally to seed Supabase, just no longer committed.

6. **"Fix get_verse/get_chapter false negatives on rows sharing a verse code"** (most recent) — a real bug
   fix. Because `field1` verse codes aren't unique (a chapter/verse position can have both a `"V"` verse
   row and a `"T"` heading row with the same code), `get_verse` was using Supabase's `.single()`, which
   throws an error whenever more than one row matches. That meant roughly 1,800 real verses were being
   reported as "not found" even though they existed. The fix: filter explicitly on `field3 = "V"` and
   fetch with `.limit(1)` instead of `.single()`, applied consistently to `get_verse`, `get_chapter`, and
   the daily-content lookups. The same commit also escaped SQL `LIKE`/`ILIKE` wildcard characters in
   user-supplied search/category text (so a search containing `%` or `_` behaves as a literal search
   rather than an accidental wildcard), and stopped echoing raw Supabase error messages back to callers.

**Takeaway:** the project's evolution after going public has mostly been about (a) polishing the
open-source onboarding experience (README instructions, npm packaging, repo hygiene) and (b) hardening
correctness around the one genuinely tricky piece of the design — the shared, non-unique verse code
scheme — which caused a real, measurable class of bugs (false "not found" results) that got fixed once
someone (with Claude's help) traced it back to `.single()` failing on duplicate rows.

---

## 8. Where to look next

- `CLAUDE.md` — terse, AI-agent-facing reference for the same architecture (verse code scheme, response
  shape conventions, date-format quirks).
- `REPORT.md` — an earlier, more detailed human-readable walkthrough written before git tracking began
  (so it describes design decisions visible in the code, not commit history).
- `supabase/schema.sql` — the actual table definitions, if you want to see the database side directly.
- `scripts/seed.mjs` / `scripts/export-data.mjs` — how the bundled data gets loaded into / exported from
  Supabase.
