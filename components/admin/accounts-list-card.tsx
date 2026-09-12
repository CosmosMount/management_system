"use client";

import Link from "next/link";
import { useState } from "react";
import { History, ShieldCheck, X } from "lucide-react";
import {
  assignAccountReimbursementRole,
  grantProjectSystemRole,
  revokeAccountReimbursementRole,
  revokeProjectSystemRole,
} from "@/app/actions/adminRoles";
import { AccountIdentity, AdminAccountSelect } from "@/components/admin/account-identity";
import type {
  AdminAccountOption,
  AdminAccountRow,
  AdminResponsibilityAssignment,
} from "@/components/admin/account-types";
import {
  accountDisplayName,
  activeProjectRoles,
  isProjectRole,
  pageHref,
  projectRoleLabels,
  reimbursementRoleLabel,
  reimbursementRoleLabels,
  responsibilityFromOption,
  roleLabel,
  systemRoleLabel,
  type AccountFiltersValue,
  type AssignableRole,
  type RunAccountMutation,
} from "@/components/admin/accounts-contract";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field-error";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TEAM_OPTIONS, TECH_GROUP_OPTIONS } from "@/lib/constants";
import { cn } from "@/lib/utils";

export function AccountsAndRolesCard({
  accounts,
  page,
  pageSize,
  total,
  hasMoreByQuery,
  filters,
  pending,
  run,
  onResponsibilityAdd,
  onResponsibilityRemove,
  onShowHistory,
}: {
  accounts: AdminAccountRow[];
  page: number;
  pageSize: number;
  total: number;
  hasMoreByQuery: boolean;
  filters: AccountFiltersValue;
  pending: boolean;
  run: RunAccountMutation;
  onResponsibilityAdd: (responsibility: AdminResponsibilityAssignment) => void;
  onResponsibilityRemove: (assignmentId: string) => void;
  onShowHistory: (accountId: string) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  return (
    <Card data-testid="accounts-and-roles-card">
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>用户与角色</CardTitle>
        <CardDescription>
          分配全局项目角色或范围报销角色，并在账号列表中直接移除当前角色。
        </CardDescription>
      </CardHeader>
      <CardContent className="min-w-0 space-y-6">
        <GeneralRoleAssignmentForm
          pending={pending}
          run={run}
          onResponsibilityAdd={onResponsibilityAdd}
        />
        <div className="space-y-4 border-t pt-5">
          <AccountFilters filters={filters} />
          {hasMoreByQuery ? (
            <p className="text-sm text-amber-700" role="status">
              匹配账号较多，当前仅在前 501 个候选中排序，请继续输入关键词缩小范围。
            </p>
          ) : null}
          {accounts.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              没有符合条件的账号。
            </div>
          ) : (
            <>
              <div className="min-w-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>用户</TableHead>
                      <TableHead>openId</TableHead>
                      <TableHead>入库时间</TableHead>
                      <TableHead>当前角色</TableHead>
                      <TableHead className="text-right">记录</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {accounts.map((account) => (
                      <TableRow key={account.id}>
                        <TableCell>
                          <AccountIdentity account={account} showOpenId={false} />
                        </TableCell>
                        <TableCell className="max-w-48 truncate font-mono text-xs">
                          {account.identities[0]?.openId ?? "缺少飞书身份"}
                        </TableCell>
                        <TableCell>
                          {new Date(account.createdAt).toLocaleString("zh-CN")}
                        </TableCell>
                        <TableCell>
                          <InlineAccountRoles
                            account={account}
                            pending={pending}
                            run={run}
                            onResponsibilityRemove={onResponsibilityRemove}
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => onShowHistory(account.id)}
                          >
                            <History className="mr-1 h-4 w-4" />查看记录
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
                <span>
                  共 {total} 个账号，第 {page}/{pageCount} 页
                </span>
                <div className="flex gap-2">
                  <Link
                    aria-disabled={page <= 1}
                    className={cn(
                      buttonVariants({ variant: "outline", size: "sm" }),
                      page <= 1 && "pointer-events-none opacity-50",
                    )}
                    href={pageHref(filters, Math.max(1, page - 1))}
                  >
                    上一页
                  </Link>
                  <Link
                    aria-disabled={page >= pageCount}
                    className={cn(
                      buttonVariants({ variant: "outline", size: "sm" }),
                      page >= pageCount && "pointer-events-none opacity-50",
                    )}
                    href={pageHref(filters, Math.min(pageCount, page + 1))}
                  >
                    下一页
                  </Link>
                </div>
              </div>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function GeneralRoleAssignmentForm({
  pending,
  run,
  onResponsibilityAdd,
}: {
  pending: boolean;
  run: RunAccountMutation;
  onResponsibilityAdd: (responsibility: AdminResponsibilityAssignment) => void;
}) {
  const [accountId, setAccountId] = useState<string | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<AdminAccountOption | null>(null);
  const [role, setRole] = useState<AssignableRole | "">("");
  const [scope, setScope] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<"account" | "role" | "scope", string>>>({});
  const teamScoped = role === "TEAM_ADMIN" || role === "FINANCE";
  const techGroupScoped = role === "TECH_GROUP_ADMIN" || role === "TEACHER";
  const reimbursementScoped = teamScoped || techGroupScoped;

  function handleAssign() {
    const nextErrors: Partial<Record<"account" | "role" | "scope", string>> = {};
    if (!accountId) nextErrors.account = "请选择用户";
    if (!role) nextErrors.role = "请选择角色";
    if ((teamScoped || techGroupScoped) && !scope) {
      nextErrors.scope = teamScoped ? "请选择车组" : "请选择技术组";
    }
    setFieldErrors(nextErrors);
    const firstError = (["account", "role", "scope"] as const).find((key) => nextErrors[key]);
    if (firstError) {
      requestAnimationFrame(() => document.getElementById(`general-role-${firstError}`)?.focus());
      return;
    }
    if (!accountId || !role) return;
    const resetRole = () => {
      setRole("");
      setScope("");
      setFieldErrors({});
    };
    if (isProjectRole(role)) {
      if (
        role === "SUPER_ADMINISTRATOR" &&
        !window.confirm(
          "确定授予超级管理员？\n\n该账号将获得报销系统、全部项目业务以及账号与权限后台的最高权限。",
        )
      ) {
        return;
      }
      run(
        () => grantProjectSystemRole({ targetAccountId: accountId, role }),
        {
          success: `${projectRoleLabels[role]}已授予`,
          unchanged: `该账号已是${projectRoleLabels[role]}`,
          afterSuccess: resetRole,
        },
      );
      return;
    }
    run(
      () =>
        assignAccountReimbursementRole({
          targetAccountId: accountId,
          role,
          team: teamScoped ? scope : undefined,
          techGroup: techGroupScoped ? scope : undefined,
        }),
      {
        success: `${reimbursementRoleLabels[role]}已授予`,
        unchanged: "该范围角色已存在",
        afterSuccess: (result) => {
          if (result.assignmentId && selectedAccount) {
            onResponsibilityAdd(
              responsibilityFromOption({
                assignmentId: result.assignmentId,
                role,
                scope,
                scopeKind: teamScoped ? "team" : "techGroup",
                account: selectedAccount,
              }),
            );
          }
          resetRole();
        },
      },
    );
  }

  return (
    <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(12rem,1fr)_11rem_10rem_auto] sm:items-end">
      <label className="min-w-0 space-y-2">
        <span className="block text-sm font-medium">用户</span>
        <AdminAccountSelect
          purpose={reimbursementScoped ? "REIMBURSEMENT" : "ALL"}
          value={accountId}
          onValueChange={(value) => { setAccountId(value); if (value) setFieldErrors((current) => ({ ...current, account: undefined })); }}
          onOptionChange={setSelectedAccount}
          ariaLabel="选择要配置角色的用户"
          disabled={pending}
          inputId="general-role-account"
          invalid={Boolean(fieldErrors.account)}
          ariaDescribedBy={fieldErrors.account ? "general-role-account-error" : undefined}
        />
        <FieldError id="general-role-account-error" messages={fieldErrors.account} />
      </label>
      <label className="min-w-0 space-y-2">
        <span className="block text-sm font-medium">角色</span>
        <Select
          value={role}
          onValueChange={(value) => {
            const nextRole = (value as AssignableRole | null) ?? "";
            const nextNeedsReimbursement =
              nextRole === "TEAM_ADMIN" ||
              nextRole === "FINANCE" ||
              nextRole === "TECH_GROUP_ADMIN" ||
              nextRole === "TEACHER";
            if (
              nextNeedsReimbursement &&
              selectedAccount &&
              !selectedAccount.reimbursementReady
            ) {
              setAccountId(null);
              setSelectedAccount(null);
              setFieldErrors((current) => ({
                ...current,
                account: "该账号缺少报销用户资料，请重新选择已同步账号",
              }));
            }
            setRole(nextRole);
            setScope("");
            setFieldErrors((current) => ({ ...current, role: undefined, scope: undefined }));
          }}
          disabled={pending}
        >
          <SelectTrigger id="general-role-role" className="w-full" aria-label="选择角色" aria-invalid={Boolean(fieldErrors.role)} aria-describedby={fieldErrors.role ? "general-role-role-error" : undefined}>
            <SelectValue>
              {(value) => roleLabel(String(value ?? "")) || "选择角色"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="SUPER_ADMINISTRATOR">超级管理员</SelectItem>
            <SelectItem value="PROJECT_ADMINISTRATOR">项目管理员</SelectItem>
            <SelectItem value="TEAM_ADMIN">报销车组组长</SelectItem>
            <SelectItem value="FINANCE">报销员</SelectItem>
            <SelectItem value="TECH_GROUP_ADMIN">报销技术组组长</SelectItem>
            <SelectItem value="TEACHER">指导老师</SelectItem>
          </SelectContent>
        </Select>
        <FieldError id="general-role-role-error" messages={fieldErrors.role} />
      </label>
      <RoleScopeSelect
        role={role}
        scope={scope}
        onScopeChange={(value) => { setScope(value); if (value) setFieldErrors((current) => ({ ...current, scope: undefined })); }}
        disabled={pending}
        error={fieldErrors.scope}
      />
      <Button
        type="button"
        className="w-full sm:w-auto"
        disabled={pending}
        onClick={handleAssign}
      >
        <ShieldCheck className="mr-1 h-4 w-4" />添加
      </Button>
    </div>
  );
}

function RoleScopeSelect({
  role,
  scope,
  onScopeChange,
  disabled,
  error,
}: {
  role: AssignableRole | "";
  scope: string;
  onScopeChange: (value: string) => void;
  disabled: boolean;
  error?: string;
}) {
  const teamScoped = role === "TEAM_ADMIN" || role === "FINANCE";
  const techGroupScoped = role === "TECH_GROUP_ADMIN" || role === "TEACHER";
  if (!teamScoped && !techGroupScoped) {
    return <div className="h-[3.25rem]" aria-hidden="true" />;
  }
  const options = teamScoped ? TEAM_OPTIONS : TECH_GROUP_OPTIONS;
  const label = teamScoped ? "车组" : "技术组";
  return (
    <label className="min-w-0 space-y-2">
      <span className="block text-sm font-medium">{label}</span>
      <Select
        value={scope}
        onValueChange={(value) => onScopeChange(value ?? "")}
        disabled={disabled}
      >
        <SelectTrigger id="general-role-scope" className="w-full" aria-label={`选择${label}`} aria-invalid={Boolean(error)} aria-describedby={error ? "general-role-scope-error" : undefined}>
          <SelectValue>
            {(value) => (value ? String(value) : `选择${label}`)}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldError id="general-role-scope-error" messages={error} />
    </label>
  );
}

function InlineAccountRoles({
  account,
  pending,
  run,
  onResponsibilityRemove,
}: {
  account: AdminAccountRow;
  pending: boolean;
  run: RunAccountMutation;
  onResponsibilityRemove: (assignmentId: string) => void;
}) {
  const projectRoles = account.systemRoles.filter(
    (assignment) => !assignment.revokedAt && activeProjectRoles.has(assignment.role),
  );
  const reimbursementRoles = account.reimbursementRoles.filter(
    (assignment) => !assignment.revokedAt && assignment.role !== "SUPER_ADMIN",
  );
  if (projectRoles.length === 0 && reimbursementRoles.length === 0) {
    return <span className="text-sm text-muted-foreground">无</span>;
  }
  return (
    <div className="flex min-w-0 flex-wrap gap-1">
      {projectRoles.map((assignment) => (
        <Badge key={assignment.id} variant="secondary" className="max-w-full gap-1">
          <span className="truncate">{systemRoleLabel(assignment)}</span>
          <button
            type="button"
            className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`撤销 ${accountDisplayName(account)} 的 ${systemRoleLabel(assignment)} 角色`}
            disabled={pending}
            onClick={() => {
              const impact =
                assignment.role === "SUPER_ADMINISTRATOR"
                  ? "撤销后，该账号将失去报销、项目和账号权限后台的最高权限。系统会阻止自撤销和撤销最后一名超级管理员。"
                  : "撤销后，该账号将立即失去项目全局管理与审批权限，已有 Task 成员权限不受影响。";
              if (
                window.confirm(
                  `确定撤销“${systemRoleLabel(assignment)}”？\n\n${impact}`,
                )
              ) {
                run(
                  () => revokeProjectSystemRole({ assignmentId: assignment.id }),
                  {
                    success: "项目角色已撤销",
                    unchanged: "该项目角色已被撤销",
                  },
                );
              }
            }}
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}
      {reimbursementRoles.map((assignment) => (
        <Badge key={assignment.id} variant="outline" className="max-w-full gap-1">
          <span className="truncate">{reimbursementRoleLabel(assignment)}</span>
          <button
            type="button"
            className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`移除 ${accountDisplayName(account)} 的 ${reimbursementRoleLabel(assignment)} 角色`}
            disabled={pending}
            onClick={() =>
              run(
                () =>
                  revokeAccountReimbursementRole({ assignmentId: assignment.id }),
                {
                  success: "报销角色已移除",
                  unchanged: "该报销角色已被移除",
                  afterSuccess: (result) =>
                    onResponsibilityRemove(
                      result.assignmentId ?? assignment.id,
                    ),
                },
              )
            }
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}
    </div>
  );
}

function AccountFilters({ filters }: { filters: AccountFiltersValue }) {
  return (
    <form className="grid min-w-0 gap-3 lg:grid-cols-[minmax(12rem,1fr)_11rem_9rem_9rem_auto]">
      <Input
        name="q"
        defaultValue={filters.query}
        placeholder="搜索姓名或飞书 ID"
        aria-label="搜索账号"
      />
      <select
        name="role"
        defaultValue={filters.role}
        aria-label="角色类型"
        className="h-8 min-w-0 rounded-lg border border-input bg-background px-2 text-sm"
      >
        <option value="">全部角色</option>
        <option value="SUPER_ADMINISTRATOR">超级管理员</option>
        <option value="PROJECT_ADMINISTRATOR">项目管理员</option>
        <option value="ORDINARY">普通成员</option>
        <option value="TEAM_ADMIN">报销车组组长</option>
        <option value="TECH_GROUP_ADMIN">报销技术组组长</option>
        <option value="TEACHER">指导老师</option>
        <option value="FINANCE">报销员</option>
      </select>
      <select
        name="team"
        defaultValue={filters.team}
        aria-label="车组"
        className="h-8 min-w-0 rounded-lg border border-input bg-background px-2 text-sm"
      >
        <option value="">全部车组</option>
        {TEAM_OPTIONS.map((item) => (
          <option key={item}>{item}</option>
        ))}
      </select>
      <select
        name="techGroup"
        defaultValue={filters.techGroup}
        aria-label="技术组"
        className="h-8 min-w-0 rounded-lg border border-input bg-background px-2 text-sm"
      >
        <option value="">全部技术组</option>
        {TECH_GROUP_OPTIONS.map((item) => (
          <option key={item}>{item}</option>
        ))}
      </select>
      <div className="flex gap-2">
        <Button type="submit">筛选</Button>
        <Link
          href="/admin/accounts"
          className={cn(buttonVariants({ variant: "outline" }))}
        >
          重置
        </Link>
      </div>
    </form>
  );
}
