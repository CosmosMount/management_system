"use client";

import Image from "next/image";
import { useCallback, useRef } from "react";
import {
  resolveAdminAccountOptionsByIds,
  searchAdminAccountOptions,
} from "@/app/actions/adminAccounts";
import type {
  AdminAccountOption,
  AdminAccountRow,
} from "@/components/admin/account-types";
import { accountDisplayName } from "@/components/admin/accounts-contract";
import { AsyncCombobox } from "@/components/entity-picker/async-combobox";
import { cn } from "@/lib/utils";

export function AdminAccountSelect({
  purpose,
  value,
  onValueChange,
  onOptionChange,
  excludeIds = [],
  ariaLabel,
  placeholder = "输入姓名或飞书 ID",
  className,
  disabled = false,
}: {
  purpose: "ALL" | "REIMBURSEMENT";
  value: string | null;
  onValueChange: (value: string | null) => void;
  onOptionChange?: (option: AdminAccountOption | null) => void;
  excludeIds?: string[];
  ariaLabel: string;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}) {
  const optionCache = useRef(new Map<string, AdminAccountOption>());
  const loadOptions = useCallback(
    async ({ query, cursor }: { query: string; cursor?: string }) => {
      const result = await searchAdminAccountOptions({
        purpose,
        query,
        cursor,
        limit: 50,
      });
      for (const option of result.items) {
        optionCache.current.set(option.id, option);
      }
      return result;
    },
    [purpose],
  );
  const resolveOptions = useCallback(
    async (ids: string[]) => {
      const options = await resolveAdminAccountOptionsByIds({ purpose, ids });
      for (const option of options) {
        optionCache.current.set(option.id, option);
      }
      return options;
    },
    [purpose],
  );

  return (
    <AsyncCombobox<AdminAccountOption>
      scopeKey={`admin-accounts:${purpose}`}
      value={value}
      onValueChange={(nextValue) => {
        onValueChange(nextValue);
        onOptionChange?.(
          nextValue ? optionCache.current.get(nextValue) ?? null : null,
        );
      }}
      loadOptions={loadOptions}
      resolveOptions={resolveOptions}
      excludeIds={excludeIds}
      ariaLabel={ariaLabel}
      placeholder={placeholder}
      disabled={disabled}
      clearable
      className={className}
      getOptionLabel={(option) => option.displayName}
      getOptionDescription={accountOptionDescription}
      renderOption={(option) => (
        <div className="flex min-w-0 items-center gap-2">
          <AccountAvatar
            name={option.displayName}
            avatar={option.avatar}
            size="small"
          />
          <span className="min-w-0">
            <span className="block truncate font-medium">
              {option.displayName}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {accountOptionDescription(option)}
            </span>
          </span>
        </div>
      )}
    />
  );
}

function accountOptionDescription(option: AdminAccountOption) {
  const identity = option.openId ?? "缺少飞书身份";
  return option.reimbursementReady
    ? identity
    : `${identity} · 缺少报销用户资料`;
}

export function AccountIdentity({
  account,
  showOpenId = true,
}: {
  account: AdminAccountRow;
  showOpenId?: boolean;
}) {
  const name = accountDisplayName(account);
  return (
    <div className="flex min-w-0 items-center gap-3">
      <AccountAvatar name={name} avatar={account.person?.avatar ?? null} />
      <div className="min-w-0">
        <p className="truncate font-medium">{name}</p>
        {showOpenId ? (
          <p className="truncate text-xs text-muted-foreground">
            {account.identities[0]?.openId ?? "缺少飞书身份"}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function AccountAvatar({
  name,
  avatar,
  size = "default",
}: {
  name: string;
  avatar: string | null;
  size?: "small" | "default";
}) {
  const pixels = size === "small" ? 28 : 36;
  const sizeClass = size === "small" ? "h-7 w-7" : "h-9 w-9";
  return avatar ? (
    <Image
      src={avatar}
      alt=""
      width={pixels}
      height={pixels}
      className={cn(sizeClass, "shrink-0 rounded-full object-cover")}
    />
  ) : (
    <span
      className={cn(
        sizeClass,
        "flex shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary",
      )}
    >
      {name.slice(0, 1)}
    </span>
  );
}
