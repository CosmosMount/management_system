export function isControlledPlaywrightServer() {
  if (
    process.env.NOTIFICATION_DELIVERY_DISABLED !== "true" ||
    !process.env.PLAYWRIGHT_DB_OWNERSHIP_TOKEN?.trim()
  ) {
    return false;
  }
  try {
    const databaseName = new URL(process.env.DATABASE_URL ?? "").pathname
      .slice(1)
      .split("?")[0];
    return Boolean(databaseName?.endsWith("_test"));
  } catch {
    return false;
  }
}
