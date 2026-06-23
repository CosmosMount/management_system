"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type UserOption = {
  openId: string;
  name: string;
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
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const selected = users.find((u) => u.openId === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users.slice(0, 50);
    return users
      .filter(
        (u) =>
          u.name.toLowerCase().includes(q) ||
          u.openId.toLowerCase().includes(q),
      )
      .slice(0, 50);
  }, [users, query]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <Input
        className={inputClassName}
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
      {open && !disabled && (
        <ul className="absolute z-50 mt-1 max-h-56 w-full overflow-auto rounded-md border bg-popover py-1 text-sm shadow-md">
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
                  <span className="font-medium">{user.name}</span>
                  <span className="ml-2 truncate text-xs text-muted-foreground">
                    {user.openId}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
