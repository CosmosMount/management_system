"use client";

import type { AdminAccountRow } from "@/components/admin/account-types";
import {
  accountDisplayName,
  projectRoleLabels,
  reimbursementRoleLabel,
  systemRoleLabel,
} from "@/components/admin/accounts-contract";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function AccountHistoryDialog({
  account,
  open,
  onOpenChange,
}: {
  account: AdminAccountRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!account) return null;
  const assignments = [
    ...account.systemRoles,
    ...account.archivedProjectRoles.map((assignment) => ({
      ...assignment,
      archived: true as const,
    })),
    ...account.reimbursementRoles,
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl"
        data-testid="account-history-dialog"
      >
        <DialogHeader>
          <DialogTitle className="min-w-0 break-all pr-10 leading-6">
            账号记录 · {accountDisplayName(account)}
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
                    {"archived" in assignment
                      ? `已于 ${new Date(assignment.revokedAt).toLocaleString("zh-CN")} 归档`
                      : assignment.revokedAt
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

function IdentityRows({ account }: { account: AdminAccountRow }) {
  const identity = account.identities[0];
  return (
    <>
      <div className="flex min-w-0 flex-wrap justify-between gap-3">
        <dt className="shrink-0 text-muted-foreground">openId</dt>
        <dd className="min-w-0 break-all text-right">
          {identity?.openId ?? "缺失"}
        </dd>
      </div>
      <div className="flex min-w-0 flex-wrap justify-between gap-3">
        <dt className="shrink-0 text-muted-foreground">unionId</dt>
        <dd className="min-w-0 break-all text-right">
          {identity?.unionId ?? "缺失"}
        </dd>
      </div>
    </>
  );
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
      "account.legacy_project_role.archived": "归档旧项目角色",
    }[action] ?? "账号安全变更"
  );
}
