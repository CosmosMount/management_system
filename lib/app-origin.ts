const DEFAULT_APP_ORIGIN = "http://localhost:3000";

export type NotificationContext = {
  appOrigin?: string | null;
};

function splitCsv(value?: string | null): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function firstHeaderValue(value: string | null): string | null {
  return value?.split(",")[0]?.trim() || null;
}

function originFromForwardedHeaders(
  host: string | null,
  protocol: string | null,
): string | null {
  if (!host) return null;
  const normalizedProtocol = (protocol || "http").replace(/:$/, "");
  return parseAppOrigin(`${normalizedProtocol}://${host}`);
}

export function parseAppUrl(value?: string | null): URL | null {
  if (!value) return null;

  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.hostname === "0.0.0.0") return null;
    return url;
  } catch {
    return null;
  }
}

export function parseAppOrigin(value?: string | null): string | null {
  return parseAppUrl(value)?.origin ?? null;
}

export function defaultAppOrigin(): string {
  return parseAppOrigin(process.env.NEXT_PUBLIC_APP_URL) ?? DEFAULT_APP_ORIGIN;
}

export function allowedAppOrigins(): Set<string> {
  const configured = splitCsv(process.env.APP_ALLOWED_ORIGINS)
    .map(parseAppOrigin)
    .filter((origin): origin is string => Boolean(origin));

  return new Set(configured.length > 0 ? configured : [defaultAppOrigin()]);
}

function parseHostname(value?: string | null): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  const url = parseAppUrl(raw.includes("://") ? raw : `http://${raw}`);
  return url?.hostname.toLowerCase() ?? null;
}

function allowedDevHostnames(): Set<string> {
  if (process.env.NODE_ENV === "production") return new Set();
  return new Set(
    splitCsv(process.env.ALLOWED_DEV_ORIGINS)
      .map(parseHostname)
      .filter((hostname): hostname is string => Boolean(hostname)),
  );
}

export function isAllowedAppOrigin(value?: string | null): boolean {
  const url = parseAppUrl(value);
  if (!url) return false;
  if (allowedAppOrigins().has(url.origin)) return true;
  return allowedDevHostnames().has(url.hostname.toLowerCase());
}

export function resolveAppOrigin(value?: string | null): string {
  const origin = parseAppOrigin(value);
  return origin && isAllowedAppOrigin(origin) ? origin : defaultAppOrigin();
}

export function buildAppUrl(path: string, appOrigin?: string | null): string {
  const base = resolveAppOrigin(appOrigin);
  const url = new URL(path, base);

  if (url.origin !== base && !isAllowedAppOrigin(url.origin)) {
    return new URL("/", base).toString();
  }

  return url.toString();
}

export function appOriginFromHeaders(headers: Headers): string | null {
  return (
    parseAppOrigin(firstHeaderValue(headers.get("origin"))) ??
    parseAppOrigin(firstHeaderValue(headers.get("referer"))) ??
    appOriginFromHostHeaders(headers)
  );
}

export function appOriginFromHostHeaders(headers: Headers): string | null {
  return (
    originFromForwardedHeaders(
      firstHeaderValue(headers.get("x-forwarded-host")),
      firstHeaderValue(headers.get("x-forwarded-proto")),
    ) ??
    originFromForwardedHeaders(
      firstHeaderValue(headers.get("host")),
      firstHeaderValue(headers.get("x-forwarded-proto")),
    )
  );
}
