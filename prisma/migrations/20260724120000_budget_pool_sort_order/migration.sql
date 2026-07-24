-- AlterTable
ALTER TABLE "ProcurementBudgetPool" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- Backfill: preserve relative creation order within each period
WITH ranked AS (
  SELECT
    id,
    (ROW_NUMBER() OVER (
      PARTITION BY "period"
      ORDER BY "createdAt" ASC, "team" ASC, "techGroup" ASC
    ) - 1)::INTEGER AS rn
  FROM "ProcurementBudgetPool"
)
UPDATE "ProcurementBudgetPool" AS pool
SET "sortOrder" = ranked.rn
FROM ranked
WHERE pool.id = ranked.id;
