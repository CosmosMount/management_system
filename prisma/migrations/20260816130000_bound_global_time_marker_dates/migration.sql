ALTER TABLE "GlobalTimeMarker"
DROP CONSTRAINT "GlobalTimeMarker_marked_at_check";

ALTER TABLE "GlobalTimeMarker"
ADD CONSTRAINT "GlobalTimeMarker_marked_at_check" CHECK (
  isfinite("markedAt")
  AND "markedAt" >= TIMESTAMPTZ '0001-01-01 00:00:00+00'
  AND "markedAt" <= TIMESTAMPTZ '9999-12-31 23:59:59.998+00'
);
