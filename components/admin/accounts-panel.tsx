"use client";

import Image from "next/image";
import Link from "next/link";
import { useMemo, useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck, UserRoundCog, X } from "lucide-react";
import { toast } from "sonner";
import {
  assignAccountReimbursementRole,
  grantProjectSystemRole,
  revokeAccountReimbursementRole,
  revokeProjectSystemRole,
} from "@/app/actions/adminRoles";
import type { AdminAccountRow } from "@/components/admin/account-types";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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

type Filters = {
  query: string;
  role: string;
  team: string;
  techGroup: string;
};

export function AccountsPanel({
  accounts,
  page,
  pageSize,
  total,
  hasMoreByQuery,
  filters,
}: {
  accounts: AdminAccountRow[];
  page: number;
  pageSize: number;
  total: number;
  hasMoreByQuery: boolean;
  filters: Filters;
}) {
  const router = useRouter();
  const isMobile = useMobileAccountsLayout();
  const [pending, startTransition] = useTransition();
  const [selectedId, setSelectedId] = useState("");
  const selected = useMemo(
    () => accounts.find((account) => account.id === selectedId),
    [accounts, selectedId],
  );
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  function run(action: () => Promise<unknown>, success: string) {
    startTransition(async () => {
      try {
        await action();
        toast.success(success);
        router.refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "操作失败，请稍后重试");
      }
    });
  }

  return (
    <div className="min-w-0 space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>账号与权限</CardTitle>
          <CardDescription>
            统一管理项目角色与报销角色；业务权限仍由角色和 Task 成员关系决定。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <AccountFilters filters={filters} />
          {hasMoreByQuery && (
            <p className="text-sm text-amber-700" role="status">
              匹配账号较多，当前仅在前 501 个候选中排序，请继续输入关键词缩小范围。
            </p>
          )}
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
                      <TableHead>账号</TableHead>
                      <TableHead>系统身份</TableHead>
                      <TableHead>报销角色</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {accounts.map((account) => (
                      <TableRow key={account.id}>
                        <TableCell><AccountIdentity account={account} /></TableCell>
                        <TableCell><RoleBadges account={account} kind="project" /></TableCell>
                        <TableCell><RoleBadges account={account} kind="reimbursement" /></TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant={selected?.id === account.id ? "secondary" : "outline"}
                            size="sm"
                            onClick={() => setSelectedId(account.id)}
                          >
                            管理
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="grid gap-3 md:hidden">
                {accounts.map((account) => (
                  <button
                    type="button"
                    key={account.id}
                    aria-label={`管理 ${displayName(account)}`}
                    onClick={() => setSelectedId(account.id)}
                    className={cn(
                      "min-w-0 rounded-xl border bg-card p-4 text-left",
                      selected?.id === account.id && "border-primary ring-1 ring-primary/30",
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <AccountIdentity account={account} />
                    </div>
                    <div className="mt-3"><RoleBadges account={account} kind="project" /></div>
                  </button>
                ))}
              </div>
              <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
                <span>共 {total} 个账号，第 {page}/{pageCount} 页</span>
                <div className="flex gap-2">
                  <Link
                    aria-disabled={page <= 1}
                    className={cn(buttonVariants({ variant: "outline", size: "sm" }), page <= 1 && "pointer-events-none opacity-50")}
                    href={pageHref(filters, Math.max(1, page - 1))}
                  >上一页</Link>
                  <Link
                    aria-disabled={page >= pageCount}
                    className={cn(buttonVariants({ variant: "outline", size: "sm" }), page >= pageCount && "pointer-events-none opacity-50")}
                    href={pageHref(filters, Math.min(pageCount, page + 1))}
                  >下一页</Link>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {selected ? (
        isMobile ? (
          <div className="fixed inset-0 z-50 overflow-y-auto bg-background">
            <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-background/95 px-4 py-3 backdrop-blur">
              <span className="min-w-0 truncate font-medium">账号详情 · {displayName(selected)}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="关闭账号详情"
                onClick={() => setSelectedId("")}
              >
                <X className="h-5 w-5" />
              </Button>
            </div>
            <div className="p-3">
              <AccountDetail account={selected} pending={pending} run={run} />
            </div>
          </div>
        ) : (
          <AccountDetail account={selected} pending={pending} run={run} />
        )
      ) : null}
    </div>
  );
}

function AccountFilters({ filters }: { filters: Filters }) {
  return (
    <form className="grid min-w-0 gap-3 lg:grid-cols-[minmax(12rem,1fr)_11rem_9rem_9rem_auto]">
      <Input name="q" defaultValue={filters.query} placeholder="搜索姓名或飞书 ID" aria-label="搜索账号" />
      <select name="role" defaultValue={filters.role} aria-label="角色类型" className="h-8 rounded-lg border border-input bg-background px-2 text-sm">
        <option value="">全部角色</option><option value="SUPER_ADMINISTRATOR">超级管理员</option><option value="PROJECT_ADMINISTRATOR">项目管理员</option><option value="ORDINARY">普通成员</option><option value="TEAM_ADMIN">报销车组组长</option><option value="TECH_GROUP_ADMIN">报销技术组组长</option><option value="TEACHER">指导老师</option><option value="FINANCE">报销员</option>
      </select>
      <select name="team" defaultValue={filters.team} aria-label="车组" className="h-8 rounded-lg border border-input bg-background px-2 text-sm"><option value="">全部车组</option>{TEAM_OPTIONS.map((item) => <option key={item}>{item}</option>)}</select>
      <select name="techGroup" defaultValue={filters.techGroup} aria-label="技术组" className="h-8 rounded-lg border border-input bg-background px-2 text-sm"><option value="">全部技术组</option>{TECH_GROUP_OPTIONS.map((item) => <option key={item}>{item}</option>)}</select>
      <div className="flex gap-2"><Button type="submit">筛选</Button><Link href="/admin/accounts" className={cn(buttonVariants({ variant: "outline" }))}>重置</Link></div>
    </form>
  );
}

function AccountDetail({
  account,
  pending,
  run,
}: {
  account: AdminAccountRow;
  pending: boolean;
  run: (action: () => Promise<unknown>, success: string) => void;
}) {
  const activeSystem = account.systemRoles.filter(
    (assignment) => !assignment.revokedAt && activeProjectRoles.has(assignment.role),
  );
  const activeReimbursement = account.reimbursementRoles.filter(
    (assignment) => !assignment.revokedAt && assignment.role !== "SUPER_ADMIN",
  );
  return (
    <Card data-testid="account-permission-detail">
      <CardHeader>
        <CardTitle className="flex min-w-0 items-center gap-2"><UserRoundCog className="h-5 w-5 shrink-0" /><span className="truncate">{displayName(account)}</span></CardTitle>
        <CardDescription>飞书身份以及项目、报销两个业务域的角色配置。</CardDescription>
      </CardHeader>
      <CardContent className="grid min-w-0 gap-6 xl:grid-cols-2">
        <section className="min-w-0 space-y-3 rounded-xl border p-4">
          <h3 className="font-medium">账号与身份</h3>
          <dl className="space-y-2 text-sm">
            <IdentityRows account={account} />
            <div className="flex justify-between gap-3"><dt className="text-muted-foreground">最后登录</dt><dd>{account.lastLoginAt ? new Date(account.lastLoginAt).toLocaleString("zh-CN") : "尚未登录"}</dd></div>
          </dl>
        </section>

        <section className="min-w-0 space-y-3 rounded-xl border p-4">
          <h3 className="font-medium">全局与项目权限</h3>
          <div className="flex flex-wrap gap-2">
            {activeSystem.length ? activeSystem.map((assignment) => (
              <Badge key={assignment.id} variant="secondary" className="max-w-full gap-1">
                <span className="truncate">{systemRoleLabel(assignment)}</span>
                <button type="button" aria-label={`撤销${systemRoleLabel(assignment)}`} disabled={pending} onClick={() => {
                  const impact = assignment.role === "SUPER_ADMINISTRATOR"
                    ? "撤销后，该账号将失去报销、项目和账号权限后台的最高权限。系统会阻止自撤销和撤销最后一名超级管理员。"
                    : "撤销后，该账号将立即失去此项目角色提供的权限，已有 Task 成员权限不受影响。";
                  if (window.confirm(`确定撤销“${systemRoleLabel(assignment)}”？\n\n${impact}`)) run(() => revokeProjectSystemRole({ assignmentId: assignment.id }), "项目角色已撤销");
                }}><X className="h-3 w-3" /></button>
              </Badge>
            )) : <span className="text-sm text-muted-foreground">普通成员（无系统角色）</span>}
          </div>
          <ProjectRoleForm accountId={account.id} pending={pending} run={run} />
        </section>

        <section className="min-w-0 space-y-3 rounded-xl border p-4 xl:col-span-2">
          <h3 className="font-medium">报销权限</h3>
          <div className="flex flex-wrap gap-2">
            {activeReimbursement.length ? activeReimbursement.map((assignment) => (
              <Badge key={assignment.id} variant="outline" className="max-w-full gap-1">
                <span className="truncate">{reimbursementRoleLabel(assignment)}</span>
                <button type="button" aria-label={`撤销${reimbursementRoleLabel(assignment)}`} disabled={pending} onClick={() => { if (window.confirm(`确定撤销“${reimbursementRoleLabel(assignment)}”？`)) run(() => revokeAccountReimbursementRole({ assignmentId: assignment.id }), "报销角色已撤销"); }}><X className="h-3 w-3" /></button>
              </Badge>
            )) : <span className="text-sm text-muted-foreground">没有单独报销角色</span>}
          </div>
          <ReimbursementRoleForm accountId={account.id} pending={pending} run={run} />
        </section>

        <details className="min-w-0 rounded-xl border p-4 xl:col-span-2">
          <summary className="cursor-pointer font-medium">角色历史</summary>
          <div className="mt-3 grid gap-2 text-sm">
            {[...account.systemRoles, ...account.reimbursementRoles].map((assignment) => (
              <div key={assignment.id} className="flex flex-wrap justify-between gap-2 rounded-lg bg-muted/40 px-3 py-2">
                <span>{"role" in assignment && projectRoleLabels[assignment.role] ? systemRoleLabel(assignment) : reimbursementRoleLabel(assignment)}</span>
                <span className="text-muted-foreground">{assignment.revokedAt ? `已于 ${new Date(assignment.revokedAt).toLocaleString("zh-CN")} 撤销` : "当前有效"}</span>
              </div>
            ))}
          </div>
        </details>

        <details className="min-w-0 rounded-xl border p-4 xl:col-span-2">
          <summary className="cursor-pointer font-medium">账号安全审计</summary>
          <div className="mt-3 grid gap-2 text-sm">
            {account.securityAuditEvents.length ? account.securityAuditEvents.map((event) => (
              <div key={event.id} className="flex flex-wrap justify-between gap-2 rounded-lg bg-muted/40 px-3 py-2">
                <span>{securityAuditLabel(event.action)} · {event.operatorName}</span>
                <span className="text-muted-foreground">{new Date(event.createdAt).toLocaleString("zh-CN")}{event.source === "MIGRATION" ? " · 数据迁移" : ""}</span>
              </div>
            )) : <p className="text-muted-foreground">暂无账号安全变更记录。</p>}
          </div>
        </details>
      </CardContent>
    </Card>
  );
}

function ProjectRoleForm({ accountId, pending, run }: FormProps) {
  const [role, setRole] = useState<"SUPER_ADMINISTRATOR" | "PROJECT_ADMINISTRATOR">("PROJECT_ADMINISTRATOR");
  return <div className="grid min-w-0 gap-2 sm:grid-cols-2">
    <select aria-label="项目角色" value={role} onChange={(event) => setRole(event.target.value as typeof role)} className="h-8 rounded-lg border bg-background px-2 text-sm"><option value="SUPER_ADMINISTRATOR">超级管理员</option><option value="PROJECT_ADMINISTRATOR">项目管理员</option></select>
    <Button className="sm:col-span-2" disabled={pending} onClick={() => {
      if (
        role === "SUPER_ADMINISTRATOR" &&
        !window.confirm("确定授予超级管理员？\n\n该账号将获得报销系统、全部项目业务以及账号与权限后台的最高权限。")
      ) return;
      run(() => grantProjectSystemRole({ targetAccountId: accountId, role }), "项目角色已授予");
    }}><ShieldCheck className="mr-1 h-4 w-4" />授予</Button>
  </div>;
}

function ReimbursementRoleForm({ accountId, pending, run }: FormProps) {
  const [role, setRole] = useState<"TEAM_ADMIN" | "TECH_GROUP_ADMIN" | "TEACHER" | "FINANCE">("TEAM_ADMIN");
  const teamScoped = role === "TEAM_ADMIN" || role === "FINANCE";
  const [scopeValue, setScopeValue] = useState<string>(TEAM_OPTIONS[0]);
  return <div className="grid min-w-0 gap-2 md:grid-cols-2">
    <select aria-label="报销角色" value={role} onChange={(event) => { const next = event.target.value as typeof role; setRole(next); setScopeValue(next === "TEAM_ADMIN" || next === "FINANCE" ? TEAM_OPTIONS[0] : TECH_GROUP_OPTIONS[0]); }} className="h-8 rounded-lg border bg-background px-2 text-sm"><option value="TEAM_ADMIN">报销车组组长</option><option value="FINANCE">报销员</option><option value="TECH_GROUP_ADMIN">报销技术组组长</option><option value="TEACHER">指导老师</option></select>
    <select aria-label="报销角色范围" value={scopeValue} onChange={(event) => setScopeValue(event.target.value)} className="h-8 rounded-lg border bg-background px-2 text-sm">{(teamScoped ? TEAM_OPTIONS : TECH_GROUP_OPTIONS).map((item) => <option key={item}>{item}</option>)}</select>
    <Button className="md:col-span-2" disabled={pending} onClick={() => run(() => assignAccountReimbursementRole({ targetAccountId: accountId, role, team: teamScoped ? scopeValue : undefined, techGroup: teamScoped ? undefined : scopeValue }), "报销角色已授予")}>授予报销角色</Button>
  </div>;
}

type FormProps = { accountId: string; pending: boolean; run: (action: () => Promise<unknown>, success: string) => void };

function AccountIdentity({ account }: { account: AdminAccountRow }) {
  const name = displayName(account);
  return <div className="flex min-w-0 items-center gap-3">{account.person?.avatar ? <Image src={account.person.avatar} alt="" width={36} height={36} className="h-9 w-9 shrink-0 rounded-full object-cover" /> : <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted font-medium">{name.slice(0, 1)}</div>}<div className="min-w-0"><p className="truncate font-medium">{name}</p><p className="truncate text-xs text-muted-foreground">{account.identities[0]?.openId ?? "缺少飞书身份"}</p></div></div>;
}

function IdentityRows({ account }: { account: AdminAccountRow }) {
  const identity = account.identities[0];
  return <><div className="flex min-w-0 justify-between gap-3"><dt className="shrink-0 text-muted-foreground">openId</dt><dd className="min-w-0 break-all text-right">{identity?.openId ?? "缺失"}</dd></div><div className="flex min-w-0 justify-between gap-3"><dt className="shrink-0 text-muted-foreground">unionId</dt><dd className="min-w-0 break-all text-right">{identity?.unionId ?? "缺失"}</dd></div></>;
}

function RoleBadges({ account, kind }: { account: AdminAccountRow; kind: "project" | "reimbursement" }) {
  const labels = kind === "project" ? account.systemRoles.filter((item) => !item.revokedAt && activeProjectRoles.has(item.role)).map(systemRoleLabel) : account.reimbursementRoles.filter((item) => !item.revokedAt && item.role !== "SUPER_ADMIN").map(reimbursementRoleLabel);
  if (!labels.length) return <span className="text-xs text-muted-foreground">{kind === "project" ? "普通成员" : "无"}</span>;
  return <div className="flex max-w-sm flex-wrap gap-1">{labels.map((label) => <Badge key={label} variant="secondary" className="max-w-full truncate">{label}</Badge>)}</div>;
}

function displayName(account: AdminAccountRow) { return account.person?.displayName || account.reimbursementUser?.name || "未知用户"; }
function useMobileAccountsLayout() { return useSyncExternalStore(subscribeMobileAccountsLayout, mobileAccountsLayoutSnapshot, () => false); }
function subscribeMobileAccountsLayout(callback: () => void) { const query = window.matchMedia("(max-width: 767px)"); query.addEventListener("change", callback); return () => query.removeEventListener("change", callback); }
function mobileAccountsLayoutSnapshot() { return window.matchMedia("(max-width: 767px)").matches; }
function systemRoleLabel(assignment: { role: string; team: string; techGroup: string }) { const scope = assignment.team || assignment.techGroup; return `${projectRoleLabels[assignment.role] ?? assignment.role}${scope ? ` · ${scope}` : ""}`; }
function reimbursementRoleLabel(assignment: { role: string; team: string; techGroup: string }) { const scope = assignment.team || assignment.techGroup; return `${reimbursementRoleLabels[assignment.role] ?? assignment.role}${scope ? ` · ${scope}` : ""}`; }
function securityAuditLabel(action: string) { return ({ "account.role.granted": "授予项目角色", "account.role.revoked": "撤销项目角色", "account.reimbursement_role.granted": "授予报销角色", "account.reimbursement_role.revoked": "撤销报销角色", "account.project_access.removed": "移除项目访问禁用机制", "account.role.migrated": "迁移账号角色" }[action] ?? "账号安全变更"); }
function pageHref(filters: Filters, page: number) { const params = new URLSearchParams(); if (filters.query) params.set("q", filters.query); if (filters.role) params.set("role", filters.role); if (filters.team) params.set("team", filters.team); if (filters.techGroup) params.set("techGroup", filters.techGroup); params.set("page", String(page)); return `/admin/accounts?${params.toString()}`; }
