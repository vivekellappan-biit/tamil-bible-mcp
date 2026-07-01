# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP (Model Context Protocol) stdio server exposing the Tamil Roman Catholic Bible (and related daily-devotional content) as tools, backed by a Supabase Postgres database. Single file implementation: `src/index.ts`.

## Commands

```bash
npm run build   # tsc compile to dist/ + copy src/books.json -> dist/books.json
npm run dev      # tsc --watch
npm start        # node dist/index.js (runs the compiled server)
```

There is no test suite or linter configured. After editing `src/index.ts`, run `npm run build` to verify it type-checks (project uses `strict: true`) — this is the only available correctness check.

The server is invoked as an MCP stdio server, not run directly for manual testing; `.mcp.json` registers it as `tamil-bible` pointing at `dist/index.js`. To exercise a tool end-to-end, build first, then connect an MCP client (e.g. Claude Desktop/Code with `.mcp.json`) to the stdio process.

## Configuration

Requires `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` (see `.env.example`). `src/index.ts` hand-parses `../.env` relative to the built `dist/index.js` at startup (no dotenv dependency) and falls back to real environment variables if the file is missing. The server exits immediately if either var is unset.

## Architecture

- **Book metadata** (`src/books.json`, copied verbatim to `dist/` on build) is static, in-memory data for all 75 books: numbers `"01"`–`"75"` as zero-padded strings, English/Tamil names, chapter counts, and an HTML introduction blurb. It is loaded once at startup into a `BOOKS` map keyed by the zero-padded book number string. Book numbers 1–48 are Old Testament, 49+ are New Testament (see the `testament` field logic in `list_books`).
- **Verse data** lives only in Supabase, in a `bible` table with three flat columns: `field1` (an 8-digit verse code), `field2` (verse text), `field3` (row type, `"V"` for actual verses vs. other annotation rows). There is no `.env`-independent local copy of verse text — all verse/chapter/search tools require live Supabase access.
- **Verse code scheme**: `field1` is `BBCCCVVV` — 2-digit book number + 3-digit chapter + 3-digit verse, all zero-padded (see `bookIdToCode`/`parseVerseCode`/`bookChapterPrefix`/`bookPrefix`). Chapter/whole-book queries use `LIKE 'prefix%'` on this same string column rather than separate indexed columns, so any change to the code width/format must stay consistent across all four helper functions.
- **Other Supabase tables** used by individual tools, each with its own schema (not modeled as TS interfaces, just passed through as raw JSON): `daily_verses`, `mass_readings`, `daily_saints`, `bible_promise_box`, `daily_quiz`.
- **Tool response convention**: every tool returns `{ content: [{ type: "text", text: JSON.stringify(...) }] }`, with `isError: true` added for not-found/error cases instead of throwing. Follow this shape for any new tool.
- **`formatVerseRow`** is the shared shape for anything returning verse data (`get_verse`, `get_chapter`, `search_verses`): it decodes `field1` back into book/chapter/verse and enriches with both English and Tamil book names/references via the `BOOKS` map.
