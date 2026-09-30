import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma";
import { createAccountPerson, createTask, grantGlobalProjectAdministrator } from "./project-management-canvas-security-fixtures";

export async function createLinkPreviewFixtures(name = `链接预览 ${randomUUID()}`) {
  const administrator = await createAccountPerson(`预览测试审批管理员 ${randomUUID()}`);
  await grantGlobalProjectAdministrator(administrator.account.id);
  const owner = await createAccountPerson(`私有成员 ${randomUUID()}`);
  const privateDescription = `私有业务描述 ${randomUUID()}`;
  const privateReview = `私有审批意见 ${randomUUID()}`;
  const avatarPath = `/uploads/private-preview-${randomUUID()}.png`;
  const project = await prisma.project.create({
    data: {
      name, description: privateDescription, reviewComment: privateReview, avatarPath,
      requesterAccountId: owner.account.id, status: "ACTIVE",
      members: { create: { personId: owner.person.id, role: "OWNER", createdByAccountId: owner.account.id } },
    },
  });
  const task = await createTask({
    ownerAccountId: owner.account.id, title: name, team: "英雄", techGroup: "电控",
    members: [{ personId: owner.person.id, role: "OWNER" }],
  });
  await prisma.task.update({
    where: { id: task.taskId }, data: { description: privateDescription, projectId: project.id },
  });
  const privateMinutes = `私有会议内容 ${randomUUID()}`;
  const meeting = await prisma.meetingRecord.create({
    data: {
      topic: name, minutes: privateMinutes, createdByAccountId: owner.account.id,
      rangeStart: new Date("2026-09-01T00:00:00.000Z"), rangeEnd: new Date("2026-09-02T00:00:00.000Z"),
      timelineDisplay: { projectIds: [project.id], taskIds: [task.taskId] },
      participants: { create: { personId: owner.person.id } },
    },
  });
  return {
    owner, project, task, meeting, name,
    privateMarkers: [privateDescription, privateReview, avatarPath, owner.person.displayName, "S2 canvas query fixture", privateMinutes],
  };
}
