ALTER TYPE "FileAssetKind" ADD VALUE IF NOT EXISTS 'MATERIAL_RETURN_PHOTO';

BEGIN;

ALTER TABLE "MaterialLoan"
  ADD COLUMN "returnPhotoPath" TEXT,
  ADD COLUMN "returnPhotoClearedAt" TIMESTAMPTZ(6);

CREATE UNIQUE INDEX "MaterialLoan_returnPhotoPath_key"
  ON "MaterialLoan"("returnPhotoPath");

ALTER TABLE "MaterialLoan"
  ADD CONSTRAINT "MaterialLoan_returnPhotoPath_fkey"
  FOREIGN KEY ("returnPhotoPath") REFERENCES "FileAsset"("publicPath")
  ON DELETE RESTRICT ON UPDATE CASCADE;

DROP TRIGGER "MaterialLoan_protect_history" ON "MaterialLoan";
DROP FUNCTION "protect_material_loan_history"();

CREATE FUNCTION "protect_material_loan_history"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'MaterialLoan history is append-only';
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."materialId" IS DISTINCT FROM OLD."materialId"
    OR NEW."borrowerAccountId" IS DISTINCT FROM OLD."borrowerAccountId"
    OR NEW."checkoutIdempotencyKey" IS DISTINCT FROM OLD."checkoutIdempotencyKey"
    OR NEW."checkedOutAt" IS DISTINCT FROM OLD."checkedOutAt"
  THEN
    RAISE EXCEPTION 'MaterialLoan history is immutable';
  END IF;

  IF OLD."returnedAt" IS NULL THEN
    IF NEW."returnedAt" IS NULL
      OR NEW."returnIdempotencyKey" IS NULL
      OR NEW."returnPhotoPath" IS NULL
      OR NEW."returnPhotoClearedAt" IS NOT NULL
    THEN
      RAISE EXCEPTION 'MaterialLoan return requires a photo';
    END IF;
  ELSIF OLD."returnPhotoPath" IS NOT NULL
    AND NEW."returnedAt" IS NOT DISTINCT FROM OLD."returnedAt"
    AND NEW."returnIdempotencyKey" IS NOT DISTINCT FROM OLD."returnIdempotencyKey"
    AND NEW."returnPhotoPath" IS NULL
    AND NEW."returnPhotoClearedAt" IS NOT NULL
    AND OLD."returnPhotoClearedAt" IS NULL
  THEN
    RETURN NEW;
  ELSE
    RAISE EXCEPTION 'MaterialLoan history is immutable';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MaterialLoan_protect_history"
  BEFORE UPDATE OR DELETE ON "MaterialLoan"
  FOR EACH ROW EXECUTE FUNCTION "protect_material_loan_history"();

COMMIT;
