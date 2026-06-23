"use client";

import { X } from "lucide-react";
import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type UserOption = {
  openId: string;
  name: string;
  avatar?: string | null;
};

type Props = {
  users: UserOption[];
  value: string;
  onChange: (openId: string) => void;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  disabled?: boolean;
};

type MultiProps = {
  users: UserOption[];
  value: string[];
  onChange: (openIds: string[]) => void;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  disabled?: boolean;
};

const PINYIN_BOUNDARIES = [
  ["a", "阿"],
  ["b", "八"],
  ["c", "嚓"],
  ["d", "哒"],
  ["e", "妸"],
  ["f", "发"],
  ["g", "旮"],
  ["h", "哈"],
  ["j", "讥"],
  ["k", "咔"],
  ["l", "垃"],
  ["m", "妈"],
  ["n", "拿"],
  ["o", "噢"],
  ["p", "妑"],
  ["q", "七"],
  ["r", "呥"],
  ["s", "仨"],
  ["t", "他"],
  ["w", "哇"],
  ["x", "夕"],
  ["y", "丫"],
  ["z", "匝"],
] as const;

const pinyinCollator = new Intl.Collator("zh-Hans-CN-u-co-pinyin");

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

function getPinyinInitial(char: string): string {
  if (/^[a-z0-9]$/i.test(char)) return char.toLowerCase();
  if (!/[\u4e00-\u9fff]/.test(char)) return "";

  for (let i = PINYIN_BOUNDARIES.length - 1; i >= 0; i--) {
    const [letter, boundary] = PINYIN_BOUNDARIES[i];
    if (pinyinCollator.compare(char, boundary) >= 0) {
      return letter;
    }
  }
  return "";
}

function getNameInitials(name: string): string {
  return [...name].map(getPinyinInitial).join("");
}

function fuzzyIncludes(target: string, query: string): boolean {
  if (!query) return true;
  let targetIndex = 0;
  for (const queryChar of query) {
    targetIndex = target.indexOf(queryChar, targetIndex);
    if (targetIndex === -1) return false;
    targetIndex++;
  }
  return true;
}

function userMatchesQuery(user: UserOption, rawQuery: string): boolean {
  const query = normalizeSearchText(rawQuery);
  if (!query) return true;

  const name = normalizeSearchText(user.name);
  const openId = normalizeSearchText(user.openId);
  const initials = getNameInitials(user.name);

  return (
    name.includes(query) ||
    initials.includes(query) ||
    openId.includes(query) ||
    fuzzyIncludes(name, query) ||
    fuzzyIncludes(initials, query)
  );
}

function useUserDropdownPosition(
  open: boolean,
  rootRef: RefObject<HTMLDivElement | null>,
) {
  const [style, setStyle] = useState<CSSProperties | null>(null);

  const updatePosition = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;

    const rect = root.getBoundingClientRect();
    const viewportGap = 8;
    const preferredHeight = 224;
    const minimumHeight = 128;
    const width = Math.min(
      Math.max(rect.width, 224),
      window.innerWidth - viewportGap * 2,
    );
    const left = Math.min(
      Math.max(rect.left, viewportGap),
      window.innerWidth - width - viewportGap,
    );
    const spaceBelow = window.innerHeight - rect.bottom - viewportGap;
    const spaceAbove = rect.top - viewportGap;
    const openUp = spaceBelow < minimumHeight && spaceAbove > spaceBelow;
    const availableHeight = openUp ? spaceAbove : spaceBelow;
    const maxHeight = Math.max(
      minimumHeight,
      Math.min(preferredHeight, availableHeight),
    );

    setStyle({
      position: "fixed",
      left,
      top: openUp ? rect.top - maxHeight - 4 : rect.bottom + 4,
      width,
      maxHeight,
    });
  }, [rootRef]);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);

    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  return style;
}

export function UserSearchSelect({
  users,
  value,
  onChange,
  placeholder = "搜索姓名…",
  className,
  inputClassName,
  disabled,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const dropdownStyle = useUserDropdownPosition(open, rootRef);

  const selected = users.find((u) => u.openId === value);

  const filtered = useMemo(() => {
    if (!query.trim()) return users.slice(0, 50);
    return users.filter((u) => userMatchesQuery(u, query)).slice(0, 50);
  }, [users, query]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      if (
        rootRef.current &&
        !rootRef.current.contains(target) &&
        !dropdownRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      {selected && !open && (
        <UserAvatar
          user={selected}
          className="pointer-events-none absolute left-2 top-1/2 z-10 h-5 w-5 -translate-y-1/2 text-[10px]"
        />
      )}
      <Input
        className={cn(selected && !open && "pl-8", inputClassName)}
        disabled={disabled}
        placeholder={selected ? selected.name : placeholder}
        value={open ? query : (selected?.name ?? "")}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          setQuery(selected?.name ?? "");
          setOpen(true);
        }}
      />
      {open &&
        !disabled &&
        dropdownStyle &&
        typeof document !== "undefined" &&
        createPortal(
          <ul
            ref={dropdownRef}
            style={dropdownStyle}
            className="z-50 overflow-auto rounded-md border bg-popover py-1 text-sm shadow-md"
          >
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-muted-foreground">无匹配用户</li>
            ) : (
              filtered.map((user) => (
                <li key={user.openId}>
                  <button
                    type="button"
                    className={cn(
                      "w-full px-3 py-2 text-left hover:bg-muted",
                      user.openId === value && "bg-muted",
                    )}
                    onClick={() => {
                      onChange(user.openId);
                      setQuery("");
                      setOpen(false);
                    }}
                  >
                    <span className="flex items-center gap-2">
                      <UserAvatar user={user} />
                      <span className="truncate font-medium">{user.name}</span>
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>,
          document.body,
        )}
    </div>
  );
}

export function UserMultiSearchSelect({
  users,
  value,
  onChange,
  placeholder = "搜索姓名…",
  className,
  inputClassName,
  disabled,
}: MultiProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const dropdownStyle = useUserDropdownPosition(open, rootRef);

  const selectedUsers = value
    .map((openId) => users.find((u) => u.openId === openId))
    .filter((u): u is UserOption => !!u);
  const selectedOpenIds = useMemo(() => new Set(value), [value]);

  const filtered = useMemo(() => {
    const candidates = users.filter((u) => !selectedOpenIds.has(u.openId));
    if (!query.trim()) return candidates.slice(0, 50);
    return candidates.filter((u) => userMatchesQuery(u, query)).slice(0, 50);
  }, [query, selectedOpenIds, users]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      if (
        rootRef.current &&
        !rootRef.current.contains(target) &&
        !dropdownRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function add(openId: string) {
    if (selectedOpenIds.has(openId)) return;
    onChange([...value, openId]);
    setQuery("");
    setOpen(false);
  }

  function remove(openId: string) {
    onChange(value.filter((id) => id !== openId));
  }

  return (
    <div ref={rootRef} className={cn("relative space-y-2", className)}>
      {selectedUsers.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {selectedUsers.map((user) => (
            <span
              key={user.openId}
              className="inline-flex items-center gap-2 rounded-full border bg-background py-1 pl-1 pr-2 text-sm shadow-sm"
            >
              <UserAvatar user={user} className="h-6 w-6" />
              <span className="max-w-[10rem] truncate">{user.name}</span>
              <button
                type="button"
                className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                disabled={disabled}
                onClick={() => remove(user.openId)}
                aria-label={`移除${user.name}`}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
        </div>
      )}
      <Input
        className={inputClassName}
        disabled={disabled}
        placeholder={placeholder}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
      />
      {open &&
        !disabled &&
        dropdownStyle &&
        typeof document !== "undefined" &&
        createPortal(
          <ul
            ref={dropdownRef}
            style={dropdownStyle}
            className="z-50 overflow-auto rounded-md border bg-popover py-1 text-sm shadow-md"
          >
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-muted-foreground">无匹配用户</li>
            ) : (
              filtered.map((user) => (
                <li key={user.openId}>
                  <button
                    type="button"
                    className="w-full px-3 py-2 text-left hover:bg-muted"
                    onClick={() => add(user.openId)}
                  >
                    <span className="flex items-center gap-2">
                      <UserAvatar user={user} />
                      <span className="truncate font-medium">{user.name}</span>
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>,
          document.body,
        )}
    </div>
  );
}

function UserAvatar({
  user,
  className,
}: {
  user: UserOption;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const initial = user.name.trim().slice(0, 1) || "?";

  if (user.avatar && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={user.avatar}
        alt={user.name}
        className={cn("h-6 w-6 shrink-0 rounded-full object-cover", className)}
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <span
      className={cn(
        "flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary",
        className,
      )}
    >
      {initial}
    </span>
  );
}
