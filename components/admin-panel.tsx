"use client";

import type { ComponentType } from "react";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ClipboardCheck,
  RefreshCw,
  ShieldCheck,
  UserCog,
  Users,
  X,
} from "lucide-react";
import type { UserRoleType } from "@prisma/client";
import {
  createAcceptanceChecklistTemplate,
  deleteAcceptanceChecklistTemplate,
} from "@/app/actions/adminAcceptanceChecklistTemplates";
import {
  assignUserRole,
  removeUserRole,
} from "@/app/actions/adminRoles";
import { syncFeishuUsers } from "@/app/actions/syncFeishuUsers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UserSearchSelect } from "@/components/user-search-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TEAM_OPTIONS, TECH_GROUP_OPTIONS } from "@/lib/constants";
import { formatRoleLabel, roleLabels } from "@/lib/permissions-client";

export type AdminUser = {
  id: string;
  openId: string;
  name: string;
  avatar: string | null;
  createdAt: string;
};

export type AdminRole = {
  id: string;
  openId: string;
  role: UserRoleType;
  team: string;
  techGroup: string;
};

export type AdminAcceptanceChecklistTemplate = {
  id: string;
  content: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

type Props = {
  users: AdminUser[];
  roles: AdminRole[];
  acceptanceChecklistTemplates: AdminAcceptanceChecklistTemplate[];
};

type UserOption = {
  openId: string;
  name: string;
  avatar: string | null;
};

type AdminIcon = ComponentType<{ className?: string }>;

export function AdminPanel({
  users,
  roles,
  acceptanceChecklistTemplates,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [assignOpenId, setAssignOpenId] = useState("");
  const [assignRole, setAssignRole] = useState<UserRoleType | "">("");
  const [assignTeam, setAssignTeam] = useState("");
  const [assignTechGroup, setAssignTechGroup] = useState("");
  const [templateContent, setTemplateContent] = useState("");

  const rolesByOpenId = roles.reduce<Record<string, AdminRole[]>>((acc, role) => {
    if (!acc[role.openId]) acc[role.openId] = [];
    acc[role.openId].push(role);
    return acc;
  }, {});
  const assignedUserCount = Object.keys(rolesByOpenId).length;
  const superAdminCount = roles.filter((role) => role.role === "SUPER_ADMIN").length;
  const teamAdminCount = roles.filter((role) => role.role === "TEAM_ADMIN").length;
  const techGroupAdminCount = roles.filter(
    (role) => role.role === "TECH_GROUP_ADMIN",
  ).length;
  const financeCount = roles.filter((role) => role.role === "FINANCE").length;
  const projectManagerCount = roles.filter(
    (role) => role.role === "PROJECT_MANAGER",
  ).length;
  const teacherCount = roles.filter((role) => role.role === "TEACHER").length;
  const userOptions = users.map((user) => ({
    openId: user.openId,
    name: user.name,
    avatar: user.avatar,
  }));

  function teamRoles(team: string, role: UserRoleType) {
    return roles.filter((r) => r.team === team && r.role === role);
  }

  function techGroupRoles(techGroup: string, role: UserRoleType) {
    return roles.filter((r) => r.techGroup === techGroup && r.role === role);
  }

  function handleAssign() {
    if (!assignOpenId || !assignRole) {
      toast.error("请选择用户和角色");
      return;
    }
    if (
      (assignRole === "TEAM_ADMIN" || assignRole === "FINANCE") &&
      !assignTeam
    ) {
      toast.error("请选择车组");
      return;
    }
    if (assignRole === "TECH_GROUP_ADMIN" && !assignTechGroup) {
      toast.error("请选择技术组");
      return;
    }

    startTransition(async () => {
      try {
        await assignUserRole({
          openId: assignOpenId,
          role: assignRole,
          team:
            assignRole === "TEAM_ADMIN" || assignRole === "FINANCE"
              ? assignTeam
              : undefined,
          techGroup:
            assignRole === "TECH_GROUP_ADMIN" ? assignTechGroup : undefined,
        });
        toast.success("角色已分配");
        setAssignRole("");
        setAssignTeam("");
        setAssignTechGroup("");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "分配失败");
      }
    });
  }

  function handleRemove(roleId: string) {
    startTransition(async () => {
      try {
        await removeUserRole(roleId);
        toast.success("已移除角色");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "移除失败");
      }
    });
  }

  function handleQuickAssign(
    openId: string,
    role: UserRoleType,
    team: string,
  ) {
    startTransition(async () => {
      try {
        await assignUserRole({ openId, role, team });
        toast.success("已添加");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "添加失败");
      }
    });
  }

  function handleQuickAssignTechGroup(openId: string, techGroup: string) {
    startTransition(async () => {
      try {
        await assignUserRole({
          openId,
          role: "TECH_GROUP_ADMIN",
          techGroup,
        });
        toast.success("已添加");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "添加失败");
      }
    });
  }

  function handleSyncFeishu() {
    startTransition(async () => {
      try {
        const result = await syncFeishuUsers();
        toast.success(
          `已同步 ${result.total} 人（新增 ${result.created}，更新 ${result.updated}）`,
        );
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "同步失败");
      }
    });
  }

  function handleCreateAcceptanceTemplate() {
    const content = templateContent.trim();
    if (!content) {
      toast.error("请输入验收条例");
      return;
    }

    startTransition(async () => {
      try {
        await createAcceptanceChecklistTemplate(content);
        toast.success("验收条例已添加");
        setTemplateContent("");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "添加失败");
      }
    });
  }

  function handleDeleteAcceptanceTemplate(id: string) {
    startTransition(async () => {
      try {
        await deleteAcceptanceChecklistTemplate(id);
        toast.success("验收条例已删除");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "删除失败");
      }
    });
  }

  return (
    <div className="min-w-0 space-y-6">
      <section className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <AdminMetric
          icon={Users}
          label="通讯录用户"
          value={users.length}
          detail={`${assignedUserCount} 人已有角色`}
        />
        <AdminMetric
          icon={ShieldCheck}
          label="全局管理"
          value={superAdminCount + projectManagerCount + teacherCount}
          detail={`超管 ${superAdminCount} · 项管 ${projectManagerCount} · 老师 ${teacherCount}`}
        />
        <AdminMetric
          icon={UserCog}
          label="组级角色"
          value={teamAdminCount + techGroupAdminCount + financeCount}
          detail={`车组 ${teamAdminCount} · 技术组 ${techGroupAdminCount} · 报销 ${financeCount}`}
        />
        <AdminMetric
          icon={ClipboardCheck}
          label="验收条例"
          value={acceptanceChecklistTemplates.length}
          detail="任务创建时可快捷加入"
        />
      </section>

      <nav className="grid min-w-0 gap-2 sm:grid-cols-4">
        <AdminNavLink href="#system" icon={RefreshCw} label="系统同步" />
        <AdminNavLink href="#roles" icon={ShieldCheck} label="职责配置" />
        <AdminNavLink href="#users" icon={Users} label="用户与角色" />
        <AdminNavLink
          href="#acceptance"
          icon={ClipboardCheck}
          label="验收条例"
        />
      </nav>

      <Card id="system" className="scroll-mt-20">
        <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>系统同步</CardTitle>
            <CardDescription>
              从飞书通讯录更新用户资料，后续角色分配和负责人选择会使用这里的用户数据
            </CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={handleSyncFeishu}
          >
            <RefreshCw className="mr-1 h-4 w-4" />
            同步飞书通讯录
          </Button>
        </CardHeader>
        <CardContent className="min-w-0">
          <div className="grid min-w-0 gap-3 sm:grid-cols-3">
            <SystemStat label="当前用户" value={`${users.length} 人`} />
            <SystemStat label="已分配角色" value={`${roles.length} 条`} />
            <SystemStat
              label="未配置角色"
              value={`${Math.max(users.length - assignedUserCount, 0)} 人`}
            />
          </div>
        </CardContent>
      </Card>

      <section id="roles" className="min-w-0 scroll-mt-20 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>车组职责配置</CardTitle>
            <CardDescription>
              为每个车组指定组长与报销员；用户需先飞书登录本系统
            </CardDescription>
          </CardHeader>
          <CardContent className="min-w-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>车组</TableHead>
                  <TableHead>组长</TableHead>
                  <TableHead>报销员</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {TEAM_OPTIONS.map((team) => (
                  <TableRow key={team}>
                    <TableCell className="font-medium">{team}</TableCell>
                    <TableCell className="min-w-[14rem]">
                      <RoleCell
                        entries={teamRoles(team, "TEAM_ADMIN")}
                        users={users}
                        userOptions={userOptions}
                        team={team}
                        role="TEAM_ADMIN"
                        pending={pending}
                        onRemove={handleRemove}
                        onQuickAssign={handleQuickAssign}
                      />
                    </TableCell>
                    <TableCell className="min-w-[14rem]">
                      <RoleCell
                        entries={teamRoles(team, "FINANCE")}
                        users={users}
                        userOptions={userOptions}
                        team={team}
                        role="FINANCE"
                        pending={pending}
                        onRemove={handleRemove}
                        onQuickAssign={handleQuickAssign}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>技术组职责配置</CardTitle>
            <CardDescription>
              为每个技术组指定组长，参与管理审核（与车组组长分别私信通知）
            </CardDescription>
          </CardHeader>
          <CardContent className="min-w-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>技术组</TableHead>
                  <TableHead>组长</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {TECH_GROUP_OPTIONS.map((techGroup) => (
                  <TableRow key={techGroup}>
                    <TableCell className="font-medium">{techGroup}</TableCell>
                    <TableCell className="min-w-[14rem]">
                      <TechGroupRoleCell
                        entries={techGroupRoles(techGroup, "TECH_GROUP_ADMIN")}
                        users={users}
                        userOptions={userOptions}
                        techGroup={techGroup}
                        pending={pending}
                        onRemove={handleRemove}
                        onQuickAssign={handleQuickAssignTechGroup}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </section>

      <Card id="users" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>用户与角色</CardTitle>
          <CardDescription>
            手动分配全局角色或范围角色；用户表展示当前角色并支持快速移除
          </CardDescription>
        </CardHeader>
        <CardContent className="min-w-0 space-y-6">
          <div className="grid min-w-0 gap-3 sm:grid-cols-[12rem_10rem_8rem_auto] sm:items-end">
            <div className="space-y-2">
              <p className="h-5 text-sm font-medium leading-5">用户</p>
              <UserSearchSelect
                users={userOptions}
                value={assignOpenId}
                onChange={setAssignOpenId}
                className="w-full"
              />
            </div>
            <div className="space-y-2">
              <p className="h-5 text-sm font-medium leading-5">角色</p>
              <div>
                <Select
                  value={assignRole}
                  onValueChange={(v) =>
                    setAssignRole((v as UserRoleType) ?? "")
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue>
                      {(value) =>
                        roleLabels[value as keyof typeof roleLabels] ??
                        "选择角色"
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="SUPER_ADMIN">
                      {roleLabels.SUPER_ADMIN}
                    </SelectItem>
                    <SelectItem value="TEACHER">
                      {roleLabels.TEACHER}
                    </SelectItem>
                    <SelectItem value="TEAM_ADMIN">
                      {roleLabels.TEAM_ADMIN}
                    </SelectItem>
                    <SelectItem value="TECH_GROUP_ADMIN">
                      {roleLabels.TECH_GROUP_ADMIN}
                    </SelectItem>
                    <SelectItem value="FINANCE">
                      {roleLabels.FINANCE}
                    </SelectItem>
                    <SelectItem value="PROJECT_MANAGER">
                      {roleLabels.PROJECT_MANAGER}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              {assignRole === "TEAM_ADMIN" || assignRole === "FINANCE" ? (
                <>
                  <p className="h-5 text-sm font-medium leading-5">车组</p>
                  <div>
                    <Select
                      value={assignTeam}
                      onValueChange={(v) => setAssignTeam(v ?? "")}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue>
                          {(value) => (value ? String(value) : "选择车组")}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {TEAM_OPTIONS.map((team) => (
                          <SelectItem key={team} value={team}>
                            {team}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </>
              ) : assignRole === "TECH_GROUP_ADMIN" ? (
                <>
                  <p className="h-5 text-sm font-medium leading-5">技术组</p>
                  <div>
                    <Select
                      value={assignTechGroup}
                      onValueChange={(v) => setAssignTechGroup(v ?? "")}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue>
                          {(value) => (value ? String(value) : "选择技术组")}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {TECH_GROUP_OPTIONS.map((group) => (
                          <SelectItem key={group} value={group}>
                            {group}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </>
              ) : (
                <div className="hidden h-[3.25rem] sm:block" />
              )}
            </div>
            <Button
              className="w-full sm:w-auto"
              onClick={handleAssign}
              disabled={pending}
            >
              添加
            </Button>
          </div>

          {users.length === 0 ? (
            <div className="space-y-3 text-sm text-muted-foreground">
              <p>暂无用户，请先点击「同步飞书通讯录」</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>用户</TableHead>
                  <TableHead>openId</TableHead>
                  <TableHead>入库时间</TableHead>
                  <TableHead>当前角色</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {user.avatar && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={user.avatar}
                            alt={user.name}
                            className="h-8 w-8 rounded-full"
                          />
                        )}
                        <span>{user.name}</span>
                      </div>
                    </TableCell>
                    <TableCell className="max-w-[200px] truncate font-mono text-xs">
                      {user.openId}
                    </TableCell>
                    <TableCell>
                      {new Date(user.createdAt).toLocaleString("zh-CN")}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {(rolesByOpenId[user.openId] ?? []).map((role) => (
                          <Badge
                            key={role.id}
                            variant="secondary"
                            className="gap-1"
                          >
                            {formatRoleLabel(role)}
                            <button
                              type="button"
                              className="rounded hover:bg-muted"
                              aria-label={`移除 ${user.name} 的 ${formatRoleLabel(role)} 角色`}
                              disabled={pending}
                              onClick={() => handleRemove(role.id)}
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </Badge>
                        ))}
                        {(rolesByOpenId[user.openId] ?? []).length === 0 && (
                          <span className="text-sm text-muted-foreground">
                            无
                          </span>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card id="acceptance" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>常用验收条例</CardTitle>
          <CardDescription>
            任务创建/编辑时可快捷加入这些条例；删除模板不会影响已有任务。
          </CardDescription>
        </CardHeader>
        <CardContent className="min-w-0 space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={templateContent}
              onChange={(event) => setTemplateContent(event.target.value)}
              placeholder="例如：已确认关键数据/材料链接可访问"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleCreateAcceptanceTemplate();
                }
              }}
            />
            <Button
              type="button"
              className="sm:w-24"
              disabled={pending}
              onClick={handleCreateAcceptanceTemplate}
            >
              添加
            </Button>
          </div>

          {acceptanceChecklistTemplates.length === 0 ? (
            <p className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
              暂无常用验收条例，可先运行 seed 脚本或手动添加。
            </p>
          ) : (
            <div className="space-y-2">
              {acceptanceChecklistTemplates.map((template) => (
                <div
                  key={template.id}
                  className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
                >
                  <span className="min-w-0 break-words text-sm">
                    {template.content}
                  </span>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="outline"
                    aria-label="删除验收条例"
                    disabled={pending}
                    onClick={() => handleDeleteAcceptanceTemplate(template.id)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function UserChip({
  user,
  pending,
  onRemove,
}: {
  user?: AdminUser;
  pending: boolean;
  onRemove: () => void;
}) {
  const displayName = user?.name ?? "未知用户";

  return (
    <div className="inline-flex items-center gap-2 rounded-full border bg-background py-1 pl-1 pr-2 shadow-sm">
      {user?.avatar ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={user.avatar}
          alt={displayName}
          className="h-7 w-7 rounded-full object-cover"
        />
      ) : (
        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
          {displayName.slice(0, 1)}
        </div>
      )}
      <span className="max-w-[8rem] truncate text-sm">{displayName}</span>
      <button
        type="button"
        className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label={`移除 ${displayName} 的角色`}
        disabled={pending}
        onClick={onRemove}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function AdminMetric({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: AdminIcon;
  label: string;
  value: number;
  detail: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
        </div>
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="h-5 w-5" />
        </div>
      </div>
      <p className="mt-3 break-words text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function AdminNavLink({
  href,
  icon: Icon,
  label,
}: {
  href: string;
  icon: AdminIcon;
  label: string;
}) {
  return (
    <a
      href={href}
      className="flex h-10 min-w-0 items-center justify-center gap-2 rounded-lg border bg-background px-3 text-sm font-medium transition-colors hover:border-primary/30 hover:bg-muted"
    >
      <Icon className="h-4 w-4 text-muted-foreground" />
      <span className="truncate">{label}</span>
    </a>
  );
}

function SystemStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg border bg-background px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}

function TechGroupRoleCell({
  entries,
  users,
  userOptions,
  techGroup,
  pending,
  onRemove,
  onQuickAssign,
}: {
  entries: AdminRole[];
  users: AdminUser[];
  userOptions: UserOption[];
  techGroup: string;
  pending: boolean;
  onRemove: (id: string) => void;
  onQuickAssign: (openId: string, techGroup: string) => void;
}) {
  const [addOpenId, setAddOpenId] = useState("");

  function handleQuickAdd() {
    if (!addOpenId) return;
    onQuickAssign(addOpenId, techGroup);
    setAddOpenId("");
  }

  return (
    <div className="flex min-h-[2.5rem] items-center justify-between gap-4">
      <div className="flex shrink-0 items-center gap-1">
        <UserSearchSelect
          users={userOptions}
          value={addOpenId}
          onChange={setAddOpenId}
          placeholder="搜索添加"
          className="w-36"
          inputClassName="h-8 text-sm"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!addOpenId || pending}
          onClick={handleQuickAdd}
        >
          确定
        </Button>
      </div>
      <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
        {entries.map((entry) => (
          <UserChip
            key={entry.id}
            user={users.find((u) => u.openId === entry.openId)}
            pending={pending}
            onRemove={() => onRemove(entry.id)}
          />
        ))}
      </div>
    </div>
  );
}

function RoleCell({
  entries,
  users,
  userOptions,
  team,
  role,
  pending,
  onRemove,
  onQuickAssign,
}: {
  entries: AdminRole[];
  users: AdminUser[];
  userOptions: UserOption[];
  team: string;
  role: UserRoleType;
  pending: boolean;
  onRemove: (id: string) => void;
  onQuickAssign: (openId: string, role: UserRoleType, team: string) => void;
}) {
  const [addOpenId, setAddOpenId] = useState("");

  function handleQuickAdd() {
    if (!addOpenId) return;
    onQuickAssign(addOpenId, role, team);
    setAddOpenId("");
  }

  return (
    <div className="flex min-h-[2.5rem] items-center justify-between gap-4">
      <div className="flex shrink-0 items-center gap-1">
        <UserSearchSelect
          users={userOptions}
          value={addOpenId}
          onChange={setAddOpenId}
          placeholder="搜索添加"
          className="w-36"
          inputClassName="h-8 text-sm"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!addOpenId || pending}
          onClick={handleQuickAdd}
        >
          确定
        </Button>
      </div>
      <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
        {entries.map((entry) => (
          <UserChip
            key={entry.id}
            user={users.find((u) => u.openId === entry.openId)}
            pending={pending}
            onRemove={() => onRemove(entry.id)}
          />
        ))}
      </div>
    </div>
  );
}
