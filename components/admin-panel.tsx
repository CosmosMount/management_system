"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RefreshCw, X } from "lucide-react";
import type { UserRoleType } from "@prisma/client";
import {
  assignUserRole,
  removeUserRole,
} from "@/app/actions/adminRoles";
import { syncFeishuUsers } from "@/app/actions/syncFeishuUsers";
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

type Props = {
  users: AdminUser[];
  roles: AdminRole[];
};

export function AdminPanel({ users, roles }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [assignOpenId, setAssignOpenId] = useState("");
  const [assignRole, setAssignRole] = useState<UserRoleType | "">("");
  const [assignTeam, setAssignTeam] = useState("");
  const [assignTechGroup, setAssignTechGroup] = useState("");

  const rolesByOpenId = roles.reduce<Record<string, AdminRole[]>>((acc, role) => {
    if (!acc[role.openId]) acc[role.openId] = [];
    acc[role.openId].push(role);
    return acc;
  }, {});

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

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>车组组长配置</CardTitle>
          <CardDescription>
            为每个车组指定组长与报销员；用户需先飞书登录本系统
          </CardDescription>
        </CardHeader>
        <CardContent>
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
                  <TableCell>
                    <RoleCell
                      entries={teamRoles(team, "TEAM_ADMIN")}
                      users={users}
                      team={team}
                      role="TEAM_ADMIN"
                      pending={pending}
                      onRemove={handleRemove}
                      onQuickAssign={handleQuickAssign}
                    />
                  </TableCell>
                  <TableCell>
                    <RoleCell
                      entries={teamRoles(team, "FINANCE")}
                      users={users}
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
          <CardTitle>技术组组长配置</CardTitle>
          <CardDescription>
            为每个技术组指定组长，参与管理审核（与车组组长分别私信通知）
          </CardDescription>
        </CardHeader>
        <CardContent>
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
                  <TableCell>
                    <TechGroupRoleCell
                      entries={techGroupRoles(techGroup, "TECH_GROUP_ADMIN")}
                      users={users}
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

      <Card>
        <CardHeader>
          <CardTitle>分配角色</CardTitle>
          <CardDescription>
            超级管理员可管理全部角色；指导老师为全局审批角色
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="space-y-2">
            <p className="text-sm font-medium">用户</p>
            <Select
              value={assignOpenId}
              onValueChange={(v) => setAssignOpenId(v ?? "")}
            >
              <SelectTrigger className="w-48">
                <SelectValue placeholder="选择用户" />
              </SelectTrigger>
              <SelectContent>
                {users.map((user) => (
                  <SelectItem key={user.openId} value={user.openId}>
                    {user.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium">角色</p>
            <Select
              value={assignRole}
              onValueChange={(v) => setAssignRole((v as UserRoleType) ?? "")}
            >
              <SelectTrigger className="w-40">
                <SelectValue placeholder="选择角色" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="SUPER_ADMIN">
                  {roleLabels.SUPER_ADMIN}
                </SelectItem>
                <SelectItem value="TEACHER">{roleLabels.TEACHER}</SelectItem>
                <SelectItem value="TEAM_ADMIN">
                  {roleLabels.TEAM_ADMIN}
                </SelectItem>
                <SelectItem value="TECH_GROUP_ADMIN">
                  {roleLabels.TECH_GROUP_ADMIN}
                </SelectItem>
                <SelectItem value="FINANCE">{roleLabels.FINANCE}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {(assignRole === "TEAM_ADMIN" || assignRole === "FINANCE") && (
            <div className="space-y-2">
              <p className="text-sm font-medium">车组</p>
              <Select
                value={assignTeam}
                onValueChange={(v) => setAssignTeam(v ?? "")}
              >
                <SelectTrigger className="w-32">
                  <SelectValue placeholder="选择车组" />
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
          )}
          {assignRole === "TECH_GROUP_ADMIN" && (
            <div className="space-y-2">
              <p className="text-sm font-medium">技术组</p>
              <Select
                value={assignTechGroup}
                onValueChange={(v) => setAssignTechGroup(v ?? "")}
              >
                <SelectTrigger className="w-32">
                  <SelectValue placeholder="选择技术组" />
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
          )}
          <Button onClick={handleAssign} disabled={pending}>
            添加
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>人员列表</CardTitle>
            <CardDescription>
              可从飞书通讯录同步全员，无需对方先登录；登录过的用户会更新资料
            </CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={handleSyncFeishu}
          >
            <RefreshCw className="mr-1 h-4 w-4" />
            同步飞书通讯录
          </Button>
        </CardHeader>
        <CardContent>
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

function TechGroupRoleCell({
  entries,
  users,
  techGroup,
  pending,
  onRemove,
  onQuickAssign,
}: {
  entries: AdminRole[];
  users: AdminUser[];
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
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {entries.map((entry) => (
          <Badge key={entry.id} variant="outline" className="gap-1">
            {users.find((u) => u.openId === entry.openId)?.name ?? entry.openId}
            <button
              type="button"
              className="rounded hover:bg-muted"
              disabled={pending}
              onClick={() => onRemove(entry.id)}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
      </div>
      <div className="flex gap-1">
        <Select
          value={addOpenId}
          onValueChange={(v) => setAddOpenId(v ?? "")}
        >
          <SelectTrigger className="h-7 w-28" size="sm">
            <SelectValue placeholder="添加" />
          </SelectTrigger>
          <SelectContent>
            {users.map((user) => (
              <SelectItem key={user.openId} value={user.openId}>
                {user.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
    </div>
  );
}

function RoleCell({
  entries,
  users,
  team,
  role,
  pending,
  onRemove,
  onQuickAssign,
}: {
  entries: AdminRole[];
  users: AdminUser[];
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
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {entries.map((entry) => (
          <Badge key={entry.id} variant="outline" className="gap-1">
            {users.find((u) => u.openId === entry.openId)?.name ?? entry.openId}
            <button
              type="button"
              className="rounded hover:bg-muted"
              disabled={pending}
              onClick={() => onRemove(entry.id)}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
      </div>
      <div className="flex gap-1">
        <Select
          value={addOpenId}
          onValueChange={(v) => setAddOpenId(v ?? "")}
        >
          <SelectTrigger className="h-7 w-28" size="sm">
            <SelectValue placeholder="添加" />
          </SelectTrigger>
          <SelectContent>
            {users.map((user) => (
              <SelectItem key={user.openId} value={user.openId}>
                {user.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
    </div>
  );
}
