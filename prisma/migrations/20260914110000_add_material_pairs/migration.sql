ALTER TABLE "Material" ADD COLUMN "pairKey" UUID;

CREATE INDEX "Material_pairKey_idx" ON "Material"("pairKey");

CREATE OR REPLACE FUNCTION "prevent_material_identity_mutation"()
RETURNS trigger AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."qrToken" IS DISTINCT FROM OLD."qrToken"
    OR NEW."registrationKey" IS DISTINCT FROM OLD."registrationKey"
    OR NEW."createdByAccountId" IS DISTINCT FROM OLD."createdByAccountId"
    OR NEW."pairKey" IS DISTINCT FROM OLD."pairKey"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'Material identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
