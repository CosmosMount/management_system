CREATE TABLE "GlobalTimeMarker" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "markedAt" TIMESTAMPTZ(6) NOT NULL,
    "deletedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "GlobalTimeMarker_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GlobalTimeMarker_name_check" CHECK (
      char_length(btrim("name")) BETWEEN 1 AND 100
    ),
    CONSTRAINT "GlobalTimeMarker_marked_at_check" CHECK (isfinite("markedAt"))
);

CREATE INDEX "GlobalTimeMarker_deletedAt_markedAt_id_idx"
ON "GlobalTimeMarker"("deletedAt", "markedAt", "id");
