export type DateRange = {
  from: string | null;
  to: string;
};

function getTokyoToday(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

function isValidDate(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

export function parseDateRange(arguments_: string[], today = getTokyoToday()): DateRange {
  let from: string | null = null;
  let to: string | null = null;
  for (const argument of arguments_) {
    if (argument.startsWith("--from=")) {
      if (from !== null) throw new Error("--from は1回だけ指定できます。");
      from = argument.slice("--from=".length);
    } else if (argument.startsWith("--to=")) {
      if (to !== null) throw new Error("--to は1回だけ指定できます。");
      to = argument.slice("--to=".length);
    }
  }

  const end = to ?? today;
  if (from !== null && !isValidDate(from)) throw new Error("--from はYYYY-MM-DD形式で指定してください。");
  if (!isValidDate(end)) throw new Error("--to はYYYY-MM-DD形式で指定してください。");
  if (from !== null && from > end) throw new Error("--from は--to以前の日付を指定してください。");
  return { from, to: end };
}

export function isDateInRange(date: string, range: DateRange): boolean {
  return (range.from === null || date >= range.from) && date <= range.to;
}
