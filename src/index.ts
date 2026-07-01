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
      .single();

    if (error || !data) {
      const key = String(book).padStart(2, "0");
      return {
        content: [{ type: "text", text: `Verse not found: ${BOOKS[key]?.bookNameEnglish ?? `Book ${book}`} ${chapter}:${verse}` }],
        isError: true,
      };
    }
    return { content: [{ type: "text", text: JSON.stringify(formatVerseRow(data), null, 2) }] };
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
  },
  async ({ query, limit, book }) => {
    let q = supabase
      .from("bible")
      .select("*")
      .ilike("field2", `%${query}%`)
      .eq("field3", "V")
      .order("field1", { ascending: true })
      .limit(limit);

    if (book) q = q.like("field1", `${bookPrefix(book)}%`);

    const { data, error } = await q;
    if (error) return { content: [{ type: "text", text: `Search error: ${error.message}` }], isError: true };
    if (!data?.length) return { content: [{ type: "text", text: `No verses found for "${query}"` }] };
    return { content: [{ type: "text", text: JSON.stringify(data.map(formatVerseRow), null, 2) }] };
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
      .single();

    if (error || !data) return { content: [{ type: "text", text: `No daily verse found for ${target}` }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
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
      .single();

    if (error || !data) return { content: [{ type: "text", text: `No saint found for ${target}` }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
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
    if (category) q = q.ilike("category", category);
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
      .single();

    if (error || !data) return { content: [{ type: "text", text: `No quiz found for ${target}` }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ── Start ─────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
