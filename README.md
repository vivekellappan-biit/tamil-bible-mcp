# Tamil Bible MCP Server

An [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server that exposes the Tamil Roman
Catholic Bible — plus daily-devotional content (daily verse, Mass readings, saint of the day, promise-box
verses, a daily quiz) — as tools for AI assistants like Claude.

It talks to its client over **stdio** and to its data store over the network via **Supabase** (hosted
Postgres + REST API). Each user runs their own instance against their own Supabase project — there is no
shared public server and no bundled credentials.

## Platform support

This server uses the MCP **stdio** transport, which works with local MCP clients: **Claude Desktop**,
**Claude Code**, **Cursor**, **Windsurf**, and similar tools that spawn a local subprocess. It does **not**
currently support ChatGPT connectors or other platforms that require a remote HTTP/SSE MCP endpoint — that
would need a separate hosted deployment and is not implemented here.

## Tools

| Tool | Description |
|---|---|
| `list_books` | List all 75 books with numbers, English/Tamil names, and chapter counts |
| `get_book_info` | Detailed info and introduction for one book |
| `get_verse` | Fetch one verse by book/chapter/verse number |
| `get_chapter` | Fetch every verse in a chapter |
| `search_verses` | Keyword search over verse text (Tamil script), optionally scoped to one book |
| `get_daily_verse` | The daily verse for a given date (defaults to today) |
| `get_mass_readings` | Catholic daily Mass readings — first/second reading, psalm, gospel |
| `get_daily_saint` | Saint of the day with a Tamil biography |
| `get_promise_box` | A promise-box verse, random or filtered by category |
| `list_promise_categories` | List all promise-box categories |
| `get_daily_quiz` | The daily quiz question, options, and explanation |

## Quick start

### 1. Set up your own Supabase project

You need a [Supabase](https://supabase.com) project (the free tier is enough) with the schema this server
expects. This repo includes everything needed to stand one up from scratch:

```bash
git clone https://github.com/YOUR_GITHUB_USERNAME/tamil-bible-mcp.git
cd tamil-bible-mcp
npm install
cp .env.example .env   # then fill in your Supabase project URL + service role key
```

1. Create a project at [supabase.com](https://supabase.com).
2. In the Supabase SQL editor, run [`supabase/schema.sql`](supabase/schema.sql) to create the tables.
3. Get the project's **Service Role key** (Project Settings → API) — not the anon/public key — and put it
   in `.env` along with the project URL.
4. Seed the tables with the bundled Tamil Bible + devotional data:
   ```bash
   node scripts/seed.mjs
   ```
   This loads `data/*.json` (≈39k rows: the full Bible text plus daily verses, Mass readings, saints,
   promise-box entries, and quiz questions) into your project.

The service role key bypasses Row Level Security and has full read/write access to your project — treat it
as a secret. Since this server only runs locally over stdio (never over the network), that's a reasonable
trust boundary for a personal instance, but don't reuse this key anywhere network-facing.

### 2. Build

```bash
npm run build
```

### 3. Register with your MCP client

**Claude Code** — add to `.mcp.json` in your project (already present in this repo, pointing at the local
build):

```json
{
  "mcpServers": {
    "tamil-bible": {
      "type": "stdio",
      "command": "node",
      "args": ["dist/index.js"],
      "env": {}
    }
  }
}
```

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tamil-bible": {
      "command": "node",
      "args": ["/absolute/path/to/tamil-bible-mcp/dist/index.js"]
    }
  }
}
```

Or, once published, run it via `npx` without cloning:

```json
{
  "mcpServers": {
    "tamil-bible": {
      "command": "npx",
      "args": ["-y", "tamil-bible-mcp"],
      "env": {
        "SUPABASE_URL": "https://your-project.supabase.co",
        "SUPABASE_SERVICE_KEY": "your-service-role-key"
      }
    }
  }
}
```

## Configuration

| Variable | Required | Description |
|---|---|---|
| `SUPABASE_URL` | Yes | Your Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Yes | Your Supabase **service role** key (bypasses RLS) |

Read from `.env` at the project root, falling back to real environment variables if `.env` is absent.
Environment variables you set explicitly always take precedence over `.env`. The server exits immediately
if either variable is missing.

## Development

```bash
npm run dev      # tsc --watch
npm run build    # compile + copy books.json + chmod +x
npm start        # node dist/index.js
```

There's no test suite or linter configured; `tsc --strict` is the only automated correctness check. See
[CLAUDE.md](CLAUDE.md) for a deeper architecture walkthrough (verse addressing scheme, response
conventions, etc.) if you're extending this.

## Data & content

The bundled `data/*.json` files are a full export of the Tamil Roman Catholic Bible translation and
associated devotional content (Mass readings, saint biographies, quiz questions) used by this project.
Redistribution rights for this specific translation and content have been confirmed by the maintainer.
If you plan to redistribute this data further, verify your own rights to do so first.

## Contributing

Issues and PRs welcome. Since there's no CI test suite, please make sure `npm run build` passes cleanly
before submitting, and describe how you tested any behavioral change (this is a stdio MCP server, so
manual testing means driving it through an MCP client or raw JSON-RPC over stdio).

## License

MIT — see [LICENSE](LICENSE).
