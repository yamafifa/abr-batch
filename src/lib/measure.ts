/** 処理時間と最大メモリ使用量を表示する */
export function report(label: string, rows: number, startedAt: bigint): void {
  const sec = Number(process.hrtime.bigint() - startedAt) / 1e9;
  const maxRssMb = process.resourceUsage().maxRSS / 1024; // maxRSS は KB 単位
  console.log(
    [
      `[${label}]`,
      `件数: ${rows.toLocaleString()}`,
      `時間: ${sec.toFixed(2)} 秒`,
      `速度: ${Math.round(rows / sec).toLocaleString()} 件/秒`,
      `最大メモリ: ${maxRssMb.toFixed(0)} MB`,
    ].join("  "),
  );
}
