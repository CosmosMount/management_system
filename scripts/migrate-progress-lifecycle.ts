import "dotenv/config";
import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import path from "path";

function resolveSqlitePath(): string {
  const url = process.env.DATABASE_URL ?? "file:./dev.db";
  const raw = url.replace(/^file:/, "");
  if (path.isAbsolute(raw)) return raw;
  return path.join(process.cwd(), raw.replace(/^\.\//, ""));
}

const db = new Database(resolveSqlitePath());

function hasTable(name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return !!row;
}

function hasColumn(table: string, column: string): boolean {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => (row as { name: string }).name === column);
}

function addColumn(table: string, column: string, ddl: string) {
  if (!hasColumn(table, column)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`).run();
  }
}

if (hasTable("Project")) {
  addColumn("Project", "allowOwnerSelfApproval", "BOOLEAN NOT NULL DEFAULT false");
  addColumn("Project", "completedAt", "DATETIME");
  addColumn("Project", "canceledAt", "DATETIME");

  db.prepare(
    `UPDATE Project SET status = CASE
      WHEN status IN ('DRAFT') THEN 'NOT_STARTED'
      WHEN status IN ('IN_PROGRESS', 'NORMAL', 'ABNORMAL', 'UNDER_INTERVENTION') THEN 'IN_PROGRESS'
      WHEN status IN ('OUTCOME_GOOD', 'OUTCOME_POOR', 'ARCHIVED') THEN 'COMPLETED'
      ELSE status
    END`,
  ).run();
}

if (hasTable("ProjectMilestone")) {
  addColumn("ProjectMilestone", "goal", "TEXT NOT NULL DEFAULT ''");
  addColumn("ProjectMilestone", "ownerOpenId", "TEXT NOT NULL DEFAULT ''");
  addColumn("ProjectMilestone", "ownerName", "TEXT NOT NULL DEFAULT ''");
  addColumn("ProjectMilestone", "dueAt", "DATETIME");

  db.prepare(
    `UPDATE ProjectMilestone SET status = CASE
      WHEN status = 'PASSED' THEN 'COMPLETED'
      WHEN status = 'PENDING' AND COALESCE(submissionId, '') <> '' THEN 'PENDING_ACCEPTANCE'
      WHEN status = 'PENDING' AND COALESCE(feishuDocUrl, '') <> '' THEN 'PENDING_ACCEPTANCE'
      WHEN status = 'PENDING' THEN 'NOT_STARTED'
      WHEN status = 'FAILED' THEN 'IN_PROGRESS'
      ELSE status
    END`,
  ).run();

  db.prepare(
    `UPDATE ProjectMilestone
      SET ownerOpenId = COALESCE(NULLIF(ownerOpenId, ''), (
        SELECT ownerOpenId FROM Project WHERE Project.id = ProjectMilestone.projectId
      )),
      ownerName = COALESCE(NULLIF(ownerName, ''), (
        SELECT ownerName FROM Project WHERE Project.id = ProjectMilestone.projectId
      )),
      goal = COALESCE(NULLIF(goal, ''), name)`,
  ).run();

  const activeProjects = db
    .prepare("SELECT id FROM Project WHERE status = 'IN_PROGRESS'")
    .all() as { id: string }[];
  const firstOpenStage = db.prepare(
    `SELECT id FROM ProjectMilestone
      WHERE projectId = ?
        AND status IN ('NOT_STARTED', 'IN_PROGRESS', 'PENDING_ACCEPTANCE')
      ORDER BY sortOrder ASC
      LIMIT 1`,
  );
  const activateStage = db.prepare(
    `UPDATE ProjectMilestone SET status = 'IN_PROGRESS'
      WHERE id = ? AND status = 'NOT_STARTED'`,
  );
  for (const project of activeProjects) {
    const stage = firstOpenStage.get(project.id) as { id: string } | undefined;
    if (stage) activateStage.run(stage.id);
  }
}

if (hasTable("Task")) {
  addColumn("Task", "stageId", "TEXT");
  addColumn("Task", "needsOfflineConfirmation", "BOOLEAN NOT NULL DEFAULT false");
  addColumn("Task", "needsWeeklyReport", "BOOLEAN NOT NULL DEFAULT false");
  addColumn("Task", "riskNote", "TEXT NOT NULL DEFAULT ''");
  addColumn("Task", "riskUpdatedAt", "DATETIME");

  db.prepare(
    `CREATE TABLE IF NOT EXISTS TaskAssignee (
      id TEXT NOT NULL PRIMARY KEY,
      taskId TEXT NOT NULL,
      openId TEXT NOT NULL,
      name TEXT NOT NULL,
      sortOrder INTEGER NOT NULL DEFAULT 0,
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT TaskAssignee_taskId_fkey
        FOREIGN KEY (taskId) REFERENCES Task (id)
        ON DELETE CASCADE ON UPDATE CASCADE
    )`,
  ).run();
  db.prepare(
    `CREATE UNIQUE INDEX IF NOT EXISTS TaskAssignee_taskId_openId_key
      ON TaskAssignee (taskId, openId)`,
  ).run();
  addColumn("TaskAssignee", "sortOrder", "INTEGER NOT NULL DEFAULT 0");

  const tasks = db
    .prepare(
      `SELECT id, assigneeOpenId, assigneeName FROM Task
        WHERE COALESCE(assigneeOpenId, '') <> ''`,
    )
    .all() as { id: string; assigneeOpenId: string; assigneeName: string }[];
  const hasAssignee = db.prepare(
    "SELECT id FROM TaskAssignee WHERE taskId = ? AND openId = ? LIMIT 1",
  );
  const insertAssignee = db.prepare(
    `INSERT INTO TaskAssignee (id, taskId, openId, name)
      VALUES (?, ?, ?, ?)`,
  );
  for (const task of tasks) {
    if (!hasAssignee.get(task.id, task.assigneeOpenId)) {
      insertAssignee.run(
        randomUUID(),
        task.id,
        task.assigneeOpenId,
        task.assigneeName,
      );
    }
  }
}

if (hasTable("TaskSubmission")) {
  addColumn("TaskSubmission", "stageId", "TEXT");
  db.prepare(
    `UPDATE TaskSubmission SET type = 'STAGE' WHERE type = 'MILESTONE'`,
  ).run();
  db.prepare(
    `UPDATE TaskSubmission
      SET stageId = (
        SELECT id FROM ProjectMilestone
        WHERE ProjectMilestone.submissionId = TaskSubmission.id
        LIMIT 1
      )
      WHERE type = 'STAGE' AND stageId IS NULL`,
  ).run();
}

if (hasTable("ApprovalRecord")) {
  addColumn("ApprovalRecord", "offlineConfirmed", "BOOLEAN NOT NULL DEFAULT false");
}

console.log("[migrate-progress-lifecycle] done");
