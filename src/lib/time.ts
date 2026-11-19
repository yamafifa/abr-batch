const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 日本時間の ISO 形式（例：2026-11-19T15:00:17.123+09:00） */
export function nowJst(): string {
  return new Date(Date.now() + JST_OFFSET_MS).toISOString().replace("Z", "+09:00");
}

/** ファイル名用の日本時間（例：20261119-150017） */
export function stampJst(): string {
  return nowJst().slice(0, 19).replace(/-|:/g, "").replace("T", "-");
}
