const configuredVersion = process.env.NEXT_PUBLIC_FRONTEND_VERSION;

export const FRONTEND_VERSION = configuredVersion && /^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(configuredVersion)
  ? configuredVersion
  : "2026.09.12.0";
export const FRONTEND_VERSION_QUERY = "__frontend_version";
export const FRONTEND_RELOAD_STORAGE_KEY = "pnx:frontend-reload-at";

export function isFrontendVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && value.trim() === value && /^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(value);
}

export function frontendReloadUrl(href: string, version: string) {
  const url = new URL(href);
  url.searchParams.set(FRONTEND_VERSION_QUERY, version);
  return url.toString();
}

export function frontendReloadBlocked(href: string, version: string, lastReloadAt: string | null, nowMs: number) {
  if (new URL(href).searchParams.get(FRONTEND_VERSION_QUERY) === version) return true;
  const previous = lastReloadAt === null ? Number.NaN : Number(lastReloadAt);
  return Number.isFinite(previous) && nowMs - previous < 60_000;
}
