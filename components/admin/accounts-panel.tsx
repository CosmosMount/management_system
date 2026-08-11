"use client";

import Image from "next/image";
import Link from "next/link";
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import { History, ShieldCheck, X } from "lucide-react";
import { toast } from "sonner";
import {
  resolveAdminAccountOptionsByIds,
  searchAdminAccountOptions,
} from "@/app/actions/adminAccounts";
import {
  assignAccountReimbursementRole,
  grantProjectSystemRole,
  revokeAccountReimbursementRole,
  revokeProjectSystemRole,
} from "@/app/actions/adminRoles";
import { updateTeacherEmail } from "@/app/actions/adminTeacherEmail";
import type {
  AdminAccountOption,
  AdminAccountRow,
  AdminResponsibilityAssignment,
} from "@/components/admin/account-types";
import { AsyncCombobox } from "@/components/entity-picker/async-combobox";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

const activeProjectRoles = new Set([
  "SUPER_ADMINISTRATOR",
  "PROJECT_ADMINISTRATOR",
]);

const projectRoleLabels: Record<string, string> = {
  SUPER_ADMINISTRATOR: "超级管理员",
  PROJECT_ADMINISTRATOR: "项目管理员",
  GROUP_LEADER: "组长",
};

const reimbursementRoleLabels: Record<string, string> = {
  TEAM_ADMIN: "报销车组组长",
  TECH_GROUP_ADMIN: "报销技术组组长",
  TEACHER: "指导老师",
  FINANCE: "报销员",
  SUPER_ADMIN: "旧超级管理员",
};

type ProjectRole = "SUPER_ADMINISTRATOR" | "PROJECT_ADMINISTRATOR";
type ReimbursementRole =
  | "TEAM_ADMIN"
  | "TECH_GROUP_ADMIN"
  | "TEACHER"
  | "FINANCE";
type AssignableRole = ProjectRole | ReimbursementRole;

type Filters = {
  query: string;
  role: string;
  team: string;
  techGroup: string;
};

type RunOptions = {
  success: string;
  unchanged?: string;
  afterSuccess?: (result: MutationResult) => void;
};

type MutationResult = {
  changed?: boolean;
  assignmentId?: string;
};

type RunMutation = (
  action: () => Promise<MutationResult | void>,
  options: RunOptions,
) => void;

export function AccountsPanel({
  accounts,
  responsibilities,
  page,
  pageSize,
  total,
  hasMoreByQuery,
  filters,
}: {
  accounts: AdminAccountRow[];
  responsibilities: AdminResponsibilityAssignment[];
  page: number;
  pageSize: number;
  total: number;
  hasMoreByQuery: boolean;
  filters: Filters;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [visibleResponsibilities, setVisibleResponsibilities] =
    useState(responsibilities);
  const [historyAccountId, setHistoryAccountId] = useState<string | null>(null);
  const historyAccount = useMemo(
    () => accounts.find((account) => account.id === historyAccountId) ?? null,
    [accounts, historyAccountId],
  );

  const showResponsibility = useCallback(
    (responsibility: AdminResponsibilityAssignment) => {
      setVisibleResponsibilities((current) => [
        ...current.filter((entry) => entry.id !== responsibility.id),
        responsibility,
      ]);
    },
    [],
  );
  const hideResponsibility = useCallback((assignmentId: string) => {
    setVisibleResponsibilities((current) =>
      current.filter((entry) => entry.id !== assignmentId),
    );
  }, []);

  const run: RunMutation = (action, options) => {
    startTransition(async () => {
      try {
        const result = await action();
        toast.success(
          result?.changed === false && options.unchanged
            ? options.unchanged
            : options.success,
        );
        options.afterSuccess?.(result ?? {});
        router.refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "操作失败，请稍后重试");
      }
    });
  };

  return (
    <div className="min-w-0 space-y-6">
      <TeamResponsibilitiesCard
        responsibilities={visibleResponsibilities}
        pending={pending}
        run={run}
        onAdd={showResponsibility}
        onRemove={hideResponsibility}
      />
      <TechGroupResponsibilitiesCard
        responsibilities={visibleResponsibilities}
        pending={pending}
        run={run}
        onAdd={showResponsibility}
        onRemove={hideResponsibility}
      />
      <AccountsAndRolesCard
        accounts={accounts}
        page={page}
        pageSize={pageSize}
        total={total}
        hasMoreByQuery={hasMoreByQuery}
        filters={filters}
        pending={pending}
        run={run}
        onResponsibilityAdd={showResponsibility}
        onResponsibilityRemove={hideResponsibility}
        onShowHistory={setHistoryAccountId}
      />
      <AccountHistoryDialog
        account={historyAccount}
        open={historyAccount !== null}
        onOpenChange={(open) => {
          if (!open) setHistoryAccountId(null);
        }}
      />
    </div>
  );
}

function TeamResponsibilitiesCard({
  responsibilities,
  pending,
  run,
  onAdd,
  onRemove,
}: ResponsibilityCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>车组职责配置</CardTitle>
        <CardDescription>
          为每个车组指定报销车组组长与报销员；用户需已同步报销资料。
        </CardDescription>
      </CardHeader>
      <CardContent className="min-w-0">
        <div className="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>车组</TableHead>
                <TableHead>报销车组组长</TableHead>
                <TableHead>报销员</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {TEAM_OPTIONS.map((team) => (
                <TableRow key={team}>
                  <TableCell className="font-medium">{team}</TableCell>
                  <TableCell>
                    <ResponsibilityCell
                      scope={team}
                      scopeKind="team"
                      role="TEAM_ADMIN"
                      entries={responsibilitiesFor(
                        responsibilities,
                        "TEAM_ADMIN",
                        team,
                      )}
                      pending={pending}
                      run={run}
                      onAdd={onAdd}
                      onRemove={onRemove}
                    />
                  </TableCell>
                  <TableCell>
                    <ResponsibilityCell
                      scope={team}
                      scopeKind="team"
                      role="FINANCE"
                      entries={responsibilitiesFor(
                        responsibilities,
                        "FINANCE",
                        team,
                      )}
                      pending={pending}
                      run={run}
                      onAdd={onAdd}
                      onRemove={onRemove}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="grid min-w-0 gap-3 md:hidden" data-testid="mobile-team-responsibilities">
          {TEAM_OPTIONS.map((team) => (
            <section key={team} className="min-w-0 space-y-4 rounded-xl border p-4">
              <h3 className="font-medium">{team}</h3>
              <MobileResponsibilityBlock
                label="报销车组组长"
                scope={team}
                scopeKind="team"
                role="TEAM_ADMIN"
                entries={responsibilitiesFor(
                  responsibilities,
                  "TEAM_ADMIN",
                  team,
                )}
                pending={pending}
                run={run}
                onAdd={onAdd}
                onRemove={onRemove}
              />
              <MobileResponsibilityBlock
                label="报销员"
                scope={team}
                scopeKind="team"
                role="FINANCE"
                entries={responsibilitiesFor(
                  responsibilities,
                  "FINANCE",
                  team,
                )}
                pending={pending}
                run={run}
                onAdd={onAdd}
                onRemove={onRemove}
              />
            </section>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function TechGroupResponsibilitiesCard({
  responsibilities,
  pending,
  run,
  onAdd,
  onRemove,
}: ResponsibilityCardProps) {
  const teacherEmailOwnerByAccount = useMemo(
    () => teacherEmailOwners(responsibilities),
    [responsibilities],
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>技术组职责配置</CardTitle>
        <CardDescription>
          为每个技术组指定报销技术组组长与指导老师；指导老师可配置审批邮箱。
        </CardDescription>
      </CardHeader>
      <CardContent className="min-w-0">
        <div className="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>技术组</TableHead>
                <TableHead>报销技术组组长</TableHead>
                <TableHead>指导老师</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {TECH_GROUP_OPTIONS.map((techGroup) => (
                <TableRow key={techGroup}>
                  <TableCell className="font-medium">{techGroup}</TableCell>
                  <TableCell>
                    <ResponsibilityCell
                      scope={techGroup}
                      scopeKind="techGroup"
                      role="TECH_GROUP_ADMIN"
                      entries={responsibilitiesFor(
                        responsibilities,
                        "TECH_GROUP_ADMIN",
                        techGroup,
                      )}
                      pending={pending}
                      run={run}
                      onAdd={onAdd}
                      onRemove={onRemove}
                    />
                  </TableCell>
                  <TableCell>
                    <ResponsibilityCell
                      scope={techGroup}
                      scopeKind="techGroup"
                      role="TEACHER"
                      entries={responsibilitiesFor(
                        responsibilities,
                        "TEACHER",
                        techGroup,
                      )}
                      pending={pending}
                      run={run}
                      onAdd={onAdd}
                      onRemove={onRemove}
                      showTeacherEmail
                      teacherEmailOwnerByAccount={teacherEmailOwnerByAccount}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="grid min-w-0 gap-3 md:hidden" data-testid="mobile-tech-responsibilities">
          {TECH_GROUP_OPTIONS.map((techGroup) => (
            <section
              key={techGroup}
              className="min-w-0 space-y-4 rounded-xl border p-4"
            >
              <h3 className="font-medium">{techGroup}</h3>
              <MobileResponsibilityBlock
                label="报销技术组组长"
                scope={techGroup}
                scopeKind="techGroup"
                role="TECH_GROUP_ADMIN"
                entries={responsibilitiesFor(
                  responsibilities,
                  "TECH_GROUP_ADMIN",
                  techGroup,
                )}
                pending={pending}
                run={run}
                onAdd={onAdd}
                onRemove={onRemove}
              />
              <MobileResponsibilityBlock
                label="指导老师"
                scope={techGroup}
                scopeKind="techGroup"
                role="TEACHER"
                entries={responsibilitiesFor(
                  responsibilities,
                  "TEACHER",
                  techGroup,
                )}
                pending={pending}
                run={run}
                onAdd={onAdd}
                onRemove={onRemove}
                showTeacherEmail
                teacherEmailOwnerByAccount={teacherEmailOwnerByAccount}
              />
            </section>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

type ResponsibilityCardProps = {
  responsibilities: AdminResponsibilityAssignment[];
  pending: boolean;
  run: RunMutation;
  onAdd: (responsibility: AdminResponsibilityAssignment) => void;
  onRemove: (assignmentId: string) => void;
};

type ResponsibilityCellProps = {
  scope: string;
  scopeKind: "team" | "techGroup";
  role: ReimbursementRole;
  entries: AdminResponsibilityAssignment[];
  pending: boolean;
  run: RunMutation;
  onAdd: (responsibility: AdminResponsibilityAssignment) => void;
  onRemove: (assignmentId: string) => void;
  showTeacherEmail?: boolean;
  teacherEmailOwnerByAccount?: Map<
    string,
    { assignmentId: string; techGroup: string }
  >;
};

function MobileResponsibilityBlock({ label, ...props }: ResponsibilityCellProps & { label: string }) {
  return (
    <div className="min-w-0 space-y-2">
      <p className="text-sm font-medium text-muted-foreground">{label}</p>
      <ResponsibilityCell {...props} />
    </div>
  );
}

function ResponsibilityCell({
  scope,
  scopeKind,
  role,
  entries,
  pending,
  run,
  onAdd,
  onRemove,
  showTeacherEmail = false,
  teacherEmailOwnerByAccount,
}: ResponsibilityCellProps) {
  const [accountId, setAccountId] = useState<string | null>(null);
  const [selectedAccount, setSelectedAccount] =
    useState<AdminAccountOption | null>(null);
  const label = reimbursementRoleLabels[role];

  function handleAdd() {
    if (!accountId) return;
    run(
      () =>
        assignAccountReimbursementRole({
          targetAccountId: accountId,
          role,
          team: scopeKind === "team" ? scope : undefined,
          techGroup: scopeKind === "techGroup" ? scope : undefined,
        }),
      {
        success: `${scope}${label}已添加`,
        unchanged: `${scope}${label}已存在`,
        afterSuccess: (result) => {
          if (result.assignmentId && selectedAccount) {
            onAdd(
              responsibilityFromOption({
                assignmentId: result.assignmentId,
                role,
                scope,
                scopeKind,
                account: selectedAccount,
              }),
            );
          }
          setAccountId(null);
          setSelectedAccount(null);
        },
      },
    );
  }

  return (
    <div className="grid min-w-0 gap-3 xl:grid-cols-[minmax(10rem,14rem)_minmax(0,1fr)] xl:items-start">
      <div className="flex min-w-0 gap-2">
        <AdminAccountSelect
          purpose="REIMBURSEMENT"
          value={accountId}
          onValueChange={setAccountId}
          onOptionChange={setSelectedAccount}
          excludeIds={entries.map((entry) => entry.account.id)}
          ariaLabel={`为${scope}选择${label}`}
          placeholder="搜索添加"
          className="min-w-0 flex-1"
          disabled={pending}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="shrink-0"
          disabled={!accountId || pending}
          aria-label={`添加${scope}${label}`}
          onClick={handleAdd}
        >
          确定
        </Button>
      </div>
      <div className="flex min-w-0 flex-wrap gap-2 xl:justify-end">
        {entries.length === 0 ? (
          <span className="py-1 text-sm text-muted-foreground">未配置</span>
        ) : (
          entries.map((entry) => (
            <div key={entry.id} className="min-w-0 space-y-1">
              <ResponsibilityChip
                entry={entry}
                pending={pending}
                onRemove={() =>
                  run(
                    () =>
                      revokeAccountReimbursementRole({
                        assignmentId: entry.id,
                      }),
                    {
                      success: `${scope}${label}已移除`,
                      unchanged: "该角色已被移除",
                      afterSuccess: (result) =>
                        onRemove(result.assignmentId ?? entry.id),
                    },
                  )
                }
              />
              {showTeacherEmail &&
              teacherEmailOwnerByAccount?.get(entry.account.id)?.assignmentId ===
                entry.id ? (
                <TeacherEmailEditor
                  accountId={entry.account.id}
                  displayName={entry.account.displayName}
                  initialEmail={entry.account.email ?? ""}
                  pending={pending}
                />
              ) : showTeacherEmail ? (
                <p className="max-w-64 break-words text-xs text-muted-foreground">
                  审批邮箱与
                  {teacherEmailOwnerByAccount?.get(entry.account.id)?.techGroup ??
                    "其他技术组"}
                  职责共用：{entry.account.email ?? "未配置"}
                </p>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ResponsibilityChip({
  entry,
  pending,
  onRemove,
}: {
  entry: AdminResponsibilityAssignment;
  pending: boolean;
  onRemove: () => void;
}) {
  return (
    <div className="inline-flex max-w-full items-center gap-2 rounded-full border bg-background py-1 pl-1 pr-2 shadow-sm">
      <AccountAvatar
        name={entry.account.displayName}
        avatar={entry.account.avatar}
        size="small"
      />
      <span className="max-w-32 truncate text-sm">{entry.account.displayName}</span>
      <button
        type="button"
        className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`移除 ${entry.account.displayName} 的 ${reimbursementRoleLabel(entry)}`}
        disabled={pending}
        onClick={onRemove}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function TeacherEmailEditor({
  accountId,
  displayName,
  initialEmail,
  pending,
}: {
  accountId: string;
  displayName: string;
  initialEmail: string;
  pending: boolean;
}) {
  const router = useRouter();
  const [email, setEmail] = useState(initialEmail);
  const [saving, startSaving] = useTransition();

  function handleSave() {
    startSaving(async () => {
      try {
        const result = await updateTeacherEmail({ accountId, email });
        setEmail(result.email);
        toast.success(result.email ? "审批邮箱已保存" : "审批邮箱已清除");
        router.refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "保存失败");
      }
    });
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <Input
        type="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        placeholder="Outlook 邮箱"
        aria-label={`${displayName} 的指导老师审批邮箱`}
        className="h-8 min-w-0 text-xs"
        disabled={pending || saving}
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-8 shrink-0 px-2 text-xs"
        disabled={pending || saving}
        onClick={handleSave}
      >
        保存
      </Button>
    </div>
  );
}

function AccountsAndRolesCard({
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
  filters: Filters;
  pending: boolean;
  run: RunMutation;
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
              <div className="hidden min-w-0 md:block">
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
              <div className="grid min-w-0 gap-3 md:hidden" data-testid="mobile-account-list">
                {accounts.map((account) => (
                  <section key={account.id} className="min-w-0 space-y-3 rounded-xl border p-4">
                    <AccountIdentity account={account} />
                    <p className="text-xs text-muted-foreground">
                      入库时间：{new Date(account.createdAt).toLocaleString("zh-CN")}
                    </p>
                    <InlineAccountRoles
                      account={account}
                      pending={pending}
                      run={run}
                      onResponsibilityRemove={onResponsibilityRemove}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="w-full"
                      onClick={() => onShowHistory(account.id)}
                    >
                      <History className="mr-1 h-4 w-4" />查看记录
                    </Button>
                  </section>
                ))}
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
  run: RunMutation;
  onResponsibilityAdd: (responsibility: AdminResponsibilityAssignment) => void;
}) {
  const [accountId, setAccountId] = useState<string | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<AdminAccountOption | null>(null);
  const [role, setRole] = useState<AssignableRole | "">("");
  const [scope, setScope] = useState("");
  const teamScoped = role === "TEAM_ADMIN" || role === "FINANCE";
  const techGroupScoped = role === "TECH_GROUP_ADMIN" || role === "TEACHER";
  const reimbursementScoped = teamScoped || techGroupScoped;

  function handleAssign() {
    if (!accountId || !role) {
      toast.error("请选择用户和角色");
      return;
    }
    if ((teamScoped || techGroupScoped) && !scope) {
      toast.error(teamScoped ? "请选择车组" : "请选择技术组");
      return;
    }
    const resetRole = () => {
      setRole("");
      setScope("");
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
          onValueChange={setAccountId}
          onOptionChange={setSelectedAccount}
          ariaLabel="选择要配置角色的用户"
          disabled={pending}
        />
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
              toast.error("该账号缺少报销用户资料，请重新选择已同步账号");
            }
            setRole(nextRole);
            setScope("");
          }}
          disabled={pending}
        >
          <SelectTrigger className="w-full" aria-label="选择角色">
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
      </label>
      <RoleScopeSelect
        role={role}
        scope={scope}
        onScopeChange={setScope}
        disabled={pending}
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
}: {
  role: AssignableRole | "";
  scope: string;
  onScopeChange: (value: string) => void;
  disabled: boolean;
}) {
  const teamScoped = role === "TEAM_ADMIN" || role === "FINANCE";
  const techGroupScoped = role === "TECH_GROUP_ADMIN" || role === "TEACHER";
  if (!teamScoped && !techGroupScoped) {
    return <div className="hidden h-[3.25rem] sm:block" aria-hidden="true" />;
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
        <SelectTrigger className="w-full" aria-label={`选择${label}`}>
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
  run: RunMutation;
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
            aria-label={`撤销 ${displayName(account)} 的 ${systemRoleLabel(assignment)} 角色`}
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
            aria-label={`移除 ${displayName(account)} 的 ${reimbursementRoleLabel(assignment)} 角色`}
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

function AccountFilters({ filters }: { filters: Filters }) {
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

function AccountHistoryDialog({
  account,
  open,
  onOpenChange,
}: {
  account: AdminAccountRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!account) return null;
  const assignments = [...account.systemRoles, ...account.reimbursementRoles];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl"
        data-testid="account-history-dialog"
      >
        <DialogHeader>
          <DialogTitle className="min-w-0 break-all pr-10 leading-6">
            账号记录 · {displayName(account)}
          </DialogTitle>
          <DialogDescription>
            查看飞书身份、角色历史和账号安全审计；角色编辑请在账号列表中完成。
          </DialogDescription>
        </DialogHeader>
        <section className="min-w-0 space-y-3 rounded-xl border p-4">
          <h3 className="font-medium">账号与身份</h3>
          <dl className="space-y-2 text-sm">
            <IdentityRows account={account} />
            <div className="flex flex-wrap justify-between gap-3">
              <dt className="text-muted-foreground">最后登录</dt>
              <dd>
                {account.lastLoginAt
                  ? new Date(account.lastLoginAt).toLocaleString("zh-CN")
                  : "尚未登录"}
              </dd>
            </div>
          </dl>
        </section>
        <section className="min-w-0 space-y-3 rounded-xl border p-4">
          <h3 className="font-medium">角色历史</h3>
          <div className="grid gap-2 text-sm">
            {assignments.length === 0 ? (
              <p className="text-muted-foreground">暂无角色记录。</p>
            ) : (
              assignments.map((assignment) => (
                <div
                  key={assignment.id}
                  className="flex min-w-0 flex-wrap justify-between gap-2 rounded-lg bg-muted/40 px-3 py-2"
                >
                  <span className="min-w-0 break-words">
                    {projectRoleLabels[assignment.role]
                      ? systemRoleLabel(assignment)
                      : reimbursementRoleLabel(assignment)}
                  </span>
                  <span className="text-muted-foreground">
                    {assignment.revokedAt
                      ? `已于 ${new Date(assignment.revokedAt).toLocaleString("zh-CN")} 撤销`
                      : "当前有效"}
                  </span>
                </div>
              ))
            )}
          </div>
        </section>
        <section className="min-w-0 space-y-3 rounded-xl border p-4">
          <h3 className="font-medium">账号安全审计</h3>
          <div className="grid gap-2 text-sm">
            {account.securityAuditEvents.length === 0 ? (
              <p className="text-muted-foreground">暂无账号安全变更记录。</p>
            ) : (
              account.securityAuditEvents.map((event) => (
                <div
                  key={event.id}
                  className="flex min-w-0 flex-wrap justify-between gap-2 rounded-lg bg-muted/40 px-3 py-2"
                >
                  <span className="min-w-0 break-words">
                    {securityAuditLabel(event.action)} · {event.operatorName}
                  </span>
                  <span className="text-muted-foreground">
                    {new Date(event.createdAt).toLocaleString("zh-CN")}
                    {event.source === "MIGRATION" ? " · 数据迁移" : ""}
                  </span>
                </div>
              ))
            )}
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}

function AdminAccountSelect({
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
      for (const option of result.items) optionCache.current.set(option.id, option);
      return result;
    },
    [purpose],
  );
  const resolveOptions = useCallback(
    async (ids: string[]) => {
      const options = await resolveAdminAccountOptionsByIds({ purpose, ids });
      for (const option of options) optionCache.current.set(option.id, option);
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
      getOptionDescription={(option) =>
        accountOptionDescription(option)
      }
      renderOption={(option) => (
        <div className="flex min-w-0 items-center gap-2">
          <AccountAvatar
            name={option.displayName}
            avatar={option.avatar}
            size="small"
          />
          <span className="min-w-0">
            <span className="block truncate font-medium">{option.displayName}</span>
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

function AccountIdentity({
  account,
  showOpenId = true,
}: {
  account: AdminAccountRow;
  showOpenId?: boolean;
}) {
  const name = displayName(account);
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

function AccountAvatar({
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

function IdentityRows({ account }: { account: AdminAccountRow }) {
  const identity = account.identities[0];
  return (
    <>
      <div className="flex min-w-0 flex-wrap justify-between gap-3">
        <dt className="shrink-0 text-muted-foreground">openId</dt>
        <dd className="min-w-0 break-all text-right">{identity?.openId ?? "缺失"}</dd>
      </div>
      <div className="flex min-w-0 flex-wrap justify-between gap-3">
        <dt className="shrink-0 text-muted-foreground">unionId</dt>
        <dd className="min-w-0 break-all text-right">{identity?.unionId ?? "缺失"}</dd>
      </div>
    </>
  );
}

function responsibilitiesFor(
  responsibilities: AdminResponsibilityAssignment[],
  role: ReimbursementRole,
  scope: string,
) {
  return responsibilities.filter(
    (assignment) =>
      assignment.role === role &&
      (assignment.team === scope || assignment.techGroup === scope),
  );
}

function teacherEmailOwners(
  responsibilities: AdminResponsibilityAssignment[],
) {
  const owners = new Map<
    string,
    { assignmentId: string; techGroup: string }
  >();
  for (const assignment of responsibilities) {
    if (assignment.role !== "TEACHER" || owners.has(assignment.account.id)) {
      continue;
    }
    owners.set(assignment.account.id, {
      assignmentId: assignment.id,
      techGroup: assignment.techGroup,
    });
  }
  return owners;
}

function responsibilityFromOption({
  assignmentId,
  role,
  scope,
  scopeKind,
  account,
}: {
  assignmentId: string;
  role: ReimbursementRole;
  scope: string;
  scopeKind: "team" | "techGroup";
  account: AdminAccountOption;
}): AdminResponsibilityAssignment {
  return {
    id: assignmentId,
    role,
    team: scopeKind === "team" ? scope : "",
    techGroup: scopeKind === "techGroup" ? scope : "",
    account: {
      id: account.id,
      displayName: account.displayName,
      avatar: account.avatar,
      email: account.email,
    },
  };
}

function isProjectRole(role: AssignableRole): role is ProjectRole {
  return role === "SUPER_ADMINISTRATOR" || role === "PROJECT_ADMINISTRATOR";
}

function roleLabel(role: string) {
  return projectRoleLabels[role] ?? reimbursementRoleLabels[role] ?? "";
}

function displayName(account: AdminAccountRow) {
  return account.person?.displayName || account.reimbursementUser?.name || "未知用户";
}

function systemRoleLabel(assignment: {
  role: string;
  team: string;
  techGroup: string;
}) {
  const scope = assignment.team || assignment.techGroup;
  return `${projectRoleLabels[assignment.role] ?? assignment.role}${scope ? ` · ${scope}` : ""}`;
}

function reimbursementRoleLabel(assignment: {
  role: string;
  team: string;
  techGroup: string;
}) {
  const scope = assignment.team || assignment.techGroup;
  return `${reimbursementRoleLabels[assignment.role] ?? assignment.role}${scope ? ` · ${scope}` : ""}`;
}

function securityAuditLabel(action: string) {
  return (
    {
      "account.role.granted": "授予项目角色",
      "account.role.revoked": "撤销项目角色",
      "account.reimbursement_role.granted": "授予报销角色",
      "account.reimbursement_role.revoked": "撤销报销角色",
      "account.teacher_email.updated": "更新指导老师审批邮箱",
      "account.project_access.removed": "移除项目访问禁用机制",
      "account.role.migrated": "迁移账号角色",
    }[action] ?? "账号安全变更"
  );
}

function pageHref(filters: Filters, page: number) {
  const params = new URLSearchParams();
  if (filters.query) params.set("q", filters.query);
  if (filters.role) params.set("role", filters.role);
  if (filters.team) params.set("team", filters.team);
  if (filters.techGroup) params.set("techGroup", filters.techGroup);
  params.set("page", String(page));
  return `/admin/accounts?${params.toString()}`;
}
