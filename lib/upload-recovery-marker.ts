export type FileAssetWriteVersion = {
  id: string;
  writeGeneration: string | null;
} | null;

const RECOVERY_BACKUP_MARKER = ".restore-bak-";

export function createRecoveryBackupPath(
  originalPath: string,
  expectedVersion: FileAssetWriteVersion,
  suffix: string,
): string {
  const token = Buffer.from(
    JSON.stringify({
      id: expectedVersion?.id ?? null,
      writeGeneration: expectedVersion?.writeGeneration ?? null,
    }),
  ).toString("base64url");
  return `${originalPath}${RECOVERY_BACKUP_MARKER}${token}.${suffix}`;
}

export function parseRecoveryBackupPath(artifactPath: string): {
  expectedVersion: FileAssetWriteVersion;
  originalPath: string;
} | null {
  const markerIndex = artifactPath.lastIndexOf(RECOVERY_BACKUP_MARKER);
  if (markerIndex < 0) return null;
  const encoded = artifactPath
    .slice(markerIndex + RECOVERY_BACKUP_MARKER.length)
    .split(".", 1)[0];
  if (!encoded) throw new Error("上传覆盖恢复标记缺少版本信息");
  const parsed: unknown = JSON.parse(
    Buffer.from(encoded, "base64url").toString("utf8"),
  );
  if (!isRecoveryVersionPayload(parsed)) {
    throw new Error("上传覆盖恢复标记版本信息无效");
  }
  return {
    originalPath: artifactPath.slice(0, markerIndex),
    expectedVersion:
      parsed.id === null
        ? null
        : { id: parsed.id, writeGeneration: parsed.writeGeneration },
  };
}

export function isSameFileAssetWriteVersion(
  current: FileAssetWriteVersion,
  expected: FileAssetWriteVersion,
): boolean {
  if (current === null || expected === null) return current === expected;
  return (
    current.id === expected.id &&
    current.writeGeneration === expected.writeGeneration
  );
}

function isRecoveryVersionPayload(value: unknown): value is {
  id: string | null;
  writeGeneration: string | null;
} {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    (typeof candidate.id === "string" || candidate.id === null) &&
    (typeof candidate.writeGeneration === "string" ||
      candidate.writeGeneration === null) &&
    (candidate.id !== null || candidate.writeGeneration === null)
  );
}
