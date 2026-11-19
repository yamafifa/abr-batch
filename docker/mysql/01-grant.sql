-- ローカル開発用：Prisma Migrate がシャドウDB（作業用の一時DB）を作れるよう権限を付ける
GRANT ALL PRIVILEGES ON *.* TO 'abr'@'%';
FLUSH PRIVILEGES;
