import { expect, test } from "@playwright/test";
import { logger, withActionLogging } from "../lib/logger";
import { withLogContext } from "../lib/log-context";

function captureConsole(callback: () => Promise<void> | void) {
  const lines: string[] = [];
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return Promise.resolve()
    .then(callback)
    .then(
      () => lines,
      (error) => {
        throw error;
      },
    )
    .finally(() => {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
    });
}

function parseLogLines(lines: string[]) {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

test.describe("structured logger", () => {
  test.beforeEach(() => {
    process.env.LOG_FORMAT = "json";
    process.env.LOG_LEVEL = "debug";
  });

  test.afterEach(() => {
    delete process.env.LOG_FORMAT;
    delete process.env.LOG_LEVEL;
  });

  test("outputs JSON logs with context and redacts sensitive fields", async () => {
    const lines = await captureConsole(() =>
      withLogContext(
        {
          requestId: "request-1",
          actorOpenId: "ou_actor",
          module: "test",
          action: "loggerSpec",
        },
        () => {
          logger.info("logger.spec.redaction", {
            entityType: "Project",
            entityId: "project-1",
            password: "plain-password",
            DATABASE_URL:
              "postgresql://postgres:db-password@localhost:5432/management_system",
            cookie: "session=plain-cookie",
            rawMessage:
              "Authorization: Bearer plain-bearer-token; token=plain-inline-token",
            nested: {
              appSecret: "plain-secret",
              token: "plain-token",
              safe: "visible",
            },
          });
        },
      ),
    );

    const [entry] = parseLogLines(lines);
    expect(entry.event).toBe("logger.spec.redaction");
    expect(entry.requestId).toBe("request-1");
    expect(entry.actorOpenId).toBe("ou_actor");
    expect(entry.module).toBe("test");
    expect(entry.action).toBe("loggerSpec");
    expect(entry.entityType).toBe("Project");
    expect(entry.entityId).toBe("project-1");
    expect(entry.password).toBe("[REDACTED]");
    expect(entry.DATABASE_URL).toBe("[REDACTED]");
    expect(entry.cookie).toBe("[REDACTED]");
    expect(entry.rawMessage).toContain("Authorization: [REDACTED]");
    expect(entry.rawMessage).toContain("token=[REDACTED]");
    expect(entry.nested).toMatchObject({
      appSecret: "[REDACTED]",
      token: "[REDACTED]",
      safe: "visible",
    });
    expect(JSON.stringify(entry)).not.toContain("plain-password");
    expect(JSON.stringify(entry)).not.toContain("db-password");
    expect(JSON.stringify(entry)).not.toContain("plain-cookie");
    expect(JSON.stringify(entry)).not.toContain("plain-bearer-token");
    expect(JSON.stringify(entry)).not.toContain("plain-inline-token");
    expect(JSON.stringify(entry)).not.toContain("plain-secret");
    expect(JSON.stringify(entry)).not.toContain("plain-token");
  });

  test("redacts sensitive content inside Error messages and stacks", async () => {
    const lines = await captureConsole(() => {
      logger.error("logger.spec.error_redaction", {
        error: new Error(
          "failed Authorization: Bearer error-token DATABASE_URL=postgresql://postgres:error-db-password@localhost:5432/app cookie=session-cookie",
        ),
      });
    });

    const [entry] = parseLogLines(lines);
    expect(entry.errorMessage).toContain("Authorization: [REDACTED]");
    expect(entry.errorMessage).toContain("DATABASE_URL=[REDACTED]");
    expect(entry.errorMessage).toContain("cookie=[REDACTED]");
    expect(JSON.stringify(entry)).not.toContain("error-token");
    expect(JSON.stringify(entry)).not.toContain("error-db-password");
    expect(JSON.stringify(entry)).not.toContain("session-cookie");
  });

  test("redacts Feishu webhook URLs and signed payload fields without hiding safe origins", async () => {
    const lines = await captureConsole(() => {
      logger.warn("logger.spec.feishu_redaction", {
        webhookUrl:
          "https://open.feishu.cn/open-apis/bot/v2/hook/plain-webhook-token",
        rawMessage:
          "callback webhook=https://open.feishu.cn/open-apis/bot/v2/hook/inline-webhook-token sign=inline-signature",
        signedPayload: {
          sign: "plain-signature",
          timestamp: "1700000000",
        },
        appOrigin: "http://127.0.0.1:3002",
        publicPath: "/uploads/procurement/demo.png",
      });
    });

    const [entry] = parseLogLines(lines);
    expect(entry.webhookUrl).toBe("[REDACTED]");
    expect(entry.rawMessage).toContain("webhook=[REDACTED]");
    expect(entry.rawMessage).toContain("sign=[REDACTED]");
    expect(entry.signedPayload).toMatchObject({
      sign: "[REDACTED]",
      timestamp: "1700000000",
    });
    expect(entry.appOrigin).toBe("http://127.0.0.1:3002");
    expect(entry.publicPath).toBe("/uploads/procurement/demo.png");
    expect(JSON.stringify(entry)).not.toContain("plain-webhook-token");
    expect(JSON.stringify(entry)).not.toContain("inline-webhook-token");
    expect(JSON.stringify(entry)).not.toContain("plain-signature");
    expect(JSON.stringify(entry)).not.toContain("inline-signature");
  });

  test("withActionLogging records start, success and failure with duration", async () => {
    const successLines = await captureConsole(async () => {
      await withActionLogging(
        {
          event: "logger.spec.action",
          module: "test",
          action: "success",
          actorOpenId: "ou_actor",
          entityType: "Task",
          entityId: "task-1",
        },
        async () => "ok",
      );
    });
    const successEntries = parseLogLines(successLines);
    expect(successEntries.map((entry) => entry.event)).toEqual([
      "logger.spec.action.start",
      "logger.spec.action",
    ]);
    expect(successEntries[1]).toMatchObject({
      level: "info",
      result: "success",
      actorOpenId: "ou_actor",
      entityType: "Task",
      entityId: "task-1",
    });
    expect(typeof successEntries[1].durationMs).toBe("number");

    const failureLines = await captureConsole(async () => {
      await expect(
        withActionLogging(
          {
            event: "logger.spec.failure",
            module: "test",
            action: "failure",
          },
          async () => {
            throw new Error("boom");
          },
        ),
      ).rejects.toThrow("boom");
    });
    const failureEntries = parseLogLines(failureLines);
    expect(failureEntries.map((entry) => entry.event)).toEqual([
      "logger.spec.failure.start",
      "logger.spec.failure",
    ]);
    expect(failureEntries[1]).toMatchObject({
      level: "error",
      result: "failure",
      errorCode: "Error",
      errorMessage: "boom",
    });
  });
});
