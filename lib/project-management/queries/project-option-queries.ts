import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { rankFuzzyMatches } from "@/lib/search/fuzzy-score";
import {
  normalizeSearchText,
  searchTerms,
} from "@/lib/search/normalize-search-text";
import {
  resolveActiveProjectOptionsInputSchema,
  searchActiveProjectOptionsInputSchema,
} from "@/lib/project-management/validations/project";

export type ProjectOption = { id: string; name: string; avatarPath: string | null };
export type ProjectOptionPage = { items: ProjectOption[]; nextCursor: string | null; hasMoreByQuery: boolean };

export async function listActiveProjectOptions(currentProjectId?: string | null) {
  const active = await prisma.project.findMany({ where: { status: "ACTIVE", deletedAt: null }, select: { id: true, name: true, avatarPath: true }, orderBy: [{ name: "asc" }, { id: "asc" }], take: 50 });
  if (!currentProjectId || active.some((project) => project.id === currentProjectId)) return active;
  const current = await prisma.project.findFirst({ where: { id: currentProjectId, deletedAt: null }, select: { id: true, name: true, avatarPath: true } });
  return current ? [current, ...active] : active;
}

export async function searchActiveProjectOptions(input: unknown): Promise<ProjectOptionPage> {
  const parsed = searchActiveProjectOptionsInputSchema.parse(input);
  const query = normalizeSearchText(parsed.query);
  const where: Prisma.ProjectWhereInput = { status: "ACTIVE", deletedAt: null };
  if (query) {
    const direct = await prisma.project.findMany({ where: { AND: [where, ...searchTerms(query).map((term) => ({ name: { contains: term, mode: "insensitive" as const } }))] }, select: { id: true, name: true, avatarPath: true }, orderBy: [{ name: "asc" }, { id: "asc" }], take: 501 });
    const fallback = direct.length < 50 ? await prisma.project.findMany({ where, select: { id: true, name: true, avatarPath: true }, orderBy: [{ name: "asc" }, { id: "asc" }], take: 501 }) : [];
    const candidates = [...new Map([...direct, ...fallback].map((item) => [item.id, item])).values()];
    const ranked = rankFuzzyMatches(candidates, query, (item) => [{ text: item.name, weight: 2, pinyin: true }], (left, right) => left.name.localeCompare(right.name, "zh-CN") || left.id.localeCompare(right.id));
    return { items: ranked.slice(0, parsed.limit).map(({ item }) => item), nextCursor: null, hasMoreByQuery: ranked.length > parsed.limit || direct.length === 501 || fallback.length === 501 };
  }
  const rows = await prisma.project.findMany({ where, select: { id: true, name: true, avatarPath: true }, orderBy: [{ name: "asc" }, { id: "asc" }], take: parsed.limit + 1, ...(parsed.cursor ? { cursor: { id: parsed.cursor }, skip: 1 } : {}) });
  const items = rows.slice(0, parsed.limit);
  return { items, nextCursor: rows.length > parsed.limit ? items.at(-1)?.id ?? null : null, hasMoreByQuery: false };
}

export async function resolveActiveProjectOptions(input: unknown): Promise<ProjectOption[]> {
  const parsed = resolveActiveProjectOptionsInputSchema.parse(input);
  const rows = await prisma.project.findMany({ where: { id: { in: parsed.ids }, status: "ACTIVE", deletedAt: null }, select: { id: true, name: true, avatarPath: true } });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return parsed.ids.flatMap((id) => byId.get(id) ?? []);
}

export async function searchVisibleProjectOptions(input: unknown): Promise<ProjectOptionPage> {
  const parsed = searchActiveProjectOptionsInputSchema.parse(input);
  const query = normalizeSearchText(parsed.query);
  const where: Prisma.ProjectWhereInput = { deletedAt: null };
  if (query) {
    const direct = await prisma.project.findMany({ where: { AND: [where, ...searchTerms(query).map((term) => ({ name: { contains: term, mode: "insensitive" as const } }))] }, select: { id: true, name: true, avatarPath: true }, orderBy: [{ name: "asc" }, { id: "asc" }], take: 501 });
    const fallback = direct.length < 50 ? await prisma.project.findMany({ where, select: { id: true, name: true, avatarPath: true }, orderBy: [{ name: "asc" }, { id: "asc" }], take: 501 }) : [];
    const candidates = [...new Map([...direct, ...fallback].map((item) => [item.id, item])).values()];
    const ranked = rankFuzzyMatches(candidates, query, (item) => [{ text: item.name, weight: 2, pinyin: true }], (left, right) => left.name.localeCompare(right.name, "zh-CN") || left.id.localeCompare(right.id));
    return { items: ranked.slice(0, parsed.limit).map(({ item }) => item), nextCursor: null, hasMoreByQuery: ranked.length > parsed.limit || direct.length === 501 || fallback.length === 501 };
  }
  const rows = await prisma.project.findMany({ where, select: { id: true, name: true, avatarPath: true }, orderBy: [{ name: "asc" }, { id: "asc" }], take: parsed.limit + 1, ...(parsed.cursor ? { cursor: { id: parsed.cursor }, skip: 1 } : {}) });
  const items = rows.slice(0, parsed.limit);
  return { items, nextCursor: rows.length > parsed.limit ? items.at(-1)?.id ?? null : null, hasMoreByQuery: false };
}

export async function resolveVisibleProjectOptions(input: unknown): Promise<ProjectOption[]> {
  const parsed = resolveActiveProjectOptionsInputSchema.parse(input);
  const rows = await prisma.project.findMany({ where: { id: { in: parsed.ids }, deletedAt: null }, select: { id: true, name: true, avatarPath: true } });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return parsed.ids.flatMap((id) => byId.get(id) ?? []);
}
