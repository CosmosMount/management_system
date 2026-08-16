import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const PRISMA_SCHEMA_REVISION = "termination-review-approval-v1";

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
    typeof client.user?.findMany !== "function" ||
    typeof client.userRole?.findMany !== "function" ||
    typeof client.purchaseOrder?.findMany !== "function" ||
    typeof client.purchaseItem?.findMany !== "function" ||
    typeof client.fileAsset?.findMany !== "function" ||
    typeof client.notificationOutbox?.findMany !== "function" ||
    typeof client.notificationOutboxRecipient?.findMany !== "function" ||
    typeof client.feedback?.findMany !== "function" ||
    typeof client.feedbackMessage?.findMany !== "function" ||
    typeof client.feedbackAttachment?.findMany !== "function" ||
    typeof client.processingVendor?.findMany !== "function" ||
    typeof client.procurementBudgetPool?.findMany !== "function" ||
    typeof client.procurementFeishuCard?.findMany !== "function" ||
    typeof client.account?.findMany !== "function" ||
    typeof client.accountIdentity?.findMany !== "function" ||
    typeof client.person?.findMany !== "function" ||
    typeof client.task?.findMany !== "function" ||
    typeof client.taskPlanVersion?.findMany !== "function" ||
    typeof client.taskNode?.findMany !== "function" ||
    typeof client.workSegment?.findMany !== "function" ||
    typeof client.inAppNotification?.findMany !== "function" ||
    typeof client.domainAuditEvent?.findMany !== "function"
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
