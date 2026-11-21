/**
 * Elasticsearch の REST API を fetch で呼ぶ（公式クライアントは入れていない）
 * 接続先は .env の ES_URL。無ければ compose.yaml の http://127.0.0.1:9200
 */
import "dotenv/config";

export const ES_URL = (process.env["ES_URL"] ?? "http://127.0.0.1:9200").replace(/\/$/, "");

/** AP が検索に使う別名。中身のインデックスは rsdt_日時 */
export const ALIAS = "rsdt";
export const INDEX_PREFIX = `${ALIAS}_`;

export async function es<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  contentType = "application/json",
): Promise<T> {
  const res = await fetch(`${ES_URL}${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": contentType },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Elasticsearch ${method} ${path} が失敗しました（${res.status}）: ${text.slice(0, 1000)}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

/** 別名が今どのインデックスを指しているか（無ければ空） */
export async function aliasTargets(): Promise<string[]> {
  const res = await fetch(`${ES_URL}/_alias/${ALIAS}`);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Elasticsearch GET /_alias/${ALIAS} が失敗しました（${res.status}）`);
  return Object.keys((await res.json()) as Record<string, unknown>);
}
