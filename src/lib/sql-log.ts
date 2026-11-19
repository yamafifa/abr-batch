/**
 * SQL ログ（logs/sql-日時.jsonl.gz）：実行した SQL を 1 文につき 1 行で残す
 * - SQL 文、引数の数、かかった時間、件数（SELECT は返した行数、更新系は affectedRows）
 * - 引数の値は書かない（1 回で 22,000 個になり、ログが巨大になるため。値は変更ログに残る）
 * - 同じ形のプレースホルダーの並び「(?, ?), (?, ?), ...」は「(?, ?) ×1000」に縮める
 */
import { once } from "node:events";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { createGzip, type Gzip } from "node:zlib";
import type { Connection } from "mariadb";
import { nowJst } from "./time.js";

/** 空白をつめ、繰り返しのプレースホルダーを縮める */
function compactSql(sql: string): string {
  const oneLine = sql.replace(/\s+/g, " ").trim();
  return oneLine.replace(/(\([?, ]+\))(?:, \1)+/g, (m, group: string) => {
    const n = m.split(group).length - 1;
    return `${group} ×${n}`;
  });
}

export class SqlLog {
  readonly path: string;
  private gzip: Gzip;
  private file: WriteStream;

  constructor(path: string) {
    mkdirSync("logs", { recursive: true });
    this.path = path;
    this.gzip = createGzip();
    this.file = createWriteStream(path);
    this.gzip.pipe(this.file);
  }

  private async write(entry: object): Promise<void> {
    if (!this.gzip.write(JSON.stringify({ at: nowJst(), ...entry }) + "\n")) {
      await once(this.gzip, "drain");
    }
  }

  /** 接続の query を包んで、実行した SQL を記録する関数を返す */
  wrap(conn: Connection, name: string) {
    return async <T = any>(sql: string, params: unknown[] = []): Promise<T> => {
      const t0 = process.hrtime.bigint();
      try {
        const result = await conn.query(sql, params);
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        const rows = Array.isArray(result) ? { rows: result.length } : { affectedRows: Number(result.affectedRows) };
        await this.write({ conn: name, ms: Number(ms.toFixed(1)), ...rows, params: params.length, sql: compactSql(sql) });
        return result as T;
      } catch (err) {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        await this.write({ conn: name, ms: Number(ms.toFixed(1)), error: String(err), params: params.length, sql: compactSql(sql) });
        throw err;
      }
    };
  }

  async close(): Promise<void> {
    const closed = once(this.file, "close");
    this.gzip.end();
    await closed;
  }
}
