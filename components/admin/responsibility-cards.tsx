"use client";

import { useId, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { toast } from "sonner";
import {
  assignAccountReimbursementRole,
  revokeAccountReimbursementRole,
} from "@/app/actions/adminRoles";
import { updateTeacherEmail } from "@/app/actions/adminTeacherEmail";
import { AccountAvatar, AdminAccountSelect } from "@/components/admin/account-identity";
import type {
  AdminAccountOption,
  AdminResponsibilityAssignment,
} from "@/components/admin/account-types";
import {
  reimbursementRoleLabel,
  reimbursementRoleLabels,
  responsibilityFromOption,
  type ReimbursementRole,
  type RunAccountMutation,
} from "@/components/admin/accounts-contract";
import { Button } from "@/components/ui/button";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TEAM_OPTIONS, TECH_GROUP_OPTIONS } from "@/lib/constants";

type ResponsibilityCardProps = {
  responsibilities: AdminResponsibilityAssignment[];
  pending: boolean;
  run: RunAccountMutation;
  onAdd: (responsibility: AdminResponsibilityAssignment) => void;
  onRemove: (assignmentId: string) => void;
};

export function TeamResponsibilitiesCard(props: ResponsibilityCardProps) {
  const { responsibilities, pending, run, onAdd, onRemove } = props;
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>车组职责配置</CardTitle>
        <CardDescription>
          为每个车组指定报销车组组长与报销员；用户需已同步报销资料。
        </CardDescription>
      </CardHeader>
      <CardContent className="min-w-0">
        <div className="min-w-0">
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
                      entries={responsibilitiesFor(responsibilities, "TEAM_ADMIN", team)}
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
                      entries={responsibilitiesFor(responsibilities, "FINANCE", team)}
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

      </CardContent>
    </Card>
  );
}

export function TechGroupResponsibilitiesCard(props: ResponsibilityCardProps) {
  const { responsibilities, pending, run, onAdd, onRemove } = props;
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
        <div className="min-w-0">
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
                      entries={responsibilitiesFor(responsibilities, "TECH_GROUP_ADMIN", techGroup)}
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
                      entries={responsibilitiesFor(responsibilities, "TEACHER", techGroup)}
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

      </CardContent>
    </Card>
  );
}

type ResponsibilityCellProps = {
  scope: string;
  scopeKind: "team" | "techGroup";
  role: ReimbursementRole;
  entries: AdminResponsibilityAssignment[];
  pending: boolean;
  run: RunAccountMutation;
  onAdd: (responsibility: AdminResponsibilityAssignment) => void;
  onRemove: (assignmentId: string) => void;
  showTeacherEmail?: boolean;
  teacherEmailOwnerByAccount?: Map<string, { assignmentId: string; techGroup: string }>;
};

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
  const [selectedAccount, setSelectedAccount] = useState<AdminAccountOption | null>(null);
  const [accountError, setAccountError] = useState("");
  const label = reimbursementRoleLabels[role];
  const pickerId = useId();
  const pickerErrorId = `${pickerId}-error`;

  function handleAdd() {
    if (!accountId) {
      setAccountError("请选择要添加的账号");
      requestAnimationFrame(() => document.getElementById(pickerId)?.focus());
      return;
    }
    run(
      () => assignAccountReimbursementRole({
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
            onAdd(responsibilityFromOption({
              assignmentId: result.assignmentId,
              role,
              scope,
              scopeKind,
              account: selectedAccount,
            }));
          }
          setAccountId(null);
          setSelectedAccount(null);
          setAccountError("");
        },
      },
    );
  }

  return (
    <div className="grid min-w-0 gap-3 xl:grid-cols-[minmax(10rem,14rem)_minmax(0,1fr)] xl:items-start">
      <div className="min-w-0 space-y-1">
        <div className="flex min-w-0 gap-2">
          <AdminAccountSelect
            purpose="REIMBURSEMENT"
            value={accountId}
            onValueChange={(value) => { setAccountId(value); if (value) setAccountError(""); }}
            onOptionChange={setSelectedAccount}
            excludeIds={entries.map((entry) => entry.account.id)}
            ariaLabel={`为${scope}选择${label}`}
            placeholder="搜索添加"
            className="min-w-0 flex-1"
            disabled={pending}
            inputId={pickerId}
            invalid={Boolean(accountError)}
            ariaDescribedBy={accountError ? pickerErrorId : undefined}
            openOnFocus={false}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="shrink-0"
            disabled={pending}
            aria-label={`添加${scope}${label}`}
            onClick={handleAdd}
          >
            确定
          </Button>
        </div>
        <FieldError id={pickerErrorId} messages={accountError} />
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
                onRemove={() => run(
                  () => revokeAccountReimbursementRole({ assignmentId: entry.id }),
                  {
                    success: `${scope}${label}已移除`,
                    unchanged: "该角色已被移除",
                    afterSuccess: (result) => onRemove(result.assignmentId ?? entry.id),
                  },
                )}
              />
              {showTeacherEmail &&
              teacherEmailOwnerByAccount?.get(entry.account.id)?.assignmentId === entry.id ? (
                <TeacherEmailEditor
                  accountId={entry.account.id}
                  displayName={entry.account.displayName}
                  initialEmail={entry.account.email ?? ""}
                  pending={pending}
                />
              ) : showTeacherEmail ? (
                <p className="max-w-64 break-words text-xs text-muted-foreground">
                  审批邮箱与
                  {teacherEmailOwnerByAccount?.get(entry.account.id)?.techGroup ?? "其他技术组"}
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
      <AccountAvatar name={entry.account.displayName} avatar={entry.account.avatar} size="small" />
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
  const [emailError, setEmailError] = useState("");
  const emailInputRef = useRef<HTMLInputElement | null>(null);
  const emailErrorId = `${useId()}-error`;

  function revealEmailError(message: string) {
    setEmailError(message);
    requestAnimationFrame(() => emailInputRef.current?.focus());
  }

  function handleSave() {
    const trimmed = email.trim();
    if (trimmed.length > 254) {
      revealEmailError("邮箱长度不能超过 254 个字符");
      return;
    }
    if (trimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      revealEmailError("邮箱格式不正确");
      return;
    }
    startSaving(async () => {
      try {
        const result = await updateTeacherEmail({ accountId, email });
        setEmail(result.email);
        toast.success(result.email ? "审批邮箱已保存" : "审批邮箱已清除");
        router.refresh();
      } catch (error) {
        const message = error instanceof Error ? error.message : "保存失败";
        if (message.includes("邮箱")) revealEmailError(message);
        else toast.error(message);
      }
    });
  }

  return (
    <div className="min-w-0 space-y-1">
      <div className="flex min-w-0 items-center gap-1">
        <Input
        ref={emailInputRef}
        type="email"
        value={email}
        onChange={(event) => { setEmail(event.target.value); setEmailError(""); }}
        placeholder="Outlook 邮箱"
        aria-label={`${displayName} 的指导老师审批邮箱`}
        className="h-8 min-w-0 text-xs"
        disabled={pending || saving}
        aria-invalid={Boolean(emailError)}
        aria-describedby={emailError ? emailErrorId : undefined}
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
      <FieldError id={emailErrorId} messages={emailError} className="text-xs" />
    </div>
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

function teacherEmailOwners(responsibilities: AdminResponsibilityAssignment[]) {
  const owners = new Map<string, { assignmentId: string; techGroup: string }>();
  for (const assignment of responsibilities) {
    if (assignment.role !== "TEACHER" || owners.has(assignment.account.id)) continue;
    owners.set(assignment.account.id, {
      assignmentId: assignment.id,
      techGroup: assignment.techGroup,
    });
  }
  return owners;
}
