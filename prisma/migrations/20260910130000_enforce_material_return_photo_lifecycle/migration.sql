BEGIN;

ALTER TABLE "MaterialLoan"
  ADD CONSTRAINT "MaterialLoan_return_photo_lifecycle_check"
  CHECK (
    "returnedAt" IS NULL
    OR "returnPhotoPath" IS NOT NULL
    OR "returnPhotoClearedAt" IS NOT NULL
  ) NOT VALID,
  ADD CONSTRAINT "MaterialLoan_return_photo_clear_pair_check"
  CHECK (
    "returnPhotoClearedAt" IS NULL
    OR ("returnedAt" IS NOT NULL AND "returnPhotoPath" IS NULL)
  );

COMMIT;
