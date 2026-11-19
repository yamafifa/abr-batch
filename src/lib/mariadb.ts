import "dotenv/config";
import mariadb, { type Connection, type ConnectionConfig } from "mariadb";

/** .env の DATABASE_URL で mariadb ドライバーの接続を作る */
export function createConnection(
  extra: Partial<ConnectionConfig> = {},
): Promise<Connection> {
  const url = new URL(process.env["DATABASE_URL"] ?? "");
  return mariadb.createConnection({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
    ...extra,
  });
}
