import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

export type CsvInput = {
  month: string;
  content: Buffer;
};

export type CombinedCsv = {
  content: string;
  rowCount: number;
  columnCount: number;
};

export function combineCsvContents(files: CsvInput[]): CombinedCsv {
  let headers: string[] | null = null;
  const rows: string[][] = [];
  for (const file of files) {
    const records = parse(file.content, { bom: true, skip_empty_lines: true }) as string[][];
    const fileHeaders = records[0];
    if (!fileHeaders || fileHeaders.length === 0) {
      throw new Error(`${file.month}のCSVにヘッダーがありません。結合を中止しました。`);
    }
    if (headers && (headers.length !== fileHeaders.length || headers.some((header, index) => header !== fileHeaders[index]))) {
      throw new Error(`${file.month}のCSV列が他の月と異なります。結合を中止しました。`);
    }
    headers ??= fileHeaders;
    rows.push(...records.slice(1));
  }
  if (!headers) throw new Error("結合するCSVがありません。");

  return {
    content: stringify([headers, ...rows], { bom: true, record_delimiter: "windows" }),
    rowCount: rows.length,
    columnCount: headers.length,
  };
}