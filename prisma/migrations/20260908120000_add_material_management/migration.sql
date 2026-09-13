BEGIN;

CREATE TABLE "Material" (
  "id" TEXT NOT NULL,
  "qrToken" UUID NOT NULL,
  "registrationKey" UUID NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "price" DECIMAL(12,2) NOT NULL,
  "techGroup" VARCHAR(32) NOT NULL,
  "createdByAccountId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "Material_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Material_createdByAccountId_fkey"
    FOREIGN KEY ("createdByAccountId") REFERENCES "Account"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Material_name_not_blank_check"
    CHECK (length(btrim("name")) > 0),
  CONSTRAINT "Material_price_range_check"
    CHECK ("price" >= 0 AND "price" <= 9999999999.99),
  CONSTRAINT "Material_tech_group_check"
    CHECK ("techGroup" IN ('机械', '硬件', '电控', '算法', '宣运', '通用'))
);

CREATE UNIQUE INDEX "Material_qrToken_key" ON "Material"("qrToken");
CREATE UNIQUE INDEX "Material_registrationKey_key" ON "Material"("registrationKey");
CREATE INDEX "Material_techGroup_createdAt_idx" ON "Material"("techGroup", "createdAt");
CREATE INDEX "Material_createdAt_idx" ON "Material"("createdAt");

CREATE TABLE "MaterialLoan" (
  "id" TEXT NOT NULL,
  "materialId" TEXT NOT NULL,
  "borrowerAccountId" TEXT NOT NULL,
  "checkoutIdempotencyKey" UUID NOT NULL,
  "returnIdempotencyKey" UUID,
  "checkedOutAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "returnedAt" TIMESTAMPTZ(6),
  CONSTRAINT "MaterialLoan_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MaterialLoan_materialId_fkey"
    FOREIGN KEY ("materialId") REFERENCES "Material"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MaterialLoan_borrowerAccountId_fkey"
    FOREIGN KEY ("borrowerAccountId") REFERENCES "Account"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MaterialLoan_return_pair_check"
    CHECK (
      ("returnedAt" IS NULL AND "returnIdempotencyKey" IS NULL)
      OR
      ("returnedAt" IS NOT NULL AND "returnIdempotencyKey" IS NOT NULL)
    ),
  CONSTRAINT "MaterialLoan_return_time_check"
    CHECK ("returnedAt" IS NULL OR "returnedAt" >= "checkedOutAt")
);

CREATE UNIQUE INDEX "MaterialLoan_checkoutIdempotencyKey_key"
  ON "MaterialLoan"("checkoutIdempotencyKey");
CREATE UNIQUE INDEX "MaterialLoan_returnIdempotencyKey_key"
  ON "MaterialLoan"("returnIdempotencyKey");
CREATE UNIQUE INDEX "MaterialLoan_one_active_per_material_key"
  ON "MaterialLoan"("materialId") WHERE "returnedAt" IS NULL;
CREATE INDEX "MaterialLoan_materialId_returnedAt_checkedOutAt_idx"
  ON "MaterialLoan"("materialId", "returnedAt", "checkedOutAt");
CREATE INDEX "MaterialLoan_borrowerAccountId_returnedAt_checkedOutAt_idx"
  ON "MaterialLoan"("borrowerAccountId", "returnedAt", "checkedOutAt");

CREATE FUNCTION "prevent_material_identity_mutation"()
RETURNS trigger AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."qrToken" IS DISTINCT FROM OLD."qrToken"
    OR NEW."registrationKey" IS DISTINCT FROM OLD."registrationKey"
    OR NEW."createdByAccountId" IS DISTINCT FROM OLD."createdByAccountId"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'Material identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Material_prevent_identity_update"
  BEFORE UPDATE ON "Material"
  FOR EACH ROW EXECUTE FUNCTION "prevent_material_identity_mutation"();

CREATE FUNCTION "protect_material_loan_history"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'MaterialLoan history is append-only';
  END IF;
  IF OLD."returnedAt" IS NOT NULL
    OR NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."materialId" IS DISTINCT FROM OLD."materialId"
    OR NEW."borrowerAccountId" IS DISTINCT FROM OLD."borrowerAccountId"
    OR NEW."checkoutIdempotencyKey" IS DISTINCT FROM OLD."checkoutIdempotencyKey"
    OR NEW."checkedOutAt" IS DISTINCT FROM OLD."checkedOutAt"
    OR NEW."returnedAt" IS NULL
    OR NEW."returnIdempotencyKey" IS NULL
  THEN
    RAISE EXCEPTION 'MaterialLoan history is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MaterialLoan_protect_history"
  BEFORE UPDATE OR DELETE ON "MaterialLoan"
  FOR EACH ROW EXECUTE FUNCTION "protect_material_loan_history"();

COMMIT;
