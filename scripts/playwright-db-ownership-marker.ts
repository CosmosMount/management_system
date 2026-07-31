import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";
import type {
  PlaywrightDatabaseEnvironment,
  PlaywrightDatabaseOwnership,
} from "./playwright-db-safety";

const MARKER_VERSION = 1;
const OWNERSHIP_SECRET_BYTES = 32;
const OWNERSHIP_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const PLAYWRIGHT_OWNERSHIP_MARKER_MAX_BYTES = 4096;

export const PLAYWRIGHT_DB_OWNERSHIP_MARKER_ENV =
  "PLAYWRIGHT_DB_OWNERSHIP_MARKER";
export const PLAYWRIGHT_DB_OWNERSHIP_SECRET_ENV =
  "PLAYWRIGHT_DB_OWNERSHIP_SECRET";

export type PlaywrightOwnershipMarker = {
  device: number;
  inode: number;
  markerPath: string;
  secret: string;
};

export type PlaywrightMarkerMetadata = {
  kind: "directory" | "file" | "other";
  mode: number;
  nlink: number;
  size: number;
  uid: number;
};

type MarkerRecord = {
  connectionDigest: string;
  secretDigest: string;
  shadowDatabaseName: string;
  targetDatabaseName: string;
  token: string;
  version: number;
};

type MarkerDirectories = {
  root: string;
  rootStat: Stats;
  temporaryDirectory: string;
};

function currentUid(): number {
  if (typeof process.getuid !== "function") {
    throw new Error("Playwright ownership markers require POSIX uid checks");
  }
  return process.getuid();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function connectionDigest(ownership: PlaywrightDatabaseOwnership): string {
  return sha256(`${ownership.target.url}\0${ownership.shadow.url}`);
}

function markerRoot(cwd: string): string {
  return path.resolve(cwd, ".tmp", "playwright-db-ownership");
}

function expectedMarkerPath(
  cwd: string,
  ownership: PlaywrightDatabaseOwnership,
): string {
  return path.join(markerRoot(cwd), `${ownership.token}.json`);
}

function assertSecret(secret: string): void {
  if (!OWNERSHIP_SECRET_PATTERN.test(secret)) {
    throw new Error("The runner-issued Playwright ownership secret is invalid");
  }
}

function expectedRecord(
  ownership: PlaywrightDatabaseOwnership,
  secret: string,
): MarkerRecord {
  return {
    connectionDigest: connectionDigest(ownership),
    secretDigest: sha256(secret),
    shadowDatabaseName: ownership.shadow.databaseName,
    targetDatabaseName: ownership.target.databaseName,
    token: ownership.token,
    version: MARKER_VERSION,
  };
}

function safeDigestEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function metadataFor(stat: Stats): PlaywrightMarkerMetadata {
  return {
    kind: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
    mode: stat.mode & 0o777,
    nlink: stat.nlink,
    size: stat.size,
    uid: stat.uid,
  };
}

export function assertPlaywrightMarkerMetadata(
  metadata: PlaywrightMarkerMetadata,
  options: {
    exactMode: number;
    expectedKind: "directory" | "file";
    expectedUid: number;
    requireSingleLink?: boolean;
  },
): void {
  if (
    metadata.kind !== options.expectedKind ||
    metadata.mode !== options.exactMode ||
    metadata.uid !== options.expectedUid ||
    (options.requireSingleLink && metadata.nlink !== 1)
  ) {
    throw new Error("The Playwright ownership marker metadata is insecure");
  }
}

function assertSameIdentity(left: Stats, right: Stats): void {
  if (left.dev !== right.dev || left.ino !== right.ino) {
    throw new Error("The Playwright ownership marker path changed identity");
  }
}

function assertSafeOwnedParentDirectory(
  directoryPath: string,
  label: string,
): Stats {
  const stat = lstatSync(directoryPath);
  const mode = stat.mode & 0o777;
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.uid !== currentUid() ||
    (mode & 0o002) !== 0 ||
    realpathSync(directoryPath) !== directoryPath
  ) {
    throw new Error(`${label} is not a safe owned directory`);
  }
  return stat;
}

function mkdirExclusive(directoryPath: string, mode: number): boolean {
  try {
    mkdirSync(directoryPath, { mode });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

function removeEmptyCreatedDirectory(directoryPath: string, created: boolean): void {
  if (!created) return;
  try {
    rmdirSync(directoryPath);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw error;
    }
  }
}

function establishMarkerDirectories(cwd: string): {
  createdRoot: boolean;
  createdTemporaryDirectory: boolean;
  directories: MarkerDirectories;
} {
  const resolvedCwd = path.resolve(cwd);
  if (realpathSync(resolvedCwd) !== resolvedCwd) {
    throw new Error("The Playwright worktree path must not contain symlinks");
  }
  assertSafeOwnedParentDirectory(resolvedCwd, "The Playwright worktree");

  const temporaryDirectory = path.join(resolvedCwd, ".tmp");
  const createdTemporaryDirectory = mkdirExclusive(temporaryDirectory, 0o700);
  try {
    assertSafeOwnedParentDirectory(
      temporaryDirectory,
      "The Playwright temporary directory",
    );
  } catch (error) {
    removeEmptyCreatedDirectory(temporaryDirectory, createdTemporaryDirectory);
    throw error;
  }

  const root = markerRoot(resolvedCwd);
  const createdRoot = mkdirExclusive(root, 0o700);
  try {
    const rootStat = lstatSync(root);
    if (rootStat.isSymbolicLink() || realpathSync(root) !== root) {
      throw new Error("The Playwright ownership marker directory is invalid");
    }
    assertPlaywrightMarkerMetadata(metadataFor(rootStat), {
      exactMode: 0o700,
      expectedKind: "directory",
      expectedUid: currentUid(),
    });
    return {
      createdRoot,
      createdTemporaryDirectory,
      directories: { root, rootStat, temporaryDirectory },
    };
  } catch (error) {
    removeEmptyCreatedDirectory(root, createdRoot);
    removeEmptyCreatedDirectory(temporaryDirectory, createdTemporaryDirectory);
    throw error;
  }
}

function validateMarkerDirectories(cwd: string): MarkerDirectories {
  const resolvedCwd = path.resolve(cwd);
  if (realpathSync(resolvedCwd) !== resolvedCwd) {
    throw new Error("The Playwright worktree path must not contain symlinks");
  }
  assertSafeOwnedParentDirectory(resolvedCwd, "The Playwright worktree");
  const temporaryDirectory = path.join(resolvedCwd, ".tmp");
  assertSafeOwnedParentDirectory(
    temporaryDirectory,
    "The Playwright temporary directory",
  );
  const root = markerRoot(resolvedCwd);
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || realpathSync(root) !== root) {
    throw new Error("The Playwright ownership marker directory is invalid");
  }
  assertPlaywrightMarkerMetadata(metadataFor(rootStat), {
    exactMode: 0o700,
    expectedKind: "directory",
    expectedUid: currentUid(),
  });
  return { root, rootStat, temporaryDirectory };
}

function assertMarkerFile(stat: Stats): void {
  assertPlaywrightMarkerMetadata(metadataFor(stat), {
    exactMode: 0o600,
    expectedKind: "file",
    expectedUid: currentUid(),
    requireSingleLink: true,
  });
  if (stat.isSymbolicLink() || stat.size > PLAYWRIGHT_OWNERSHIP_MARKER_MAX_BYTES) {
    throw new Error("The Playwright ownership marker file is invalid");
  }
}

export function generatePlaywrightOwnershipSecret(
  randomBytes: (size: number) => Uint8Array,
): string {
  const bytes = randomBytes(OWNERSHIP_SECRET_BYTES);
  if (bytes.byteLength !== OWNERSHIP_SECRET_BYTES) {
    throw new Error("The ownership random source returned an unexpected byte count");
  }
  return Buffer.from(bytes).toString("base64url");
}

export function createPlaywrightOwnershipMarker(
  cwd: string,
  ownership: PlaywrightDatabaseOwnership,
  secret: string,
): PlaywrightOwnershipMarker {
  assertSecret(secret);
  const established = establishMarkerDirectories(cwd);
  const { directories } = established;
  const markerPath = expectedMarkerPath(cwd, ownership);
  let descriptor: number | undefined;
  let openedStat: Stats | undefined;
  try {
    descriptor = openSync(
      markerPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(descriptor, JSON.stringify(expectedRecord(ownership, secret)), {
      encoding: "utf8",
    });
    openedStat = fstatSync(descriptor);
    assertMarkerFile(openedStat);
    const pathStat = lstatSync(markerPath);
    assertMarkerFile(pathStat);
    assertSameIdentity(openedStat, pathStat);
    const currentRootStat = lstatSync(directories.root);
    assertPlaywrightMarkerMetadata(metadataFor(currentRootStat), {
      exactMode: 0o700,
      expectedKind: "directory",
      expectedUid: currentUid(),
    });
    assertSameIdentity(directories.rootStat, currentRootStat);
    return {
      device: openedStat.dev,
      inode: openedStat.ino,
      markerPath,
      secret,
    };
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        const currentPathStat = lstatSync(markerPath);
        const currentOpenedStat = openedStat ?? fstatSync(descriptor);
        if (
          currentPathStat.dev === currentOpenedStat.dev &&
          currentPathStat.ino === currentOpenedStat.ino
        ) {
          unlinkSync(markerPath);
        }
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new AggregateError(
            [error, cleanupError],
            "Playwright marker creation and rollback both failed",
          );
        }
      }
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    removeEmptyCreatedDirectory(directories.root, established.createdRoot);
    removeEmptyCreatedDirectory(
      directories.temporaryDirectory,
      established.createdTemporaryDirectory,
    );
  }
}

export function resolvePlaywrightOwnershipMarker(
  cwd: string,
  ownership: PlaywrightDatabaseOwnership,
  env: PlaywrightDatabaseEnvironment,
): PlaywrightOwnershipMarker {
  const markerPath = env.PLAYWRIGHT_DB_OWNERSHIP_MARKER?.trim();
  const secret = env.PLAYWRIGHT_DB_OWNERSHIP_SECRET?.trim();
  if (!markerPath || !secret) {
    throw new Error("The runner-issued Playwright ownership marker is required");
  }
  assertSecret(secret);
  const expectedPath = expectedMarkerPath(cwd, ownership);
  if (!path.isAbsolute(markerPath) || markerPath !== expectedPath) {
    throw new Error("The Playwright ownership marker path is invalid");
  }
  const directories = validateMarkerDirectories(cwd);
  const markerStat = lstatSync(markerPath);
  assertMarkerFile(markerStat);

  const descriptor = openSync(
    markerPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let rawRecord: string;
  let openedStat: Stats;
  try {
    openedStat = fstatSync(descriptor);
    assertMarkerFile(openedStat);
    assertSameIdentity(openedStat, markerStat);
    rawRecord = readFileSync(descriptor, "utf8");
    const afterReadStat = fstatSync(descriptor);
    assertMarkerFile(afterReadStat);
    assertSameIdentity(openedStat, afterReadStat);
    if (
      openedStat.size !== afterReadStat.size ||
      openedStat.mtimeMs !== afterReadStat.mtimeMs ||
      openedStat.ctimeMs !== afterReadStat.ctimeMs
    ) {
      throw new Error("The Playwright ownership marker changed while reading");
    }
    const currentPathStat = lstatSync(markerPath);
    assertMarkerFile(currentPathStat);
    assertSameIdentity(openedStat, currentPathStat);
    const currentRootStat = lstatSync(directories.root);
    assertPlaywrightMarkerMetadata(metadataFor(currentRootStat), {
      exactMode: 0o700,
      expectedKind: "directory",
      expectedUid: currentUid(),
    });
    assertSameIdentity(directories.rootStat, currentRootStat);
  } finally {
    closeSync(descriptor);
  }

  let record: Partial<MarkerRecord>;
  try {
    record = JSON.parse(rawRecord) as Partial<MarkerRecord>;
  } catch {
    throw new Error("The Playwright ownership marker content is invalid");
  }
  const expected = expectedRecord(ownership, secret);
  const expectedKeys = Object.keys(expected).sort();
  const recordKeys = Object.keys(record).sort();
  if (
    recordKeys.length !== expectedKeys.length ||
    !recordKeys.every((key, index) => key === expectedKeys[index]) ||
    record.version !== expected.version ||
    record.token !== expected.token ||
    record.targetDatabaseName !== expected.targetDatabaseName ||
    record.shadowDatabaseName !== expected.shadowDatabaseName ||
    typeof record.secretDigest !== "string" ||
    typeof record.connectionDigest !== "string" ||
    !safeDigestEqual(record.secretDigest, expected.secretDigest) ||
    !safeDigestEqual(record.connectionDigest, expected.connectionDigest)
  ) {
    throw new Error("The Playwright ownership marker does not match this run");
  }
  return {
    device: openedStat.dev,
    inode: openedStat.ino,
    markerPath,
    secret,
  };
}

export function removePlaywrightOwnershipMarker(
  cwd: string,
  ownership: PlaywrightDatabaseOwnership,
  env: PlaywrightDatabaseEnvironment,
  expectedMarker?: PlaywrightOwnershipMarker,
): void {
  const marker = resolvePlaywrightOwnershipMarker(cwd, ownership, env);
  if (
    expectedMarker &&
    (marker.markerPath !== expectedMarker.markerPath ||
      marker.device !== expectedMarker.device ||
      marker.inode !== expectedMarker.inode)
  ) {
    throw new Error("The Playwright ownership marker changed before removal");
  }

  const descriptor = openSync(
    marker.markerPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const openedStat = fstatSync(descriptor);
    assertMarkerFile(openedStat);
    if (openedStat.dev !== marker.device || openedStat.ino !== marker.inode) {
      throw new Error("The Playwright ownership marker changed before removal");
    }
    const pathStat = lstatSync(marker.markerPath);
    assertMarkerFile(pathStat);
    assertSameIdentity(openedStat, pathStat);
    unlinkSync(marker.markerPath);
    const unlinkedStat = fstatSync(descriptor);
    if (
      unlinkedStat.dev !== openedStat.dev ||
      unlinkedStat.ino !== openedStat.ino ||
      unlinkedStat.nlink !== 0
    ) {
      throw new Error("The Playwright ownership marker unlink was not atomic");
    }
    try {
      lstatSync(marker.markerPath);
      throw new Error("The Playwright ownership marker path was recreated");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } finally {
    closeSync(descriptor);
  }
}
