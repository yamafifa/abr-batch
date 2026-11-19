-- CreateTable
CREATE TABLE `mt_rsdtdsp_rsdt` (
    `lg_code` CHAR(6) NOT NULL,
    `machiaza_id` CHAR(7) NOT NULL,
    `blk_id` VARCHAR(3) NOT NULL,
    `rsdt_id` VARCHAR(3) NOT NULL,
    `rsdt2_id` VARCHAR(5) NOT NULL DEFAULT '',
    `city` VARCHAR(20) NOT NULL,
    `ward` VARCHAR(20) NULL,
    `oaza_cho` VARCHAR(80) NULL,
    `chome` VARCHAR(20) NULL,
    `koaza` VARCHAR(80) NULL,
    `machiaza_dist` VARCHAR(10) NULL,
    `blk_num` VARCHAR(20) NULL,
    `rsdt_num` VARCHAR(20) NULL,
    `rsdt_num2` VARCHAR(20) NULL,
    `basic_rsdt_div` VARCHAR(1) NULL,
    `rsdt_addr_flg` VARCHAR(1) NULL,
    `rsdt_addr_mtd_code` VARCHAR(1) NULL,
    `status_flg` VARCHAR(1) NULL,
    `efct_date` DATE NULL,
    `ablt_date` DATE NULL,
    `src_code` VARCHAR(2) NULL,
    `remarks` VARCHAR(255) NULL,

    PRIMARY KEY (`lg_code`, `machiaza_id`, `blk_id`, `rsdt_id`, `rsdt2_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
