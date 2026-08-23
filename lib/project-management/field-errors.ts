export function fieldErrorsFullyHandled(
  fieldErrors: Record<string, string[]> | undefined,
  supportedPaths: ReadonlySet<string> | readonly string[],
  normalizePath: (path: string) => string = (path) => path,
) {
  const supported = supportedPaths instanceof Set
    ? supportedPaths
    : new Set(supportedPaths);
  const paths = Object.entries(fieldErrors ?? {})
    .filter(([, messages]) => messages.some(Boolean))
    .map(([path]) => normalizePath(path));
  return paths.length > 0 && paths.every((path) => supported.has(path));
}

export function firstFieldErrorMessage(
  fieldErrors: Record<string, string[]> | undefined,
  path: string,
) {
  return fieldErrors?.[path]?.find(Boolean);
}
