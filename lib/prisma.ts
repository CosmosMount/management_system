import path from "path";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

function resolveSqlitePath(): string {
  const url = process.env.DATABASE_URL ?? "file:./dev.db";
  const raw = url.replace(/^file:/, "");
  if (path.isAbsolute(raw)) {
    return raw;
  }
  return path.join(process.cwd(), raw.replace(/^\.\//, ""));
}

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

function createPrismaClient(): PrismaClient {
  const adapter = new PrismaBetterSqlite3({
    url: resolveSqlitePath(),
  });
  return new PrismaClient({ adapter });
}

function isPrismaClientStale(client: PrismaClient): boolean {
  // schema 变更后 dev 热更新可能仍持有旧 client，缺少新 model delegate
  return (
    typeof client.project?.findMany !== "function" ||
    typeof client.projectOwner?.findMany !== "function" ||
    typeof client.projectParticipant?.findMany !== "function" ||
    typeof client.projectStage?.findMany !== "function" ||
    typeof client.taskAssignee?.findMany !== "function" ||
    typeof client.taskCreationRequest?.findMany !== "function" ||
    typeof client.acceptanceChecklistTemplate?.findMany !== "function" ||
    typeof client.taskAcceptanceChecklistItem?.findMany !== "function" ||
    typeof client.approvalChecklistConfirmation?.findMany !== "function" ||
    typeof client.fileAsset?.findMany !== "function" ||
    typeof client.notificationOutbox?.findMany !== "function" ||
    typeof client.progressReminderRule?.findMany !== "function" ||
    typeof client.feedback?.findMany !== "function"
  );
}

function getPrismaClient(): PrismaClient {
  const cached = globalForPrisma.prisma;
  if (cached && !isPrismaClientStale(cached)) {
    return cached;
  }
  const client = createPrismaClient();
  if (process.env.NODE_ENV !== "production") {
    globalForPrisma.prisma = client;
  }
  return client;
}

export const prisma = getPrismaClient();
