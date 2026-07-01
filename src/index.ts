#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env
try {
  const envContent = readFileSync(resolve(__dirname, "../.env"), "utf-8");
  for (const line of envContent.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) {
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
  }
} catch { /* rely on real env vars */ }

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
  process.exit(1);
}

const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Book data from books.json ─────────────────────────────────────────────────
interface BookEntry {
  count: number;
  bookNo: string;
  bookNameEnglish: string;
  bookFullnameTamil: string;
  bookNameTamil: string;
  bookshortName: string;
  bookOldName: string;
  introduction: string;
}

const rawBooks: BookEntry[] = JSON.parse(
  readFileSync(resolve(__dirname, "books.json"), "utf-8")
);

// Map bookNo (string "01"-"75") → book info
const BOOKS: Record<string, BookEntry> = {};
for (const b of rawBooks) {
  BOOKS[b.bookNo] = b;
}

const MAX_BOOK = Math.max(...rawBooks.map((b) => parseInt(b.bookNo)));

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// Escape Postgres LIKE/ILIKE wildcard metacharacters in user-supplied input
// so they're matched literally rather than acting as pattern wildcards.
function escapeLikePattern(str: string): string {
  return str.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function bookIdToCode(book: number, chapter: number, verse: number): string {
  return (
    String(book).padStart(2, "0") +
    String(chapter).padStart(3, "0") +
    String(verse).padStart(3, "0")
  );
}

function bookChapterPrefix(book: number, chapter: number): string {
  return String(book).padStart(2, "0") + String(chapter).padStart(3, "0");
}

function bookPrefix(book: number): string {
  return String(book).padStart(2, "0");
}

function parseVerseCode(code: string) {
  return {
    book: parseInt(code.slice(0, 2)),
    chapter: parseInt(code.slice(2, 5)),
    verse: parseInt(code.slice(5, 8)),
  };
}

function formatVerseRow(row: { field1: string; field2: string; field3: string }) {
  const { book, chapter, verse } = parseVerseCode(row.field1);
  const bookKey = String(book).padStart(2, "0");
  const info = BOOKS[bookKey];
  return {
    reference: `${info?.bookNameEnglish ?? `Book ${book}`} ${chapter}:${verse}`,
    tamil_reference: `${info?.bookNameTamil ?? `நூல் ${book}`} ${chapter}:${verse}`,
    book_number: book,
    chapter,
    verse,
    text: row.field2,
    type: row.field3,
  };
}

function todayDate(): string {
  return new Date().toISOString().split("T")[0]; // YYYY-MM-DD
}

function todayDateDDMMYYYY(): string {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

// ── MCP Server ────────────────────────────────────────────────────────────────
const server = new McpServer({
  name: "tamil-bible",
  version: "1.0.0",
});

// 1. list_books
server.tool(
  "list_books",
  "List all 75 books of the Tamil Roman Catholic Bible with book numbers, English names, Tamil names, short names and chapter counts",
  {},
  async () => {
    const books = rawBooks.map((b) => ({
      number: parseInt(b.bookNo),
      english: b.bookNameEnglish,
      tamil_full: b.bookFullnameTamil,
      tamil: b.bookNameTamil,
      short: b.bookshortName,
      old_name: b.bookOldName,
      chapters: b.count,
      testament: parseInt(b.bookNo) <= 48 ? "Old Testament" : "New Testament",
    }));
    return { content: [{ type: "text", text: JSON.stringify(books, null, 2) }] };
  }
);

// 2. get_book_info
server.tool(
  "get_book_info",
  "Get detailed information and introduction about a specific book of the Tamil Bible",
  {
    book: z.number().int().min(1).max(MAX_BOOK).describe(`Book number (1–${MAX_BOOK}). Use list_books to find the number.`),
  },
  async ({ book }) => {
    const key = String(book).padStart(2, "0");
    const info = BOOKS[key];
    if (!info) {
      return { content: [{ type: "text", text: `Book ${book} not found` }], isError: true };
    }
    const result = {
      number: book,
      english: info.bookNameEnglish,
      tamil_full: info.bookFullnameTamil,
      tamil: info.bookNameTamil,
      short: info.bookshortName,
      old_name: info.bookOldName,
      chapters: info.count,
      introduction: stripHtml(info.introduction),
    };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// 3. get_verse
server.tool(
  "get_verse",
  "Get a specific verse from the Tamil Bible by book number, chapter, and verse number",
  {
    book: z.number().int().min(1).max(MAX_BOOK).describe(`Book number (1–${MAX_BOOK}). Use list_books to look up the number.`),
    chapter: z.number().int().min(1).max(999).describe("Chapter number"),
    verse: z.number().int().min(1).max(999).describe("Verse number"),
  },
  async ({ book, chapter, verse }) => {
    const code = bookIdToCode(book, chapter, verse);
    const { data, error } = await supabase
      .from("bible")
      .select("*")
      .eq("field1", code)
      .eq("field3", "V")
      .limit(1);

    if (error || !data?.length) {
      const key = String(book).padStart(2, "0");
      return {
        content: [{ type: "text", text: `Verse not found: ${BOOKS[key]?.bookNameEnglish ?? `Book ${book}`} ${chapter}:${verse}` }],
        isError: true,
      };
    }
    return { content: [{ type: "text", text: JSON.stringify(formatVerseRow(data[0]), null, 2) }] };
  }
);

// 4. get_chapter
server.tool(
  "get_chapter",
  "Get all verses of a chapter from the Tamil Bible",
  {
    book: z.number().int().min(1).max(MAX_BOOK).describe(`Book number (1–${MAX_BOOK})`),
    chapter: z.number().int().min(1).max(999).describe("Chapter number"),
  },
  async ({ book, chapter }) => {
    const prefix = bookChapterPrefix(book, chapter);
    const { data, error } = await supabase
      .from("bible")
      .select("*")
      .like("field1", `${prefix}%`)
      .eq("field3", "V")
      .order("field1", { ascending: true });

    const key = String(book).padStart(2, "0");
    if (error || !data?.length) {
      return {
        content: [{ type: "text", text: `Chapter not found: ${BOOKS[key]?.bookNameEnglish ?? `Book ${book}`} ${chapter}` }],
        isError: true,
      };
    }
    return { content: [{ type: "text", text: JSON.stringify(data.map(formatVerseRow), null, 2) }] };
  }
);

// 5. search_verses
server.tool(
  "search_verses",
  "Search the Tamil Bible for verses containing a keyword in Tamil script",
  {
    query: z.string().min(1).describe("Search term in Tamil script"),
    limit: z.number().int().min(1).max(50).default(10).describe("Max results (default 10, max 50)"),
    book: z.number().int().min(1).max(MAX_BOOK).optional().describe("Restrict search to a specific book number"),
    testament: z.enum(["OT", "NT"]).optional().describe("Restrict search to Old Testament (books 1-48) or New Testament (books 49+)"),
  },
  async ({ query, limit, book, testament }) => {
    let q = supabase
      .from("bible")
      .select("*")
      .ilike("field2", `%${escapeLikePattern(query)}%`)
      .eq("field3", "V")
      .order("field1", { ascending: true })
      .limit(limit);

    if (book) {
      q = q.like("field1", `${bookPrefix(book)}%`);
    } else if (testament === "OT") {
      q = q.gte("field1", bookPrefix(1)).lte("field1", `${bookPrefix(48)}999999`);
    } else if (testament === "NT") {
      q = q.gte("field1", bookPrefix(49)).lte("field1", `${bookPrefix(MAX_BOOK)}999999`);
    }

    const { data, error } = await q;
    if (error) return { content: [{ type: "text", text: "Search failed" }], isError: true };
    if (!data?.length) return { content: [{ type: "text", text: `No verses found for "${query}"` }] };
    return { content: [{ type: "text", text: JSON.stringify(data.map(formatVerseRow), null, 2) }] };
  }
);

// 5b. get_verse_range
server.tool(
  "get_verse_range",
  "Get a range of verses within a single chapter of the Tamil Bible",
  {
    book: z.number().int().min(1).max(MAX_BOOK).describe(`Book number (1–${MAX_BOOK})`),
    chapter: z.number().int().min(1).max(999).describe("Chapter number"),
    start_verse: z.number().int().min(1).max(999).describe("Start verse number (inclusive)"),
    end_verse: z.number().int().min(1).max(999).describe("End verse number (inclusive)"),
  },
  async ({ book, chapter, start_verse, end_verse }) => {
    if (end_verse < start_verse) {
      return { content: [{ type: "text", text: "end_verse must be >= start_verse" }], isError: true };
    }
    const { data, error } = await supabase
      .from("bible")
      .select("*")
      .gte("field1", bookIdToCode(book, chapter, start_verse))
      .lte("field1", bookIdToCode(book, chapter, end_verse))
      .eq("field3", "V")
      .order("field1", { ascending: true });

    const key = String(book).padStart(2, "0");
    if (error || !data?.length) {
      return {
        content: [{ type: "text", text: `Verses not found: ${BOOKS[key]?.bookNameEnglish ?? `Book ${book}`} ${chapter}:${start_verse}-${end_verse}` }],
        isError: true,
      };
    }
    return { content: [{ type: "text", text: JSON.stringify(data.map(formatVerseRow), null, 2) }] };
  }
);

// 5c. get_random_verse
server.tool(
  "get_random_verse",
  "Get a random verse from the Tamil Bible, optionally restricted to a specific book",
  {
    book: z.number().int().min(1).max(MAX_BOOK).optional().describe("Restrict to a specific book number"),
  },
  async ({ book }) => {
    let countQ = supabase.from("bible").select("*", { count: "exact", head: true }).eq("field3", "V");
    if (book) countQ = countQ.like("field1", `${bookPrefix(book)}%`);
    const { count, error: countError } = await countQ;

    if (countError || !count) {
      return { content: [{ type: "text", text: "Could not fetch a random verse" }], isError: true };
    }

    const offset = Math.floor(Math.random() * count);
    let q = supabase
      .from("bible")
      .select("*")
      .eq("field3", "V")
      .order("field1", { ascending: true })
      .range(offset, offset);
    if (book) q = q.like("field1", `${bookPrefix(book)}%`);

    const { data, error } = await q;
    if (error || !data?.length) {
      return { content: [{ type: "text", text: "Could not fetch a random verse" }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(formatVerseRow(data[0]), null, 2) }] };
  }
);

// 5d. find_book
server.tool(
  "find_book",
  "Find a book of the Tamil Bible by (partial) English name, Tamil name, short name, or old name, returning its book number",
  {
    name: z.string().min(1).describe("Full or partial book name in English or Tamil"),
  },
  async ({ name }) => {
    const needle = name.trim().toLowerCase();
    const matches = rawBooks
      .filter(
        (b) =>
          b.bookNameEnglish.toLowerCase().includes(needle) ||
          b.bookNameTamil.toLowerCase().includes(needle) ||
          b.bookFullnameTamil.toLowerCase().includes(needle) ||
          b.bookshortName.toLowerCase().includes(needle) ||
          b.bookOldName?.toLowerCase().includes(needle)
      )
      .map((b) => ({
        number: parseInt(b.bookNo),
        english: b.bookNameEnglish,
        tamil: b.bookNameTamil,
        short: b.bookshortName,
        chapters: b.count,
      }));

    if (!matches.length) {
      return { content: [{ type: "text", text: `No book found matching "${name}"` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(matches, null, 2) }] };
  }
);

// 6. get_daily_verse
server.tool(
  "get_daily_verse",
  "Get the daily Tamil Bible verse for a given date",
  {
    date: z.string().optional().describe("Date in DD-MM-YYYY format (defaults to today)"),
  },
  async ({ date }) => {
    const target = date ?? todayDateDDMMYYYY();
    const { data, error } = await supabase
      .from("daily_verses")
      .select("*")
      .eq("date", target)
      .limit(1);

    if (error || !data?.length) return { content: [{ type: "text", text: `No daily verse found for ${target}` }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(data[0], null, 2) }] };
  }
);

// 7. get_mass_readings
server.tool(
  "get_mass_readings",
  "Get the Catholic daily Mass readings for a given date (readings, psalm, gospel in Tamil)",
  {
    date: z.string().optional().describe("Date in YYYY-MM-DD format (defaults to today)"),
  },
  async ({ date }) => {
    const target = date ?? todayDate();
    const { data, error } = await supabase
      .from("mass_readings")
      .select("*")
      .eq("date", target)
      .single();

    if (error || !data) return { content: [{ type: "text", text: `No mass readings found for ${target}` }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// 8. get_daily_saint
server.tool(
  "get_daily_saint",
  "Get the Catholic saint of the day with Tamil description",
  {
    date: z.string().optional().describe("Date in YYYY-MM-DD format (defaults to today)"),
  },
  async ({ date }) => {
    const target = date ?? todayDate();
    const { data, error } = await supabase
      .from("daily_saints")
      .select("*")
      .eq("date", target)
      .limit(1);

    if (error || !data?.length) return { content: [{ type: "text", text: `No saint found for ${target}` }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(data[0], null, 2) }] };
  }
);

// 9. get_promise_box
server.tool(
  "get_promise_box",
  "Get a Tamil Bible promise box verse — random or filtered by category",
  {
    category: z.string().optional().describe("Filter by category e.g. Hope, Faith, Love, Peace, Strength"),
    random: z.boolean().default(true).describe("Return a random verse (default true)"),
  },
  async ({ category, random }) => {
    let q = supabase.from("bible_promise_box").select("*");
    if (category) q = q.ilike("category", escapeLikePattern(category));
    const { data, error } = await q;

    if (error || !data?.length) {
      return { content: [{ type: "text", text: `No promise verses found${category ? ` for category: ${category}` : ""}` }], isError: true };
    }
    const result = random ? data[Math.floor(Math.random() * data.length)] : data[0];
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// 10. list_promise_categories
server.tool(
  "list_promise_categories",
  "List all available promise box categories in the Tamil Bible database",
  {},
  async () => {
    const { data, error } = await supabase.from("bible_promise_box").select("category");
    if (error || !data) return { content: [{ type: "text", text: "Could not fetch categories" }], isError: true };
    const unique = [...new Set(data.map((r) => r.category).filter(Boolean))].sort();
    return { content: [{ type: "text", text: JSON.stringify(unique, null, 2) }] };
  }
);

// 11. get_daily_quiz
server.tool(
  "get_daily_quiz",
  "Get the Tamil Catholic Bible daily quiz question with options and explanation",
  {
    date: z.string().optional().describe("Date in YYYY-MM-DD format (defaults to today)"),
  },
  async ({ date }) => {
    const target = date ?? todayDate();
    const { data, error } = await supabase
      .from("daily_quiz")
      .select("*")
      .eq("date", target)
      .limit(1);

    if (error || !data?.length) return { content: [{ type: "text", text: `No quiz found for ${target}` }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(data[0], null, 2) }] };
  }
);

// ── Start ─────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
