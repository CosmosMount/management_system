export function getActionErrorMessage(
  error: unknown,
  fallback = "操作失败",
): string {
  if (!(error instanceof Error)) return fallback;

  const message = error.message.trim();
  if (!message) return fallback;

  const parsed = parseZodIssueMessage(message);
  if (parsed) return parsed;

  return message;
}

function parseZodIssueMessage(message: string): string | null {
  const jsonStart = message.search(/[\[{]/);
  if (jsonStart < 0) return null;

  try {
    const parsed = JSON.parse(message.slice(jsonStart)) as unknown;
    const issues = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed !== null && "issues" in parsed
        ? (parsed as { issues?: unknown }).issues
        : null;

    if (!Array.isArray(issues)) return null;

    const issueMessages = issues
      .map((issue) =>
        typeof issue === "object" && issue !== null && "message" in issue
          ? String((issue as { message?: unknown }).message ?? "")
          : "",
      )
      .filter(Boolean);

    return issueMessages.length > 0 ? issueMessages.join("；") : null;
  } catch {
    return null;
  }
}
