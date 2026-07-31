import type pg from "pg";

const POSTGRES_PROTOCOLS = new Set(["postgresql:", "postgres:"]);
const LOCAL_POSTGRES_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
]);
const ALLOWED_DATABASE_URL_QUERY_PARAMETERS = new Set(["schema", "sslmode"]);
const SAFE_TEST_DATABASE_NAME = /^[A-Za-z0-9_]+_test$/;
const POSTGRES_IDENTIFIER_MAX_BYTES = 63;
const OWNERSHIP_TOKEN_BYTES = 12;
const OWNERSHIP_TOKEN_PATTERN = /^[a-f0-9]{24}$/;

export const PLAYWRIGHT_DB_OWNERSHIP_TOKEN_ENV =
  "PLAYWRIGHT_DB_OWNERSHIP_TOKEN";

export type PlaywrightDatabaseEndpoint = {
  databaseName: string;
  hostname: string;
  port: string;
  protocol: string;
  url: string;
  username: string;
};

export type PlaywrightDatabaseOwnership = {
  shadow: PlaywrightDatabaseEndpoint;
  target: PlaywrightDatabaseEndpoint;
  token: string;
};

export type PlaywrightDatabaseEnvironment = {
  [key: string]: string | undefined;
  DATABASE_URL?: string;
  PLAYWRIGHT_CONFIRM_RECREATE_DB?: string;
  PLAYWRIGHT_CONFIRM_RECREATE_SHADOW_DB?: string;
  PLAYWRIGHT_DATABASE_URL?: string;
  PLAYWRIGHT_DB_OWNERSHIP_MARKER?: string;
  PLAYWRIGHT_DB_OWNERSHIP_SECRET?: string;
  PLAYWRIGHT_DB_OWNERSHIP_TOKEN?: string;
  PLAYWRIGHT_DB_SETUP_MODE?: string;
  PLAYWRIGHT_SHADOW_DATABASE_URL?: string;
  PLAYWRIGHT_SOURCE_DATABASE_URL?: string;
  SHADOW_DATABASE_URL?: string;
};

type ParsedDatabaseEndpoint = PlaywrightDatabaseEndpoint & {
  connectionOptions: string;
  password: string;
};

function decodeUrlComponent(value: string, label: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`${label} contains invalid URL encoding`);
  }
}

function parsePostgresUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid PostgreSQL URL`);
  }

  if (!POSTGRES_PROTOCOLS.has(url.protocol)) {
    throw new Error(`${label} must use the postgres: or postgresql: protocol`);
  }
  if (url.hash) {
    throw new Error(`${label} must not include a URL fragment`);
  }
  for (const queryParameter of url.searchParams.keys()) {
    if (!ALLOWED_DATABASE_URL_QUERY_PARAMETERS.has(queryParameter)) {
      throw new Error(`${label} contains an unsupported query parameter`);
    }
  }

  const hostname = url.hostname.toLowerCase();
  if (!LOCAL_POSTGRES_HOSTS.has(hostname)) {
    throw new Error(
      `${label} must point to localhost, 127.0.0.1, or the IPv6 loopback address`,
    );
  }

  const username = decodeUrlComponent(url.username, `${label} username`);
  if (!username) {
    throw new Error(`${label} must include a PostgreSQL username`);
  }
  decodeUrlComponent(url.password, `${label} password`);

  return url;
}

function parsePlaywrightDatabaseUrl(
  value: string,
  label: string,
): ParsedDatabaseEndpoint {
  const url = parsePostgresUrl(value, label);
  const encodedDatabaseName = url.pathname.replace(/^\//, "");
  if (!encodedDatabaseName || encodedDatabaseName.includes("/")) {
    throw new Error(`${label} must include exactly one database name`);
  }
  const databaseName = decodeUrlComponent(
    encodedDatabaseName,
    `${label} database name`,
  );
  if (!SAFE_TEST_DATABASE_NAME.test(databaseName)) {
    throw new Error(
      `${label} database name must contain only letters, digits, underscores and end with _test`,
    );
  }
  if (Buffer.byteLength(databaseName, "utf8") > POSTGRES_IDENTIFIER_MAX_BYTES) {
    throw new Error(
      `${label} database name must be at most ${POSTGRES_IDENTIFIER_MAX_BYTES} bytes`,
    );
  }

  return {
    connectionOptions: url.search,
    databaseName,
    hostname: url.hostname.toLowerCase(),
    password: decodeUrlComponent(url.password, `${label} password`),
    port: url.port || "5432",
    protocol: url.protocol,
    url: url.toString(),
    username: decodeUrlComponent(url.username, `${label} username`),
  };
}

function omitPrivateConnectionFields(
  endpoint: ParsedDatabaseEndpoint,
): PlaywrightDatabaseEndpoint {
  return {
    databaseName: endpoint.databaseName,
    hostname: endpoint.hostname,
    port: endpoint.port,
    protocol: endpoint.protocol,
    url: endpoint.url,
    username: endpoint.username,
  };
}

function assertOwnershipToken(token: string): void {
  if (!OWNERSHIP_TOKEN_PATTERN.test(token)) {
    throw new Error(
      `${PLAYWRIGHT_DB_OWNERSHIP_TOKEN_ENV} must be a runner-issued 24-character lowercase hexadecimal token`,
    );
  }
}

export function generatePlaywrightDatabaseOwnershipToken(
  randomBytes: (size: number) => Uint8Array,
): string {
  const bytes = randomBytes(OWNERSHIP_TOKEN_BYTES);
  if (bytes.byteLength !== OWNERSHIP_TOKEN_BYTES) {
    throw new Error("The ownership random source returned an unexpected byte count");
  }
  return Buffer.from(bytes).toString("hex");
}

export function playwrightDatabaseNamesForToken(token: string): {
  shadow: string;
  target: string;
} {
  assertOwnershipToken(token);
  const names = {
    shadow: `pw_${token}_shadow_test`,
    target: `pw_${token}_target_test`,
  };
  for (const databaseName of Object.values(names)) {
    if (Buffer.byteLength(databaseName, "utf8") > POSTGRES_IDENTIFIER_MAX_BYTES) {
      throw new Error("Runner-issued Playwright database name is too long");
    }
  }
  return names;
}

export function createPlaywrightDatabaseOwnership(
  credentialSourceUrl: string,
  token: string,
): PlaywrightDatabaseOwnership {
  const credentialSource = parsePostgresUrl(
    credentialSourceUrl,
    "PLAYWRIGHT_DATABASE_URL credential source",
  );
  const names = playwrightDatabaseNamesForToken(token);
  const targetUrl = new URL(credentialSource.toString());
  const shadowUrl = new URL(credentialSource.toString());
  targetUrl.pathname = `/${names.target}`;
  shadowUrl.pathname = `/${names.shadow}`;

  return resolvePlaywrightDatabaseOwnership({
    PLAYWRIGHT_DATABASE_URL: targetUrl.toString(),
    PLAYWRIGHT_DB_OWNERSHIP_TOKEN: token,
    PLAYWRIGHT_SHADOW_DATABASE_URL: shadowUrl.toString(),
  });
}

export function resolvePlaywrightDatabaseOwnership(
  env: PlaywrightDatabaseEnvironment,
): PlaywrightDatabaseOwnership {
  const token = env.PLAYWRIGHT_DB_OWNERSHIP_TOKEN?.trim();
  if (!token) {
    throw new Error(`${PLAYWRIGHT_DB_OWNERSHIP_TOKEN_ENV} is required`);
  }
  assertOwnershipToken(token);

  const targetDatabaseUrl = env.PLAYWRIGHT_DATABASE_URL?.trim();
  const shadowDatabaseUrl = env.PLAYWRIGHT_SHADOW_DATABASE_URL?.trim();
  if (!targetDatabaseUrl) {
    throw new Error("PLAYWRIGHT_DATABASE_URL is required");
  }
  if (!shadowDatabaseUrl) {
    throw new Error("PLAYWRIGHT_SHADOW_DATABASE_URL is required");
  }

  const target = parsePlaywrightDatabaseUrl(
    targetDatabaseUrl,
    "PLAYWRIGHT_DATABASE_URL",
  );
  const shadow = parsePlaywrightDatabaseUrl(
    shadowDatabaseUrl,
    "PLAYWRIGHT_SHADOW_DATABASE_URL",
  );
  const expectedNames = playwrightDatabaseNamesForToken(token);
  if (
    target.databaseName !== expectedNames.target ||
    shadow.databaseName !== expectedNames.shadow
  ) {
    throw new Error(
      "Playwright target and shadow database names do not encode the runner-issued ownership token",
    );
  }

  const sameServerUserAndOptions =
    target.protocol === shadow.protocol &&
    target.hostname === shadow.hostname &&
    target.port === shadow.port &&
    target.username === shadow.username &&
    target.password === shadow.password &&
    target.connectionOptions === shadow.connectionOptions;
  if (!sameServerUserAndOptions) {
    throw new Error(
      "Playwright target and shadow URLs must use the same local PostgreSQL protocol, authority, credentials, and connection options",
    );
  }

  return {
    shadow: omitPrivateConnectionFields(shadow),
    target: omitPrivateConnectionFields(target),
    token,
  };
}

export function assertPlaywrightDatabaseConfirmations(
  ownership: PlaywrightDatabaseOwnership,
  env: PlaywrightDatabaseEnvironment,
): void {
  if (
    env.PLAYWRIGHT_CONFIRM_RECREATE_DB !== ownership.target.databaseName ||
    env.PLAYWRIGHT_CONFIRM_RECREATE_SHADOW_DB !==
      ownership.shadow.databaseName
  ) {
    throw new Error(
      "Exact Playwright target and shadow database confirmations are required",
    );
  }
}

export function assertPlaywrightRecreateOnlyEnvironment(
  env: PlaywrightDatabaseEnvironment,
): void {
  if (env.PLAYWRIGHT_DB_SETUP_MODE !== "recreate") {
    throw new Error("PLAYWRIGHT_DB_SETUP_MODE must be recreate");
  }
  if (env.PLAYWRIGHT_SOURCE_DATABASE_URL?.trim()) {
    throw new Error("Playwright source database cloning is disabled");
  }
}

export function assertPlaywrightDatabaseOutputs(
  ownership: PlaywrightDatabaseOwnership,
  env: PlaywrightDatabaseEnvironment,
): void {
  if (
    env.DATABASE_URL !== ownership.target.url ||
    env.SHADOW_DATABASE_URL !== ownership.shadow.url
  ) {
    throw new Error(
      "DATABASE_URL and SHADOW_DATABASE_URL must be the validated runner-owned Playwright pair",
    );
  }
}

export function maintenanceDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}

export async function assertPlaywrightMaintenanceConnection(
  client: pg.Client,
  endpoint: PlaywrightDatabaseEndpoint,
): Promise<void> {
  const result = await client.query<{
    current_database: string;
    current_user: string;
    server_address: string | null;
    server_port: number;
  }>(
    `
      SELECT
        current_database(),
        current_user,
        inet_server_addr()::text AS server_address,
        inet_server_port() AS server_port
    `,
  );
  const identity = result.rows[0];
  if (!identity) {
    throw new Error("Unable to verify Playwright PostgreSQL server identity");
  }
  // Docker port forwarding legitimately reports the container-side address and port.
  // The URL authority was already constrained to a loopback TCP endpoint before connect.
  if (!identity.server_address || !identity.server_port) {
    throw new Error("Playwright PostgreSQL connection must use TCP");
  }
  if (identity.current_user !== endpoint.username) {
    throw new Error("Playwright PostgreSQL current user does not match the validated URL");
  }
  if (identity.current_database !== "postgres") {
    throw new Error("Playwright database maintenance connection must use postgres");
  }
}
