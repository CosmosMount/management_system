import type { Prisma, TaskMemberRole } from "@prisma/client";
import {
  DEFAULT_FEISHU_IDENTITY_WHERE,
  FEISHU_OPEN_IDENTITY_ORDER,
  FEISHU_OPEN_IDENTITY_SELECT,
  firstNonEmptyFeishuOpenId,
} from "@/lib/project-management/application/feishu-identity";
import { createProjectManagementEventNotificationsTx } from "@/lib/project-management/application/notification-utils";
import type { TaskForMutation } from "@/lib/project-management/application/task-mutation-records";
import type { ProjectManagementActor } from "@/lib/project-management/identity";
import { taskMemberChangeSummary } from "@/lib/project-management/notifications/user-facing-copy";

type PrismaTx = Prisma.TransactionClient;

export type MemberChange = {
  personId: string;
  beforeRoles: TaskMemberRole[];
  afterRoles: TaskMemberRole[];
  kind: "ADDED" | "REMOVED" | "ROLES_CHANGED";
};

export function calculateMemberChanges(
  currentMembers: Array<{ personId: string; role: TaskMemberRole }>,
  requestedMembers: Array<{ personId: string; role: TaskMemberRole }>,
): MemberChange[] {
  const before = rolesByPerson(currentMembers);
  const after = rolesByPerson(requestedMembers);
  const personIds = new Set([...before.keys(), ...after.keys()]);
  return [...personIds]
    .sort()
    .flatMap((personId) => {
      const beforeRoles = before.get(personId) ?? [];
      const afterRoles = after.get(personId) ?? [];
      if (sameStringArray(beforeRoles, afterRoles)) return [];
      return [
        {
          personId,
          beforeRoles,
          afterRoles,
          kind:
            beforeRoles.length === 0
              ? "ADDED"
              : afterRoles.length === 0
                ? "REMOVED"
                : "ROLES_CHANGED",
        } satisfies MemberChange,
      ];
    });
}

export async function notifyActiveMemberChangesTx(
  tx: PrismaTx,
  input: {
    actor: ProjectManagementActor;
    task: TaskForMutation;
    lockVersion: number;
    changes: MemberChange[];
  },
) {
  const actorName = await actorDisplayNameTx(tx, input.actor);
  for (const change of input.changes) {
    const recipientResolution = await resolveMandatoryMemberRecipientTx(
      tx,
      change.personId,
    );
    await createProjectManagementEventNotificationsTx(tx, {
      actor: input.actor,
      task: {
        id: input.task.id,
        title: input.task.title,
        status: "ACTIVE",
        currentPlanVersionId: input.task.currentPlanVersionId,
      },
      kind: "task_assigned",
      category: "TASK",
      eventKey: `pm:task:member_changed:${input.task.id}:${input.lockVersion}:${change.personId}`,
      title: "任务成员已变更",
      summary: taskMemberChangeSummary({
        actorName,
        taskTitle: input.task.title,
        changeKind: change.kind,
        beforeRoles: change.beforeRoles,
        afterRoles: change.afterRoles,
      }),
      entityType: "Task",
      entityId: input.task.id,
      linkPath: "/progress",
      mandatory: true,
      recipients: recipientResolution.recipients,
      context: {
        changeKind: change.kind,
        affectedPersonId: change.personId,
        beforeRoles: change.beforeRoles,
        afterRoles: change.afterRoles,
        result: "SUCCESS",
        taskLockVersion: input.lockVersion,
        recipientResolution: recipientResolution.status,
      },
    });
  }
}

async function resolveMandatoryMemberRecipientTx(
  tx: PrismaTx,
  personId: string,
): Promise<{
  status:
    | "RESOLVED"
    | "PERSON_INACTIVE"
    | "ACCOUNT_MISSING"
    | "DEFAULT_FEISHU_IDENTITY_MISSING"
    | "FEISHU_OPEN_ID_MISSING";
  recipients: Array<{ accountId: string; openId: string | null }>;
}> {
  const person = await tx.person.findUnique({
    where: { id: personId },
    select: {
      status: true,
      account: {
        select: {
          id: true,
          identities: {
            where: DEFAULT_FEISHU_IDENTITY_WHERE,
            select: FEISHU_OPEN_IDENTITY_SELECT,
            orderBy: FEISHU_OPEN_IDENTITY_ORDER,
          },
        },
      },
    },
  });
  if (!person?.account) {
    return { status: "ACCOUNT_MISSING", recipients: [] };
  }
  const openId = firstNonEmptyFeishuOpenId(person.account.identities);
  const status =
    person.status !== "ACTIVE"
      ? "PERSON_INACTIVE"
      : person.account.identities.length === 0
        ? "DEFAULT_FEISHU_IDENTITY_MISSING"
        : !openId
          ? "FEISHU_OPEN_ID_MISSING"
          : "RESOLVED";
  return {
    status,
    recipients: [
      {
        accountId: person.account.id,
        openId: status === "RESOLVED" ? openId : null,
      },
    ],
  };
}

async function actorDisplayNameTx(
  tx: PrismaTx,
  actor: ProjectManagementActor,
) {
  const person = await tx.person.findUnique({
    where: { id: actor.personId },
    select: { displayName: true },
  });
  return person?.displayName ?? "系统用户";
}

function rolesByPerson(
  members: Array<{ personId: string; role: TaskMemberRole }>,
) {
  const result = new Map<string, TaskMemberRole[]>();
  for (const member of members) {
    const roles = result.get(member.personId) ?? [];
    roles.push(member.role);
    result.set(member.personId, roles);
  }
  for (const roles of result.values()) roles.sort();
  return result;
}

function sameStringArray(left: string[], right: string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
