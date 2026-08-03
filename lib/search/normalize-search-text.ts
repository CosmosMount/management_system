export function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/gu, " ");
}

export function compactSearchText(value: string): string {
  return normalizeSearchText(value).replace(/\s+/gu, "");
}

export function searchTerms(value: string): string[] {
  const normalized = normalizeSearchText(value);
  return normalized ? normalized.split(" ").filter(Boolean) : [];
}
