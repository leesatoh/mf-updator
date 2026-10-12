import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "csv-parse/sync";
import { combineCsvContents } from "../src/csv-combine.js";

test("combines CSV records with one BOM-prefixed header and preserves quoted fields", () => {
  const combined = combineCsvContents([
    {
      month: "2026-01",
      content: Buffer.from("\uFEFFdate,description\r\n2026-01-01,\"item, one\"\r\n"),
    },
    {
      month: "2026-02",
      content: Buffer.from("date,description\r\n2026-02-01,\"two\nlines\"\r\n"),
    },
  ]);
  const records = parse(combined.content, { bom: true }) as string[][];

  assert.equal(combined.rowCount, 2);
  assert.equal(combined.columnCount, 2);
  assert.equal(records.length, 3);
  assert.deepEqual(records[1], ["2026-01-01", "item, one"]);
  assert.deepEqual(records[2], ["2026-02-01", "two\nlines"]);
});

test("rejects monthly CSV files with different headers", () => {
  assert.throws(
    () => combineCsvContents([
      { month: "2026-01", content: Buffer.from("date,amount\n") },
      { month: "2026-02", content: Buffer.from("date,description\n") },
    ]),
    /2026-02のCSV列が他の月と異なります/,
  );
});

test("rejects empty input and CSV files without a header", () => {
  assert.throws(() => combineCsvContents([]), /結合するCSVがありません/);
  assert.throws(
    () => combineCsvContents([{ month: "2026-01", content: Buffer.alloc(0) }]),
    /2026-01のCSVにヘッダーがありません/,
  );
});