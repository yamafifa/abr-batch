import "dotenv/config";
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "../generated/prisma/client.js";

const url = new URL(process.env["DATABASE_URL"] ?? "");

export function createPrisma(): PrismaClient {
  const adapter = new PrismaMariaDb({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
    connectionLimit: 5,
    // MySQL 8.4 の caching_sha2_password で、再起動直後の最初のログインに必要（TLS を使わないため）。
    // 公開鍵をサーバーから受け取るので、手元の Docker の DB に接続する前提の設定
    allowPublicKeyRetrieval: true,
  });
  return new PrismaClient({ adapter });
}
