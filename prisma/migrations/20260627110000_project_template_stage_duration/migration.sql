WITH ordered_stages AS (
  SELECT
    "id",
    "dueOffsetDays",
    LAG("dueOffsetDays") OVER (
      PARTITION BY "templateId"
      ORDER BY "sortOrder" ASC, "createdAt" ASC, "id" ASC
    ) AS "previousDueOffsetDays"
  FROM "ProjectTemplateStage"
)
UPDATE "ProjectTemplateStage" AS stage
SET "dueOffsetDays" = GREATEST(
  ordered_stages."dueOffsetDays" - COALESCE(ordered_stages."previousDueOffsetDays", 0),
  1
)
FROM ordered_stages
WHERE stage."id" = ordered_stages."id";
