"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PickerLoadOptions,
  PickerOption,
  PickerPage,
  PickerResolveOptions,
} from "@/components/entity-picker/picker-types";

type CachedPage<TOption extends PickerOption> = PickerPage<TOption>;

export function useAsyncPickerOptions<TOption extends PickerOption>({
  scopeKey,
  initialOptions,
  selectedIds,
  open,
  query,
  loadOptions,
  resolveOptions,
}: {
  scopeKey: string;
  initialOptions: TOption[];
  selectedIds: string[];
  open: boolean;
  query: string;
  loadOptions: PickerLoadOptions<TOption>;
  resolveOptions: PickerResolveOptions<TOption>;
}) {
  const [items, setItems] = useState(initialOptions);
  const [resolvedCacheKey, setResolvedCacheKey] = useState(
    () => `${scopeKey}\u0000`,
  );
  const [optionCache, setOptionCache] = useState(
    () => new Map(initialOptions.map((option) => [option.id, option])),
  );
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMoreByQuery, setHasMoreByQuery] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [retryVersion, setRetryVersion] = useState(0);
  const queryCache = useRef(new Map<string, CachedPage<TOption>>());
  const requestSequence = useRef(0);
  const paginationSequence = useRef(0);
  const paginationInFlight = useRef<number | null>(null);
  const resolveScopeVersion = useRef(0);
  const attemptedResolutionIds = useRef(new Set<string>());
  const previousScope = useRef(scopeKey);

  const mergeIntoOptionCache = useCallback((options: TOption[]) => {
    if (options.length === 0) return;
    setOptionCache((current) => {
      const next = new Map(current);
      let changed = false;
      for (const option of options) {
        if (next.get(option.id) === option) continue;
        next.set(option.id, option);
        changed = true;
      }
      return changed ? next : current;
    });
  }, []);

  useEffect(() => {
    if (previousScope.current !== scopeKey) {
      previousScope.current = scopeKey;
      queryCache.current.clear();
      requestSequence.current += 1;
      paginationSequence.current += 1;
      paginationInFlight.current = null;
      resolveScopeVersion.current += 1;
      attemptedResolutionIds.current.clear();
      setItems(initialOptions);
      setResolvedCacheKey(`${scopeKey}\u0000`);
      setOptionCache(new Map(initialOptions.map((option) => [option.id, option])));
      setNextCursor(null);
      setHasMoreByQuery(false);
      window.setTimeout(() => setLoadingMore(false), 0);
      setError("");
      return;
    }
    setItems((current) => mergeById(current, initialOptions));
    mergeIntoOptionCache(initialOptions);
  }, [initialOptions, mergeIntoOptionCache, scopeKey]);

  useEffect(() => {
    const missing = selectedIds.filter(
      (id) =>
        !optionCache.has(id) && !attemptedResolutionIds.current.has(id),
    );
    if (missing.length === 0) return;
    const batches: string[][] = [];
    for (let index = 0; index < missing.length; index += 50) {
      batches.push(missing.slice(index, index + 50));
    }
    for (const id of missing) attemptedResolutionIds.current.add(id);
    const scopeVersion = resolveScopeVersion.current;
    for (const requested of batches) {
      void resolveOptions(requested)
        .then((resolved) => {
          if (scopeVersion !== resolveScopeVersion.current) return;
          mergeIntoOptionCache(resolved);
        })
        .catch(() => {
          if (scopeVersion !== resolveScopeVersion.current) return;
          for (const id of requested) attemptedResolutionIds.current.delete(id);
          // Selection recovery is best-effort. The field renders a safe generic
          // placeholder and never exposes the opaque ID when recovery fails.
        });
    }
  }, [mergeIntoOptionCache, optionCache, resolveOptions, selectedIds]);

  useEffect(() => {
    if (!open) {
      requestSequence.current += 1;
      paginationSequence.current += 1;
      paginationInFlight.current = null;
      window.setTimeout(() => setLoadingMore(false), 0);
      return;
    }
    const normalizedQuery = query.normalize("NFKC").trim().toLocaleLowerCase();
    const cacheKey = `${scopeKey}\u0000${normalizedQuery}`;
    const sequence = ++requestSequence.current;
    paginationSequence.current += 1;
    paginationInFlight.current = null;
    window.setTimeout(() => setLoadingMore(false), 0);
    const cached = queryCache.current.get(cacheKey);
    if (cached) {
      setItems(cached.items);
      setResolvedCacheKey(cacheKey);
      setNextCursor(cached.nextCursor);
      setHasMoreByQuery(Boolean(cached.hasMoreByQuery));
      mergeIntoOptionCache(cached.items);
      setLoading(false);
      setError("");
      return;
    }

    const timer = window.setTimeout(() => {
      setLoading(true);
      setError("");
      void loadOptions({ query: normalizedQuery })
        .then((page) => {
          if (sequence !== requestSequence.current) return;
          queryCache.current.set(cacheKey, page);
          setItems(page.items);
          setResolvedCacheKey(cacheKey);
          setNextCursor(page.nextCursor);
          setHasMoreByQuery(Boolean(page.hasMoreByQuery));
          mergeIntoOptionCache(page.items);
        })
        .catch((loadError: unknown) => {
          if (sequence !== requestSequence.current) return;
          setResolvedCacheKey(cacheKey);
          setError(
            loadError instanceof Error
              ? loadError.message
              : "选项加载失败，请稍后重试。",
          );
        })
        .finally(() => {
          if (sequence === requestSequence.current) setLoading(false);
        });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    loadOptions,
    mergeIntoOptionCache,
    open,
    query,
    retryVersion,
    scopeKey,
  ]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore || paginationInFlight.current !== null) return;
    const normalizedQuery = query.normalize("NFKC").trim().toLocaleLowerCase();
    const sequence = ++paginationSequence.current;
    paginationInFlight.current = sequence;
    setLoadingMore(true);
    setError("");
    try {
      const page = await loadOptions({ query: normalizedQuery, cursor: nextCursor });
      if (sequence !== paginationSequence.current) return;
      const mergedItems = mergeById(items, page.items);
      setItems(mergedItems);
      setNextCursor(page.nextCursor);
      setHasMoreByQuery(Boolean(page.hasMoreByQuery));
      mergeIntoOptionCache(page.items);
      queryCache.current.set(`${scopeKey}\u0000${normalizedQuery}`, {
        ...page,
        items: mergedItems,
      });
    } catch (loadError) {
      if (sequence !== paginationSequence.current) return;
      setError(
        loadError instanceof Error
          ? loadError.message
          : "更多选项加载失败，请稍后重试。",
      );
    } finally {
      if (paginationInFlight.current === sequence) {
        paginationInFlight.current = null;
        setLoadingMore(false);
      }
    }
  }, [
    items,
    loadOptions,
    loadingMore,
    mergeIntoOptionCache,
    nextCursor,
    query,
    scopeKey,
  ]);

  return useMemo(
    () => {
      const normalizedQuery = query
        .normalize("NFKC")
        .trim()
        .toLocaleLowerCase();
      const waitingForQuery =
        open && resolvedCacheKey !== `${scopeKey}\u0000${normalizedQuery}`;
      return {
        items: waitingForQuery ? [] : items,
        optionCache,
        nextCursor,
        hasMoreByQuery,
        loading: loading || waitingForQuery,
        loadingMore,
        error,
        retry: () => setRetryVersion((current) => current + 1),
        loadMore,
      };
    },
    [
      error,
      hasMoreByQuery,
      items,
      loadMore,
      loading,
      loadingMore,
      nextCursor,
      open,
      optionCache,
      query,
      resolvedCacheKey,
      scopeKey,
    ],
  );
}

function mergeById<TOption extends PickerOption>(
  first: TOption[],
  second: TOption[],
) {
  const merged = new Map(first.map((option) => [option.id, option]));
  for (const option of second) merged.set(option.id, option);
  return [...merged.values()];
}
