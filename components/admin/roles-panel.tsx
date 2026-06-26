"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import type { UserRoleType } from "@prisma/client";
import { toast } from "sonner";
import { assignUserRole, removeUserRole } from "@/app/actions/adminRoles";
import type { AdminRole, AdminUser } from "@/components/admin/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { UserSearchSelect } from "@/components/user-search-select";
import { TEAM_OPTIONS, TECH_GROUP_OPTIONS } from "@/lib/constants";
import { formatRoleLabel, roleLabels } from "@/lib/permissions-client";

type UserOption = {
  openId: string;
  name: string;
  avatar: string | null;
};

export function RolesPanel({
  users,
  roles,
}: {
  users: AdminUser[];
  roles: AdminRole[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [assignOpenId, setAssignOpenId] = useState("");
  const [assignRole, setAssignRole] = useState<UserRoleType | "">("");
  const [assignTeam, setAssignTeam] = useState("");
  const [assignTechGroup, setAssignTechGroup] = useState("");

  const userOptions = useMemo(
    () =>
      users.map((user) => ({
        openId: user.openId,
        name: user.name,
        avatar: user.avatar,
      })),
    [users],
  );
  const rolesByOpenId = useMemo(
    () =>
      roles.reduce<Record<string, AdminRole[]>>((acc, role) => {
        if (!acc[role.openId]) acc[role.openId] = [];
        acc[role.openId].push(role);
        return acc;
      }, {}),
    [roles],
  );

  function teamRoles(team: string, role: UserRoleType) {
    return roles.filter((entry) => entry.team === team && entry.role === role);
  }

  function techGroupRoles(techGroup: string, role: UserRoleType) {
    return roles.filter(
      (entry) => entry.techGroup === techGroup && entry.role === role,
    );
  }

  function handleAssign() {
    if (!assignOpenId || !assignRole) {
      toast.error("请选择用户和角色");
      return;
    }
    if (assignRole === "TEAM_ADMIN" && !assignTeam) {
      toast.error("请选择车组");
      return;
    }
    if (
      (assignRole === "TECH_GROUP_ADMIN" ||
        assignRole === "TEACHER" ||
        assignRole === "FINANCE") &&
      !assignTechGroup
    ) {
      toast.error("请选择技术组");
      return;
    }

    startTransition(async () => {
      try {
        await assignUserRole({
          openId: assignOpenId,
          role: assignRole,
          team: assignRole === "TEAM_ADMIN" ? assignTeam : undefined,
          techGroup:
            assignRole === "TECH_GROUP_ADMIN" ||
            assignRole === "TEACHER" ||
            assignRole === "FINANCE"
              ? assignTechGroup
              : undefined,
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

  function handleQuickAssignTechGroup(
    openId: string,
    techGroup: string,
    role: UserRoleType,
  ) {
    startTransition(async () => {
      try {
        await assignUserRole({ openId, role, techGroup });
        toast.success("已添加");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "添加失败");
      }
    });
  }

  return (
    <div className="min-w-0 space-y-6">
      <section className="min-w-0 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>车组职责配置</CardTitle>
            <CardDescription>
              为每个车组指定组长；用户需先飞书登录本系统。
            </CardDescription>
          </CardHeader>
          <CardContent className="min-w-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>车组</TableHead>
                  <TableHead>组长</TableHead>
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
              为每个技术组指定组长、指导老师与报销员，参与审批与报销流程。
            </CardDescription>
          </CardHeader>
          <CardContent className="min-w-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>技术组</TableHead>
                  <TableHead>组长</TableHead>
                  <TableHead>指导老师</TableHead>
                  <TableHead>报销员</TableHead>
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
                        role="TECH_GROUP_ADMIN"
                        pending={pending}
                        onRemove={handleRemove}
                        onQuickAssign={handleQuickAssignTechGroup}
                      />
                    </TableCell>
                    <TableCell className="min-w-[14rem]">
                      <TechGroupRoleCell
                        entries={techGroupRoles(techGroup, "TEACHER")}
                        users={users}
                        userOptions={userOptions}
                        techGroup={techGroup}
                        role="TEACHER"
                        pending={pending}
                        onRemove={handleRemove}
                        onQuickAssign={handleQuickAssignTechGroup}
                      />
                    </TableCell>
                    <TableCell className="min-w-[14rem]">
                      <TechGroupRoleCell
                        entries={techGroupRoles(techGroup, "FINANCE")}
                        users={users}
                        userOptions={userOptions}
                        techGroup={techGroup}
                        role="FINANCE"
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

      <Card>
        <CardHeader>
          <CardTitle>用户与角色</CardTitle>
          <CardDescription>
            手动分配全局角色或范围角色；用户表展示当前角色并支持快速移除。
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
              <Select
                value={assignRole}
                onValueChange={(value) =>
                  setAssignRole((value as UserRoleType) ?? "")
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue>
                    {(value) =>
                      roleLabels[value as keyof typeof roleLabels] ?? "选择角色"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(roleLabels).map(([role, label]) => (
                    <SelectItem key={role} value={role}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <RoleScopeSelect
              assignRole={assignRole}
              assignTeam={assignTeam}
              assignTechGroup={assignTechGroup}
              onTeamChange={setAssignTeam}
              onTechGroupChange={setAssignTechGroup}
            />
            <Button
              className="w-full sm:w-auto"
              type="button"
              onClick={handleAssign}
              disabled={pending}
            >
              添加
            </Button>
          </div>

          {users.length === 0 ? (
            <p className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
              暂无用户，请先在系统同步页同步飞书通讯录。
            </p>
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
                        <UserAvatar user={user} />
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
    </div>
  );
}

function RoleScopeSelect({
  assignRole,
  assignTeam,
  assignTechGroup,
  onTeamChange,
  onTechGroupChange,
}: {
  assignRole: UserRoleType | "";
  assignTeam: string;
  assignTechGroup: string;
  onTeamChange: (value: string) => void;
  onTechGroupChange: (value: string) => void;
}) {
  if (assignRole === "TEAM_ADMIN") {
    return (
      <div className="space-y-2">
        <p className="h-5 text-sm font-medium leading-5">车组</p>
        <Select
          value={assignTeam}
          onValueChange={(value) => onTeamChange(value ?? "")}
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
    );
  }

  if (
    assignRole === "TECH_GROUP_ADMIN" ||
    assignRole === "TEACHER" ||
    assignRole === "FINANCE"
  ) {
    return (
      <div className="space-y-2">
        <p className="h-5 text-sm font-medium leading-5">技术组</p>
        <Select
          value={assignTechGroup}
          onValueChange={(value) => onTechGroupChange(value ?? "")}
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
    );
  }

  return <div className="hidden h-[3.25rem] sm:block" />;
}

function TechGroupRoleCell({
  entries,
  users,
  userOptions,
  techGroup,
  role,
  pending,
  onRemove,
  onQuickAssign,
}: {
  entries: AdminRole[];
  users: AdminUser[];
  userOptions: UserOption[];
  techGroup: string;
  role: UserRoleType;
  pending: boolean;
  onRemove: (id: string) => void;
  onQuickAssign: (
    openId: string,
    techGroup: string,
    role: UserRoleType,
  ) => void;
}) {
  const [addOpenId, setAddOpenId] = useState("");

  function handleQuickAdd() {
    if (!addOpenId) return;
    onQuickAssign(addOpenId, techGroup, role);
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
            user={users.find((item) => item.openId === entry.openId)}
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
            user={users.find((item) => item.openId === entry.openId)}
            pending={pending}
            onRemove={() => onRemove(entry.id)}
          />
        ))}
      </div>
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
      <UserAvatar user={user} />
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

function UserAvatar({ user }: { user?: Pick<AdminUser, "avatar" | "name"> }) {
  const displayName = user?.name ?? "未知";
  if (user?.avatar) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={user.avatar}
        alt={displayName}
        className="h-7 w-7 rounded-full object-cover"
      />
    );
  }

  return (
    <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
      {displayName.slice(0, 1)}
    </div>
  );
}
