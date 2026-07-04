import { createRequestId, getLogContext, withLogContext, type LogContext } from "@/lib/log-context";

type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = LogContext & {
  event?: string;
  level?: LogLevel | "audit";
  durationMs?: number;
  result?: "start" | "success" | "failure" | "skipped" | "prepared";
  errorCode?: string;
  errorMessage?: string;
  error?: unknown;
  [key: string]: unknown;
};

type ActionLogConfig = LogContext & {
  event: string;
  [key: string]: unknown;
};

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SENSITIVE_KEY_PATTERN =
  /password|passwd|pwd|secret|token|cookie|authorization|appsecret|app_secret|database_url|databaseurl|client_secret|private_key|access_token|refresh_token|webhook|signature|signed_payload|sign$/i;

const SENSITIVE_ASSIGNMENT_PATTERN =
  /\b(password|passwd|pwd|secret|token|cookie|authorization|appsecret|app_secret|database_url|databaseurl|client_secret|private_key|access_token|refresh_token|webhook|signature|sign)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi;
const BEARER_TOKEN_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const POSTGRES_URL_CREDENTIAL_PATTERN =
  /\b(postgres(?:ql)?:\/\/)([^:\s/@]+):([^@\s]+)@/gi;
const FEISHU_WEBHOOK_URL_PATTERN =
  /https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9._-]+/gi;

function redactString(value: string): string {
  return value
    .replace(
      FEISHU_WEBHOOK_URL_PATTERN,
      "https://open.feishu.cn/open-apis/bot/v2/hook/[REDACTED]",
    )
    .replace(BEARER_TOKEN_PATTERN, "$1[REDACTED]")
    .replace(POSTGRES_URL_CREDENTIAL_PATTERN, "$1[REDACTED]@")
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, (_match, key: string, separator: string) => {
      return `${key}${separator}[REDACTED]`;
    });
}

function configuredLevel(): LogLevel | "silent" {
  const value = process.env.LOG_LEVEL?.toLowerCase();
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  if (value === "silent") return "silent";
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

function shouldWrite(level: LogLevel): boolean {
  const active = configuredLevel();
  if (active === "silent") return false;
  return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[active];
}

function shouldUseJsonFormat(): boolean {
  if (process.env.LOG_FORMAT === "pretty") return false;
  if (process.env.LOG_FORMAT === "json") return true;
  return process.env.NODE_ENV !== "development";
}

function sanitize(value: unknown, key = "", depth = 0, seen = new WeakSet<object>()): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key)) return "[REDACTED]";
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack).slice(0, 4000) : undefined,
    };
  }
  if (Array.isArray(value)) {
    if (depth >= 5) return "[MaxDepth]";
    return value.slice(0, 50).map((item) => sanitize(item, key, depth + 1, seen));
  }
  if (typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    if (depth >= 5) return "[MaxDepth]";
    const output: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      output[entryKey] = sanitize(entryValue, entryKey, depth + 1, seen);
    }
    return output;
  }
  return String(value);
}

function serializeError(error: unknown): Pick<LogFields, "errorCode" | "errorMessage" | "error"> {
  if (error instanceof Error) {
    return {
      errorCode: error.name,
      errorMessage: error.message,
      error,
    };
  }
  return {
    errorCode: "NonErrorThrown",
    errorMessage: String(error),
    error,
  };
}

function write(level: LogLevel, event: string, fields: LogFields = {}) {
  if (!shouldWrite(level)) return;
  const context = getLogContext();
  const entry = sanitize({
    timestamp: new Date().toISOString(),
    requestId: context.requestId ?? fields.requestId,
    actorOpenId: context.actorOpenId ?? fields.actorOpenId,
    actorName: context.actorName ?? fields.actorName,
    module: context.module ?? fields.module,
    action: context.action ?? fields.action,
    entityType: context.entityType ?? fields.entityType,
    entityId: context.entityId ?? fields.entityId,
    ...fields,
    event,
    level,
  }) as Record<string, unknown>;

  if (shouldUseJsonFormat()) {
    const line = JSON.stringify(entry);
    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
    return;
  }

  const prefix = `[${entry.timestamp}] ${level.toUpperCase()} ${event}`;
  const details = { ...entry };
  delete details.timestamp;
  delete details.level;
  delete details.event;
  if (level === "error") {
    console.error(prefix, details);
  } else if (level === "warn") {
    console.warn(prefix, details);
  } else {
    console.log(prefix, details);
  }
}

export const logger = {
  debug(event: string, fields?: LogFields) {
    write("debug", event, fields);
  },
  info(event: string, fields?: LogFields) {
    write("info", event, fields);
  },
  warn(event: string, fields?: LogFields) {
    write("warn", event, fields);
  },
  error(event: string, fields?: LogFields) {
    const errorFields = fields?.error ? serializeError(fields.error) : {};
    write("error", event, { ...fields, ...errorFields });
  },
  audit(event: string, fields?: LogFields) {
    write("info", event, { ...fields, audit: true });
  },
};

export async function withActionLogging<T>(
  config: ActionLogConfig,
  callback: () => Promise<T>,
): Promise<T> {
  const requestId = config.requestId ?? getLogContext().requestId ?? createRequestId();
  const startedAt = Date.now();
  return withLogContext({ ...config, requestId }, async () => {
    logger.info(`${config.event}.start`, { ...config, result: "start" });
    try {
      const result = await callback();
      logger.audit(config.event, {
        ...config,
        durationMs: Date.now() - startedAt,
        result: "success",
      });
      return result;
    } catch (error) {
      logger.error(config.event, {
        ...config,
        durationMs: Date.now() - startedAt,
        result: "failure",
        error,
      });
      throw error;
    }
  });
}

export async function withScriptLogging<T>(
  scriptName: string,
  callback: () => Promise<T>,
): Promise<T> {
  return withActionLogging(
    {
      event: `script.${scriptName}`,
      module: "script",
      action: scriptName,
    },
    callback,
  );
}
