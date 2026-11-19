/** mt_rsdtdsp_rsdt の列（CSV と DB で同じ名前・同じ並び） */
export const KEY_COLUMNS = ["lg_code", "machiaza_id", "blk_id", "rsdt_id", "rsdt2_id"] as const;
export const VALUE_COLUMNS = [
  "city", "ward", "oaza_cho", "chome", "koaza", "machiaza_dist", "blk_num", "rsdt_num",
  "rsdt_num2", "basic_rsdt_div", "rsdt_addr_flg", "rsdt_addr_mtd_code", "status_flg",
  "efct_date", "ablt_date", "src_code", "remarks",
] as const;
export const ALL_COLUMNS = [...KEY_COLUMNS, ...VALUE_COLUMNS] as const;

/** NOT NULL の列（空文字のまま入れる）。それ以外は空文字を NULL として扱う */
const NOT_NULL = new Set<string>([...KEY_COLUMNS, "city"]);

/** 1 行分。日付は 'YYYY-MM-DD' の文字列、空は null */
export type Row = Record<(typeof ALL_COLUMNS)[number], string | null>;

/** CSV の 1 行を、DB から読んだときと同じ形にそろえる */
export function normalizeCsvRow(r: Record<string, string>): Row {
  const out = {} as Row;
  for (const c of ALL_COLUMNS) {
    const v = r[c] ?? "";
    out[c] = v === "" && !NOT_NULL.has(c) ? null : v;
  }
  return out;
}

/** 主キーの大小を比べる（DB の ORDER BY と同じ順になるよう、列ごとに比べる） */
export function compareKey(a: Row, b: Row): number {
  for (const c of KEY_COLUMNS) {
    const x = a[c] ?? "";
    const y = b[c] ?? "";
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

export const keyOf = (r: Row): Record<string, string | null> =>
  Object.fromEntries(KEY_COLUMNS.map((c) => [c, r[c]]));

/** 値の列で違うものを { 列名: [変更前, 変更後] } で返す */
export function diffValues(before: Row, after: Row): Record<string, [string | null, string | null]> {
  const changes: Record<string, [string | null, string | null]> = {};
  for (const c of VALUE_COLUMNS) {
    if (before[c] !== after[c]) changes[c] = [before[c], after[c]];
  }
  return changes;
}
