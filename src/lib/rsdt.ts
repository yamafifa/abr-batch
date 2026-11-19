import type { Prisma } from "../generated/prisma/client.js";

/** CSVの1行（列名がキー） */
export type RsdtCsvRow = Record<string, string>;

const blankToNull = (v: string | undefined): string | null =>
  v === undefined || v === "" ? null : v;

const toDate = (v: string | undefined): Date | null =>
  v ? new Date(`${v}T00:00:00Z`) : null;

/** CSVの1行を、Prismaに渡す形に変える */
export function toRsdt(r: RsdtCsvRow): Prisma.RsdtdspRsdtCreateInput {
  return {
    lgCode: r["lg_code"]!,
    machiazaId: r["machiaza_id"]!,
    blkId: r["blk_id"]!,
    rsdtId: r["rsdt_id"]!,
    rsdt2Id: r["rsdt2_id"] ?? "",
    city: r["city"]!,
    ward: blankToNull(r["ward"]),
    oazaCho: blankToNull(r["oaza_cho"]),
    chome: blankToNull(r["chome"]),
    koaza: blankToNull(r["koaza"]),
    machiazaDist: blankToNull(r["machiaza_dist"]),
    blkNum: blankToNull(r["blk_num"]),
    rsdtNum: blankToNull(r["rsdt_num"]),
    rsdtNum2: blankToNull(r["rsdt_num2"]),
    basicRsdtDiv: blankToNull(r["basic_rsdt_div"]),
    rsdtAddrFlg: blankToNull(r["rsdt_addr_flg"]),
    rsdtAddrMtdCode: blankToNull(r["rsdt_addr_mtd_code"]),
    statusFlg: blankToNull(r["status_flg"]),
    efctDate: toDate(r["efct_date"]),
    abltDate: toDate(r["ablt_date"]),
    srcCode: blankToNull(r["src_code"]),
    remarks: blankToNull(r["remarks"]),
  };
}
