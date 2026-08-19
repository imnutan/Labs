#!/usr/bin/env node
// clean-products.js — reads products.csv, normalizes it, and asks Claude to
// write a description for any row that is missing one.
//
//   npm install && node clean-products.js
//
// Requires ANTHROPIC_API_KEY in .env (only when a row actually needs a description).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Load .env from next to this script, so the script works from any cwd.
dotenv.config({ path: path.join(HERE, ".env"), quiet: true });

const CSV_PATH = process.argv[2] ?? path.join(HERE, "products.csv");
const MODEL = "claude-opus-5";

// Exact system prompt for the description-generation call — do not reword.
const SYSTEM_PROMPT = `You are a product copywriter for an outdoor gear store.
Always respond with only a single valid JSON object, no markdown fences,
no text outside the object, matching exactly:
{ title: string, description: string, seo_keywords: string[] }
If no product information is given, respond with
{ "title": "", "description": "", "seo_keywords": [] } — do not invent a product.
Strip any HTML tags from the input before use.
Escape any double quotes inside string values so the JSON stays valid.
Always respond in English regardless of the input product name's language.
Example:
Input: "Insulated Water Bottle 1L, keeps drinks cold 24h"
Output: {"title":"Insulated Water Bottle 1L","description":"Stay refreshed all day — this insulated bottle keeps drinks cold for a full 24 hours.","seo_keywords":["insulated water bottle","cold drinks","1L bottle","hydration"]}`;

// --- CSV parsing -----------------------------------------------------------

/** Minimal RFC 4180 parser: handles quoted fields, "" escapes, CRLF and LF. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let sawField = false;

  const endField = () => {
    row.push(field);
    field = "";
    sawField = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch !== '"') {
        field += ch;
      } else if (text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = false;
      }
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      sawField = true;
    } else if (ch === ",") {
      endField();
    } else if (ch === "\n") {
      endRow();
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field !== "" || sawField || row.length > 0) endRow();

  // Drop trailing/blank lines so a stray newline is not a "malformed row".
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

/** Map the header row to column indexes, falling back to name,description,price order. */
function resolveColumns(header) {
  const normalized = header.map((h) => h.trim().toLowerCase());
  const columns = {
    name: normalized.indexOf("name"),
    description: normalized.indexOf("description"),
    price: normalized.indexOf("price"),
  };
  const missing = Object.entries(columns)
    .filter(([, index]) => index === -1)
    .map(([key]) => key);

  if (missing.length === 0) return { columns, warning: null };

  return {
    columns: { name: 0, description: 1, price: 2 },
    warning: `Header is missing column(s): ${missing.join(", ")} — falling back to positional order (name, description, price).`,
  };
}

// --- Normalization ---------------------------------------------------------

const SMALL_WORDS = new Set([
  "a", "an", "and", "as", "at", "but", "by", "for", "in", "nor",
  "of", "on", "or", "per", "the", "to", "via", "vs", "with",
]);

function capitalize(token) {
  // Leave anything with a digit alone so "40L" and "1L" survive intact.
  if (token === "" || /\d/.test(token)) return token;
  // Uppercase the first *letter*, not the first character, so leading
  // punctuation like a quote doesn't swallow the capitalization.
  return token.toLowerCase().replace(/\p{L}/u, (letter) => letter.toUpperCase());
}

function toTitleCase(value) {
  const words = value.split(/\s+/).filter(Boolean);
  return words
    .map((word, index) => {
      const isEdge = index === 0 || index === words.length - 1;
      // Split on - and / but keep the separators, so "all-weather" -> "All-Weather".
      return word
        .split(/([-/])/)
        .map((part) => {
          if (part === "-" || part === "/") return part;
          if (!isEdge && SMALL_WORDS.has(part.toLowerCase())) return part.toLowerCase();
          return capitalize(part);
        })
        .join("");
    })
    .join(" ");
}

function parsePrice(raw) {
  const cleaned = raw.replace(/[^0-9.\-]/g, "");
  if (cleaned === "") return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

// --- Claude call -----------------------------------------------------------

/** Pull the JSON object out of the response text, tolerating stray fences or prose. */
function extractJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`no JSON object in model response: ${JSON.stringify(text.slice(0, 200))}`);
  }
  return JSON.parse(text.slice(start, end + 1));
}

async function requestDescription(client, productName) {
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 8192,
    // Server-side refusal fallback: if a safety classifier declines, the API
    // retries the same request on a fallback model inside this one call.
    // Drop these two lines (and use client.messages.create) if you don't want it.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low" },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Input: "${productName}"` }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error(`model declined the request (${response.stop_details?.category ?? "unknown"})`);
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("response hit max_tokens before finishing");
  }

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  const parsed = extractJsonObject(text);
  const description =
    typeof parsed.description === "string" ? parsed.description.trim() : "";
  if (description === "") throw new Error('model returned an empty "description" field');
  return description;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One retry for the transient failure classes; anything else surfaces immediately. */
async function requestDescriptionWithRetry(client, productName) {
  try {
    return await requestDescription(client, productName);
  } catch (error) {
    const transient =
      error instanceof Anthropic.RateLimitError ||
      error instanceof Anthropic.APIConnectionError ||
      (error instanceof Anthropic.APIError && error.status >= 500);
    if (!transient) throw error;
    await sleep(2000);
    return requestDescription(client, productName);
  }
}

function describeApiError(error) {
  if (error instanceof Anthropic.AuthenticationError) {
    return "authentication failed — check ANTHROPIC_API_KEY in .env";
  }
  if (error instanceof Anthropic.RateLimitError) return "rate limited";
  if (error instanceof Anthropic.BadRequestError) return `bad request: ${error.message}`;
  if (error instanceof Anthropic.APIConnectionError) return `connection error: ${error.message}`;
  if (error instanceof Anthropic.APIError) return `API error ${error.status}: ${error.message}`;
  return error.message;
}

// --- Main ------------------------------------------------------------------

function readRows(csvPath) {
  let raw;
  try {
    raw = fs.readFileSync(csvPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`CSV not found: ${csvPath}`);
    if (error.code === "EACCES") throw new Error(`CSV is not readable: ${csvPath}`);
    throw error;
  }
  const rows = parseCsv(raw.replace(/^﻿/, ""));
  if (rows.length === 0) throw new Error(`CSV is empty: ${csvPath}`);
  return rows;
}

async function main() {
  const rows = readRows(CSV_PATH);
  const [header, ...dataRows] = rows;
  const { columns, warning } = resolveColumns(header);

  const skipped = [];
  const products = [];

  dataRows.forEach((row, index) => {
    const lineNumber = index + 2; // +1 for the header, +1 for 1-based lines
    const cell = (columnIndex) =>
      columnIndex >= 0 && columnIndex < row.length ? row[columnIndex].trim() : "";

    const name = cell(columns.name);
    const description = cell(columns.description);
    const rawPrice = cell(columns.price);

    const problems = [];
    if (row.length !== header.length) {
      problems.push(`expected ${header.length} columns, got ${row.length}`);
    }
    if (name === "") problems.push("missing name");

    const price = parsePrice(rawPrice);
    if (price === null) {
      problems.push(rawPrice === "" ? "missing price" : `unparseable price "${rawPrice}"`);
    }

    // A short row is survivable as long as we still got a name and a price.
    if (name === "" || price === null) {
      skipped.push({ line: lineNumber, reason: problems.join("; "), raw: row.join(",") });
      return;
    }
    if (problems.length > 0) {
      console.warn(`Line ${lineNumber}: ${problems.join("; ")} — kept anyway.`);
    }

    products.push({
      line: lineNumber,
      name: toTitleCase(name),
      description,
      price,
      source: description === "" ? "pending" : "csv",
    });
  });

  if (warning) console.warn(`Warning: ${warning}`);

  const needDescriptions = products.filter((p) => p.source === "pending");

  if (needDescriptions.length > 0) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        `${needDescriptions.length} row(s) need a generated description, but ANTHROPIC_API_KEY is not set. Add it to .env next to this script.`,
      );
    }
    const client = new Anthropic({ apiKey });

    for (const product of needDescriptions) {
      console.error(`Generating description for "${product.name}"...`);
      try {
        product.description = await requestDescriptionWithRetry(client, product.name);
        product.source = "claude";
      } catch (error) {
        product.description = "(generation failed)";
        product.source = "error";
        console.warn(`  Line ${product.line}: ${describeApiError(error)}`);
      }
    }
  }

  console.log(`\nCleaned products (${products.length} of ${dataRows.length} rows):`);
  console.table(
    products.map((p) => ({
      name: p.name,
      description: p.description,
      price: p.price.toFixed(2),
      source: p.source,
    })),
  );

  if (skipped.length > 0) {
    console.log(`Skipped ${skipped.length} malformed row(s):`);
    console.table(skipped);
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
