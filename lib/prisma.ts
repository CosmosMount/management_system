import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const PRISMA_SCHEMA_REVISION = "procurement-approver-open-ids-v1";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  pgPool: Pool | undefined;
  prismaSchemaRevision?: string;
};

function isPrismaClientStale(client: PrismaClient): boolean {
  if (globalForPrisma.prismaSchemaRevision !== PRISMA_SCHEMA_REVISION) {
    return true;
  }
  return (
    typeof client.project?.findMany !== "function" ||
    typeof client.projectOwner?.findMany !== "function" ||
    typeof client.projectParticipant?.findMany !== "function" ||
    typeof client.projectTemplate?.findMany !== "function" ||
    typeof client.projectTemplateStage?.findMany !== "function" ||
    typeof client.projectStage?.findMany !== "function" ||
    typeof client.projectDdlChangeRequest?.findMany !== "function" ||
    typeof client.taskAssignee?.findMany !== "function" ||
    typeof client.taskCreationRequest?.findMany !== "function" ||
    typeof client.acceptanceChecklistTemplate?.findMany !== "function" ||
    typeof client.taskAcceptanceChecklistItem?.findMany !== "function" ||
    typeof client.approvalChecklistConfirmation?.findMany !== "function" ||
    typeof client.fileAsset?.findMany !== "function" ||
    typeof client.notificationOutbox?.findMany !== "function" ||
    typeof client.progressReminderRule?.findMany !== "function" ||
    typeof client.feedback?.findMany !== "function" ||
    typeof client.processingVendor?.findMany !== "function" ||
    typeof client.procurementBudgetPool?.findMany !== "function"
  );
}

function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  if (
    !connectionString.startsWith("postgresql://") &&
    !connectionString.startsWith("postgres://")
  ) {
    throw new Error("DATABASE_URL must be a PostgreSQL connection string");
  }

  const pool =
    globalForPrisma.pgPool ??
    new Pool({
      connectionString,
      connectionTimeoutMillis: 5_000,
      max: 10,
    });

  if (process.env.NODE_ENV !== "production") {
    globalForPrisma.pgPool = pool;
  }

  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

function getPrismaClient(): PrismaClient {
  const cached = globalForPrisma.prisma;
  if (cached && !isPrismaClientStale(cached)) {
    return cached;
  }
  const client = createPrismaClient();
  if (process.env.NODE_ENV !== "production") {
    globalForPrisma.prisma = client;
    globalForPrisma.prismaSchemaRevision = PRISMA_SCHEMA_REVISION;
  }
  return client;
}

export const prisma = getPrismaClient();
