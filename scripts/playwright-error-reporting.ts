import { logger } from "../lib/logger";

export function flattenPlaywrightErrorCauses(
  error: unknown,
  maximumCauses = 32,
): unknown[] {
  const leaves: unknown[] = [];
  const seen = new Set<unknown>();
  const visit = (cause: unknown): void => {
    if (leaves.length >= maximumCauses) return;
    if (seen.has(cause)) {
      leaves.push(new Error("Circular Playwright error cause"));
      return;
    }
    if (cause && typeof cause === "object") seen.add(cause);
    if (cause instanceof AggregateError && cause.errors.length > 0) {
      for (const nestedCause of cause.errors) visit(nestedCause);
      return;
    }
    leaves.push(cause);
  };
  visit(error);
  return leaves.length > 0 ? leaves : [error];
}

export function logPlaywrightErrorCauses(
  event: string,
  error: unknown,
  fields: Record<string, unknown>,
): void {
  flattenPlaywrightErrorCauses(error).forEach((cause, causeIndex) => {
    logger.error(event, {
      ...fields,
      causeIndex,
      error: cause,
    });
  });
}
