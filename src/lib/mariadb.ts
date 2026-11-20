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
    // MySQL 8.4 の caching_sha2_password で、再起動直後の最初のログインに必要（TLS を使わないため）。
    // 公開鍵をサーバーから受け取るので、手元の Docker の DB に接続する前提の設定
    allowPublicKeyRetrieval: true,
    ...extra,
  });
}
