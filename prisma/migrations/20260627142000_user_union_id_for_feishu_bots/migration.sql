ALTER TABLE "User"
  ADD COLUMN "unionId" TEXT;

CREATE UNIQUE INDEX "User_unionId_key" ON "User"("unionId");
