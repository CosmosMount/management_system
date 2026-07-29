import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import {
  activateTask,
  createTaskDraft,
} from "../lib/project-management/application/lifecycle-service";
import {
  createActualSegment,
  createWorkSegment,
  movePlannedSegments,
} from "../lib/project-management/application/segment-service";
import {
  acknowledgeConflict,
  applyConflictSuggestion,
  ignoreConflict,
  previewConflictSuggestion,
  resolveConflict,
  scanConflictsForPerson,
  scanResourceConflictsForDefaultWindow,
} from "../lib/project-management/application/conflict-service";
import {
  getResourceConflict,
  listResourceConflicts,
} from "../lib/project-management/queries/resource-queries";
import {
  toProjectManagementServiceError,
} from "../lib/project-management/application/errors";
import type { ProjectManagementActor } from "../lib/project-management/identity";

test.describe("project management P5 resource conflict services", () => {
  test("Allocation scanner uses half-open intervals and opens conflicts only above 100%", async () => {
    const fixture = await createActivatedFixture();
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 10, 50),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 10, 11, 50),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    const noConflict = await scanConflictsForPerson({
      personId: fixture.member.person.id,
      startAt: atHour(9),
      endAt: atHour(11),
    });
    expect(noConflict.createdCount).toBe(0);

    const overlapA = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 12, 13, 50.01),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    const overlapB = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 12.5, 13.5, 50),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    const scan = await scanConflictsForPerson({
      personId: fixture.member.person.id,
      startAt: atHour(12),
      endAt: atHour(14),
    });
    expect(scan.createdCount).toBe(1);
    const conflict = await prisma.resourceConflict.findFirstOrThrow({
      where: {
        personId: fixture.member.person.id,
        kind: "ALLOCATION_OVER_LIMIT",
        segments: {
          every: {
            segmentId: { in: [overlapA.segment.id, overlapB.segment.id] },
          },
        },
      },
      include: { segments: true },
    });
    expect(conflict.startAt.toISOString()).toBe(atHour(12.5).toISOString());
    expect(conflict.endAt.toISOString()).toBe(atHour(13).toISOString());
    await expectProjectManagementOutbox(
      `pm:conflict:opened:${conflict.fingerprint}:feishu`,
      "resource_conflict_opened",
    );
  });

  test("Conflict opened notification recipients only come from involved segments", async () => {
    const fixture = await createActivatedFixture();
    const unrelatedTask = await createActivatedFixture({
      member: fixture.member,
      title: "P5 Unrelated Recipient Task",
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 10, 70),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9.25, 10, 60),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 10, 11, 20),
      taskId: unrelatedTask.taskId,
      nodeId: unrelatedTask.activeNodeId,
    });

    await scanConflictsForPerson({
      personId: fixture.member.person.id,
      startAt: atHour(9),
      endAt: atHour(11),
    });
    const conflict = await prisma.resourceConflict.findFirstOrThrow({
      where: {
        personId: fixture.member.person.id,
        kind: "ALLOCATION_OVER_LIMIT",
      },
    });
    const outbox = await prisma.notificationOutbox.findUniqueOrThrow({
      where: { eventKey: `pm:conflict:opened:${conflict.fingerprint}:feishu` },
      select: { payload: true },
    });
    const payload = JSON.parse(outbox.payload) as { recipientOpenIds?: string[] };
    expect(payload.recipientOpenIds ?? []).not.toContain(unrelatedTask.owner.openId);
  });

  test("Scanner detects missing allocation, priority, lead role, revision and actual overload rules", async () => {
    const fixture = await createActivatedFixture();
    const otherTask = await createActivatedFixture({
      member: fixture.member,
      title: "P5 Conflict Other Task",
    });

    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 10, null),
      content: "未填写 Allocation A",
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9.25, 10.25, null),
      content: "未填写 Allocation B",
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 11, 12, 20),
      priority: "CRITICAL",
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 11.5, 12.5, 20),
      priority: "HIGH",
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 13, 14, 20),
      role: "OWNER",
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 13.5, 14.5, 20),
      role: "LEAD",
      taskId: otherTask.taskId,
      nodeId: otherTask.activeNodeId,
    });
    const revisionAffected = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 15, 16, 20),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await prisma.workSegment.update({
      where: { id: revisionAffected.segment.id },
      data: { associationNeedsReview: true },
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 15.5, 16.5, 20),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createActualSegment(actor(fixture.member), {
      personId: fixture.member.person.id,
      startAt: atHour(17),
      endAt: atHour(18),
      content: "Actual A",
      allocation: 70,
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createActualSegment(actor(fixture.member), {
      personId: fixture.member.person.id,
      startAt: atHour(17.25),
      endAt: atHour(18.25),
      content: "Actual B",
      allocation: 60,
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });

    await scanConflictsForPerson({
      personId: fixture.member.person.id,
      startAt: atHour(8),
      endAt: atHour(19),
    });
    const kinds = await prisma.resourceConflict.findMany({
      where: { personId: fixture.member.person.id },
      select: { kind: true },
      distinct: ["kind"],
    });
    expect(kinds.map((item) => item.kind).sort()).toEqual(
      expect.arrayContaining([
        "ACTUAL_OVERLOAD",
        "HIGH_PRIORITY_OVERLAP",
        "LEAD_ROLE_OVERLAP",
        "MISSING_ALLOCATION",
        "REVISION_OVERLAP",
      ]),
    );
  });

  test("Scanner merges continuous slices with the same conflict semantics", async () => {
    const fixture = await createActivatedFixture();
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 12, 20),
      priority: "HIGH",
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 12, 20),
      priority: "CRITICAL",
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 10, 11, 20),
      content: "只贡献切片边界的普通计划",
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });

    await scanConflictsForPerson({
      personId: fixture.member.person.id,
      startAt: atHour(9),
      endAt: atHour(12),
    });
    const conflicts = await prisma.resourceConflict.findMany({
      where: {
        personId: fixture.member.person.id,
        kind: "HIGH_PRIORITY_OVERLAP",
      },
      select: { startAt: true, endAt: true },
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.startAt.toISOString()).toBe(atHour(9).toISOString());
    expect(conflicts[0]?.endAt.toISOString()).toBe(atHour(12).toISOString());
  });

  test("Default window scans keep long-running conflict fingerprints stable", async () => {
    const fixture = await createActivatedFixture();
    const startAt = new Date(Date.UTC(2026, 7, 1, 9, 0, 0));
    const endAt = new Date(Date.UTC(2026, 7, 20, 9, 0, 0));
    await createWorkSegment(actor(fixture.member), {
      personId: fixture.member.person.id,
      type: "PLANNED",
      startAt,
      endAt,
      content: "跨扫描窗口计划 A",
      allocation: 70,
      role: "DEVELOPER",
      priority: "MEDIUM",
      tagIds: [],
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createWorkSegment(actor(fixture.member), {
      personId: fixture.member.person.id,
      type: "PLANNED",
      startAt,
      endAt,
      content: "跨扫描窗口计划 B",
      allocation: 60,
      role: "DEVELOPER",
      priority: "MEDIUM",
      tagIds: [],
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });

    await scanResourceConflictsForDefaultWindow(
      new Date(Date.UTC(2026, 7, 11, 0, 0, 0)),
    );
    const firstConflict = await prisma.resourceConflict.findFirstOrThrow({
      where: {
        personId: fixture.member.person.id,
        kind: "ALLOCATION_OVER_LIMIT",
      },
      select: { fingerprint: true, startAt: true, endAt: true },
    });
    await scanResourceConflictsForDefaultWindow(
      new Date(Date.UTC(2026, 7, 12, 0, 0, 0)),
    );
    const conflicts = await prisma.resourceConflict.findMany({
      where: {
        personId: fixture.member.person.id,
        kind: "ALLOCATION_OVER_LIMIT",
      },
      select: { fingerprint: true, startAt: true, endAt: true },
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.fingerprint).toBe(firstConflict.fingerprint);
    expect(conflicts[0]?.startAt.toISOString()).toBe(startAt.toISOString());
    expect(conflicts[0]?.endAt.toISOString()).toBe(endAt.toISOString());
  });

  test("Conflict details only expose segments readable by the actor", async () => {
    const fixture = await createActivatedFixture();
    const otherTask = await createActivatedFixture({
      member: fixture.member,
      title: "P5 Hidden Conflict Task",
    });
    const visibleSegment = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 10, 70),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    const hiddenSegment = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9.25, 10.25, 60),
      taskId: otherTask.taskId,
      nodeId: otherTask.activeNodeId,
    });
    await scanConflictsForPerson({
      personId: fixture.member.person.id,
      startAt: atHour(9),
      endAt: atHour(11),
    });
    const conflict = await prisma.resourceConflict.findFirstOrThrow({
      where: { personId: fixture.member.person.id, kind: "ALLOCATION_OVER_LIMIT" },
    });

    const detail = await getResourceConflict({
      actor: actor(fixture.owner),
      input: { conflictId: conflict.id },
    });
    expect(detail.segments).toHaveLength(1);
    expect(detail.segments[0]?.id).toBe(visibleSegment.segment.id);
    expect(detail.hiddenSegmentCount).toBe(1);
    expect(detail.capabilities).toEqual({
      canAcknowledge: false,
      canResolve: false,
      canIgnore: false,
      canPreviewSuggestion: false,
      canApplySuggestion: false,
    });
    const explanation = detail.explanation as {
      hiddenSegmentCount?: number;
      segments?: Array<{ id: string }>;
    };
    expect(explanation.hiddenSegmentCount).toBe(1);
    expect(explanation.segments?.map((segment) => segment.id)).toEqual([
      visibleSegment.segment.id,
    ]);
    const serializedDetail = JSON.stringify(detail);
    expect(serializedDetail).not.toContain(hiddenSegment.segment.id);
    expect(serializedDetail).not.toContain(hiddenSegment.segment.updatedAt);
    expect(serializedDetail).not.toContain(hiddenSegment.segment.content);
    expect(serializedDetail).not.toContain(otherTask.taskId);
    expect(serializedDetail).not.toContain(hiddenSegment.segment.endAt);

    await expectServiceError(
      previewConflictSuggestion(actor(fixture.owner), {
        conflictId: conflict.id,
      }),
      "STATE_CONFLICT",
    );
    await expectServiceError(
      previewConflictSuggestion(actor(fixture.member), {
        conflictId: conflict.id,
      }),
      "STATE_CONFLICT",
    );
    const managerPreview = await previewConflictSuggestion(
      actor(fixture.resourceManager),
      { conflictId: conflict.id },
    );
    expect(managerPreview.suggestions[0]?.moves).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ segmentId: hiddenSegment.segment.id }),
      ]),
    );

    const hiddenMarkers = [
      `hidden-id=${hiddenSegment.segment.id}`,
      `hidden-content=${hiddenSegment.segment.content}`,
      `hidden-task=${otherTask.taskId}`,
      `hidden-start=${hiddenSegment.segment.startAt}`,
      `hidden-end=${hiddenSegment.segment.endAt}`,
      `hidden-version=${hiddenSegment.segment.updatedAt}`,
    ];
    const sensitiveHandlingText = hiddenMarkers.join(" | ");
    await resolveConflict(actor(fixture.resourceManager), {
      conflictId: conflict.id,
      resolutionNote: sensitiveHandlingText,
      changedSegmentIds: [visibleSegment.segment.id, hiddenSegment.segment.id],
    });
    const resolvedDetail = await getResourceConflict({
      actor: actor(fixture.owner),
      input: { conflictId: conflict.id },
    });
    const resolvedExplanation = resolvedDetail.explanation as {
      changedSegmentIds?: string[];
    };
    expect(resolvedExplanation.changedSegmentIds).toEqual([
      visibleSegment.segment.id,
    ]);
    expect(resolvedDetail.resolutionNote).toBe("处理说明涉及不可见记录，已隐藏");
    expect(resolvedExplanation).toMatchObject({
      resolutionNote: "处理说明涉及不可见记录，已隐藏",
    });
    const resolvedViewerList = await listResourceConflicts({
      actor: actor(fixture.viewer),
      input: { personId: fixture.member.person.id },
    });
    const resolvedViewerListItem = resolvedViewerList.items.find(
      (item) => item.id === conflict.id,
    );
    if (!resolvedViewerListItem) throw new Error("列表缺少目标资源冲突");
    for (const partialDto of [resolvedDetail, resolvedViewerListItem]) {
      const serialized = JSON.stringify(partialDto);
      for (const marker of hiddenMarkers) expect(serialized).not.toContain(marker);
    }
    const fullResolvedDetail = await getResourceConflict({
      actor: actor(fixture.resourceManager, [
        { role: "RESOURCE_MANAGER", team: "英雄", techGroup: "电控" },
      ]),
      input: { conflictId: conflict.id },
    });
    expect(fullResolvedDetail.resolutionNote).toBe(sensitiveHandlingText);
    expect(fullResolvedDetail.explanation).toMatchObject({
      resolutionNote: sensitiveHandlingText,
    });

    await prisma.resourceConflict.update({
      where: { id: conflict.id },
      data: { status: "OPEN", resolvedAt: null },
    });
    await ignoreConflict(actor(fixture.resourceManager), {
      conflictId: conflict.id,
      reason: sensitiveHandlingText,
      ignoredUntil: atHour(20),
    });
    const ignoredViewerDetail = await getResourceConflict({
      actor: actor(fixture.viewer),
      input: { conflictId: conflict.id },
    });
    const ignoredViewerList = await listResourceConflicts({
      actor: actor(fixture.viewer),
      input: { personId: fixture.member.person.id },
    });
    const ignoredViewerListItem = ignoredViewerList.items.find(
      (item) => item.id === conflict.id,
    );
    expect(ignoredViewerDetail.resolutionNote).toBe(
      "处理说明涉及不可见记录，已隐藏",
    );
    expect(ignoredViewerDetail.explanation).toMatchObject({
      resolutionNote: "处理说明涉及不可见记录，已隐藏",
      ignoredReason: "处理说明涉及不可见记录，已隐藏",
    });
    if (!ignoredViewerListItem) throw new Error("列表缺少目标资源冲突");
    for (const partialDto of [ignoredViewerDetail, ignoredViewerListItem]) {
      const serialized = JSON.stringify(partialDto);
      for (const marker of hiddenMarkers) expect(serialized).not.toContain(marker);
    }
    const fullIgnoredDetail = await getResourceConflict({
      actor: actor(fixture.resourceManager, [
        { role: "RESOURCE_MANAGER", team: "英雄", techGroup: "电控" },
      ]),
      input: { conflictId: conflict.id },
    });
    expect(fullIgnoredDetail.resolutionNote).toBe(sensitiveHandlingText);
    expect(fullIgnoredDetail.explanation).toMatchObject({
      resolutionNote: sensitiveHandlingText,
      ignoredReason: sensitiveHandlingText,
    });
  });

  test("Conflict capabilities follow actor permissions and conflict status", async () => {
    const fixture = await createActivatedFixture();
    const systemAdmin = await createAccountPerson("P5 Conflict System Admin");
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 10, 70),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9.25, 10.25, 60),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await scanConflictsForPerson({
      personId: fixture.member.person.id,
      startAt: atHour(9),
      endAt: atHour(11),
    });
    const conflict = await prisma.resourceConflict.findFirstOrThrow({
      where: { personId: fixture.member.person.id, kind: "ALLOCATION_OVER_LIMIT" },
      select: { id: true },
    });
    const scopedManagerActor = actor(fixture.resourceManager, [
      { role: "RESOURCE_MANAGER", team: "英雄", techGroup: "电控" },
    ]);
    const systemAdminActor = actor(systemAdmin, [
      { role: "SYSTEM_ADMINISTRATOR", team: "", techGroup: "" },
    ]);
    const noCapabilities = {
      canAcknowledge: false,
      canResolve: false,
      canIgnore: false,
      canPreviewSuggestion: false,
      canApplySuggestion: false,
    };
    const handlerOpenCapabilities = {
      canAcknowledge: true,
      canResolve: true,
      canIgnore: true,
      canPreviewSuggestion: true,
      canApplySuggestion: true,
    };

    const openSelf = await getResourceConflict({
      actor: actor(fixture.member),
      input: { conflictId: conflict.id },
    });
    expect(openSelf.capabilities).toEqual({
      ...noCapabilities,
      canAcknowledge: true,
    });
    for (const handlingActor of [
      actor(fixture.owner),
      scopedManagerActor,
      systemAdminActor,
    ]) {
      const detail = await getResourceConflict({
        actor: handlingActor,
        input: { conflictId: conflict.id },
      });
      expect(detail.capabilities).toEqual(handlerOpenCapabilities);
    }
    const openViewer = await getResourceConflict({
      actor: actor(fixture.viewer),
      input: { conflictId: conflict.id },
    });
    expect(openViewer.capabilities).toEqual(noCapabilities);

    const list = await listResourceConflicts({
      actor: scopedManagerActor,
      input: { personId: fixture.member.person.id },
    });
    expect(list.items.find((item) => item.id === conflict.id)?.capabilities).toEqual(
      handlerOpenCapabilities,
    );

    await prisma.resourceConflict.update({
      where: { id: conflict.id },
      data: { status: "ACKNOWLEDGED" },
    });
    const acknowledged = await getResourceConflict({
      actor: scopedManagerActor,
      input: { conflictId: conflict.id },
    });
    expect(acknowledged.capabilities).toEqual(handlerOpenCapabilities);

    await prisma.resourceConflict.update({
      where: { id: conflict.id },
      data: { status: "IGNORED" },
    });
    const ignored = await getResourceConflict({
      actor: systemAdminActor,
      input: { conflictId: conflict.id },
    });
    expect(ignored.capabilities).toEqual({
      ...handlerOpenCapabilities,
      canAcknowledge: false,
    });

    await prisma.resourceConflict.update({
      where: { id: conflict.id },
      data: { status: "RESOLVED" },
    });
    for (const resolvedActor of [actor(fixture.member), actor(fixture.viewer)]) {
      const detail = await getResourceConflict({
        actor: resolvedActor,
        input: { conflictId: conflict.id },
      });
      expect(detail.capabilities).toEqual(noCapabilities);
    }
    for (const resolvedHandler of [
      actor(fixture.owner),
      scopedManagerActor,
      systemAdminActor,
    ]) {
      const detail = await getResourceConflict({
        actor: resolvedHandler,
        input: { conflictId: conflict.id },
      });
      expect(detail.capabilities).toEqual({
        ...noCapabilities,
        canResolve: true,
        canPreviewSuggestion: true,
      });
    }
  });

  test("Conflict capabilities match each service state contract", async () => {
    const fixture = await createActivatedFixture();
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 10, 70),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9.25, 10.25, 60),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await scanConflictsForPerson({
      personId: fixture.member.person.id,
      startAt: atHour(9),
      endAt: atHour(11),
    });
    const conflict = await prisma.resourceConflict.findFirstOrThrow({
      where: { personId: fixture.member.person.id, kind: "ALLOCATION_OVER_LIMIT" },
      select: { id: true },
    });
    const managerQueryActor = actor(fixture.resourceManager, [
      { role: "RESOURCE_MANAGER", team: "英雄", techGroup: "电控" },
    ]);
    const statusCases = [
      {
        status: "OPEN" as const,
        expected: {
          canAcknowledge: true,
          canResolve: true,
          canIgnore: true,
          canPreviewSuggestion: true,
          canApplySuggestion: true,
        },
      },
      {
        status: "ACKNOWLEDGED" as const,
        expected: {
          canAcknowledge: true,
          canResolve: true,
          canIgnore: true,
          canPreviewSuggestion: true,
          canApplySuggestion: true,
        },
      },
      {
        status: "IGNORED" as const,
        expected: {
          canAcknowledge: false,
          canResolve: true,
          canIgnore: true,
          canPreviewSuggestion: true,
          canApplySuggestion: true,
        },
      },
      {
        status: "RESOLVED" as const,
        expected: {
          canAcknowledge: false,
          canResolve: true,
          canIgnore: false,
          canPreviewSuggestion: true,
          canApplySuggestion: false,
        },
      },
    ];

    for (const { status, expected } of statusCases) {
      await setConflictStatus(conflict.id, status);
      const detail = await getResourceConflict({
        actor: managerQueryActor,
        input: { conflictId: conflict.id },
      });
      expect(detail.capabilities).toEqual(expected);

      await setConflictStatus(conflict.id, status);
      await expectServiceAcceptance(
        acknowledgeConflict(actor(fixture.resourceManager), {
          conflictId: conflict.id,
          note: `状态契约 ${status}`,
        }),
        expected.canAcknowledge,
      );

      await setConflictStatus(conflict.id, status);
      await expectServiceAcceptance(
        resolveConflict(actor(fixture.resourceManager), {
          conflictId: conflict.id,
          resolutionNote: `状态契约 ${status}`,
        }),
        expected.canResolve,
      );

      await setConflictStatus(conflict.id, status);
      await expectServiceAcceptance(
        ignoreConflict(actor(fixture.resourceManager), {
          conflictId: conflict.id,
          reason: `状态契约 ${status}`,
          ignoredUntil: atHour(20),
        }),
        expected.canIgnore,
      );

      await setConflictStatus(conflict.id, status);
      const previewCall = previewConflictSuggestion(actor(fixture.resourceManager), {
        conflictId: conflict.id,
      });
      await expectServiceAcceptance(previewCall, expected.canPreviewSuggestion);
      if (status === "RESOLVED") {
        await expect(previewCall).resolves.toEqual({
          conflictId: conflict.id,
          suggestions: [],
        });
      }

      await setConflictStatus(conflict.id, "OPEN");
      const previewForApply = await previewConflictSuggestion(
        actor(fixture.resourceManager),
        { conflictId: conflict.id },
      );
      const proposal = previewForApply.suggestions[0];
      if (!proposal) throw new Error("未生成资源冲突处理建议");
      await setConflictStatus(conflict.id, status);
      await expectServiceAcceptance(
        applyConflictSuggestion(actor(fixture.resourceManager), {
          conflictId: conflict.id,
          confirmApply: true,
          proposal,
        }),
        expected.canApplySuggestion,
      );
    }
  });

  test("Task owner can handle a conflict only when owning every related Task", async () => {
    const fixture = await createActivatedFixture();
    const alsoOwnedTask = await createActivatedFixture({
      owner: fixture.owner,
      member: fixture.member,
      title: "P5 Same Owner Conflict Task",
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 10, 70),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9.25, 10.25, 60),
      taskId: alsoOwnedTask.taskId,
      nodeId: alsoOwnedTask.activeNodeId,
    });
    await scanConflictsForPerson({
      personId: fixture.member.person.id,
      startAt: atHour(9),
      endAt: atHour(11),
    });
    const conflict = await prisma.resourceConflict.findFirstOrThrow({
      where: { personId: fixture.member.person.id, kind: "ALLOCATION_OVER_LIMIT" },
      select: { id: true },
    });

    const detail = await getResourceConflict({
      actor: actor(fixture.owner),
      input: { conflictId: conflict.id },
    });
    expect(detail.hiddenSegmentCount).toBe(0);
    expect(detail.capabilities).toEqual({
      canAcknowledge: true,
      canResolve: true,
      canIgnore: true,
      canPreviewSuggestion: true,
      canApplySuggestion: true,
    });
    const preview = await previewConflictSuggestion(actor(fixture.owner), {
      conflictId: conflict.id,
    });
    expect(preview.suggestions[0]?.moves.length).toBeGreaterThan(0);
  });

  test("Scoped manager cannot handle a conflict when only some Tasks match scope", async () => {
    const fixture = await createActivatedFixture();
    const outOfScopeTask = await createActivatedFixture({
      member: fixture.member,
      title: "P5 Out Of Scope Conflict Task",
      team: "步兵",
      techGroup: "机械",
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 10, 70),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9.25, 10.25, 60),
      taskId: outOfScopeTask.taskId,
      nodeId: outOfScopeTask.activeNodeId,
    });
    await scanConflictsForPerson({
      personId: fixture.member.person.id,
      startAt: atHour(9),
      endAt: atHour(11),
    });
    const conflict = await prisma.resourceConflict.findFirstOrThrow({
      where: { personId: fixture.member.person.id, kind: "ALLOCATION_OVER_LIMIT" },
      select: { id: true },
    });
    const scopedManagerActor = actor(fixture.resourceManager, [
      { role: "RESOURCE_MANAGER", team: "英雄", techGroup: "电控" },
    ]);

    const detail = await getResourceConflict({
      actor: scopedManagerActor,
      input: { conflictId: conflict.id },
    });
    expect(detail.hiddenSegmentCount).toBe(1);
    expect(detail.capabilities).toEqual({
      canAcknowledge: false,
      canResolve: false,
      canIgnore: false,
      canPreviewSuggestion: false,
      canApplySuggestion: false,
    });
    const list = await listResourceConflicts({
      actor: scopedManagerActor,
      input: { personId: fixture.member.person.id },
    });
    expect(list.items.find((item) => item.id === conflict.id)).toMatchObject({
      hiddenSegmentCount: 1,
      capabilities: detail.capabilities,
    });
    await expectServiceError(
      previewConflictSuggestion(actor(fixture.resourceManager), {
        conflictId: conflict.id,
      }),
      "STATE_CONFLICT",
    );
  });

  test("Conflict scans are idempotent, resolve obsolete conflicts and reopen expired ignored conflicts", async () => {
    const fixture = await createActivatedFixture();
    const first = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 10, 70),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    const second = await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9.25, 10.25, 60),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    const scan = await scanConflictsForPerson({
      personId: fixture.member.person.id,
      startAt: atHour(9),
      endAt: atHour(11),
    });
    expect(scan.createdCount).toBe(1);
    const repeated = await scanConflictsForPerson({
      personId: fixture.member.person.id,
      startAt: atHour(9),
      endAt: atHour(11),
    });
    expect(repeated.createdCount).toBe(0);
    expect(
      await prisma.resourceConflict.count({
        where: { personId: fixture.member.person.id, kind: "ALLOCATION_OVER_LIMIT" },
      }),
    ).toBe(1);

    const conflict = await prisma.resourceConflict.findFirstOrThrow({
      where: { personId: fixture.member.person.id, kind: "ALLOCATION_OVER_LIMIT" },
      include: { segments: true },
    });
    await ignoreConflict(actor(fixture.resourceManager), {
      conflictId: conflict.id,
      reason: "短期接受风险",
      ignoredUntil: atHour(20),
    });
    const ignoredScan = await scanConflictsForPerson({
      personId: fixture.member.person.id,
      startAt: atHour(9),
      endAt: atHour(11),
    });
    expect(ignoredScan.reopenedCount).toBe(0);
    await prisma.resourceConflict.update({
      where: { id: conflict.id },
      data: { ignoredUntil: new Date("2026-07-27T08:00:00.000Z") },
    });
    const reopenedScan = await scanConflictsForPerson({
      personId: fixture.member.person.id,
      startAt: atHour(9),
      endAt: atHour(11),
    });
    expect(reopenedScan.reopenedCount).toBe(1);
    expect(
      await prisma.notificationOutbox.count({
        where: {
          eventKey: { startsWith: `pm:conflict:opened:${conflict.fingerprint}` },
          type: "resource_conflict_opened",
        },
      }),
    ).toBe(2);

    await movePlannedSegments(actor(fixture.member), {
      moves: [
        {
          segmentId: second.segment.id,
          expectedUpdatedAt: second.segment.updatedAt,
          startAt: atHour(11),
          endAt: atHour(12),
        },
      ],
      reason: "手动移开冲突",
    });
    const resolvedScan = await scanConflictsForPerson({
      personId: fixture.member.person.id,
      startAt: atHour(9),
      endAt: atHour(12),
    });
    expect(resolvedScan.resolvedCount).toBe(1);
    const resolved = await prisma.resourceConflict.findUniqueOrThrow({
      where: { id: conflict.id },
      select: { status: true },
    });
    expect(resolved.status).toBe("RESOLVED");
    await expectProjectManagementOutbox(
      `pm:conflict:resolved:${conflict.id}:`,
      "resource_conflict_resolved",
      true,
    );
    expect(first.segment.id).toBeTruthy();
  });

  test("Manual handling requires system administrator when conflict includes no-task segments", async () => {
    const fixture = await createActivatedFixture();
    const systemAdmin = await createAccountPerson("P5 No Task Conflict System Admin");
    await grantRole(systemAdmin.account.id, "SYSTEM_ADMINISTRATOR");
    await createWorkSegment(actor(fixture.resourceManager), {
      ...plannedInput(fixture.member.person.id, 9, 10, 70),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9.25, 10.25, 60),
    });
    await scanConflictsForPerson({
      personId: fixture.member.person.id,
      startAt: atHour(9),
      endAt: atHour(11),
    });
    const conflict = await prisma.resourceConflict.findFirstOrThrow({
      where: { personId: fixture.member.person.id, kind: "ALLOCATION_OVER_LIMIT" },
    });

    await expectServiceError(
      resolveConflict(actor(fixture.resourceManager), {
        conflictId: conflict.id,
        resolutionNote: "范围管理员不能处理无 Task 混合冲突",
      }),
      "STATE_CONFLICT",
    );

    const systemAdminDetail = await getResourceConflict({
      actor: actor(systemAdmin, [
        { role: "SYSTEM_ADMINISTRATOR", team: "", techGroup: "" },
      ]),
      input: { conflictId: conflict.id },
    });
    expect(systemAdminDetail.capabilities).toEqual({
      canAcknowledge: true,
      canResolve: true,
      canIgnore: true,
      canPreviewSuggestion: true,
      canApplySuggestion: true,
    });
    const preview = await previewConflictSuggestion(actor(systemAdmin), {
      conflictId: conflict.id,
    });
    expect(preview.suggestions[0]?.moves.length).toBeGreaterThan(0);
    const resolved = await resolveConflict(actor(systemAdmin), {
      conflictId: conflict.id,
      resolutionNote: "系统管理员处理无 Task Segment 冲突",
    });
    expect(resolved.status).toBe("RESOLVED");
  });

  test("Manual conflict handling enforces permissions and suggestion apply requires explicit versioned confirmation", async () => {
    const fixture = await createActivatedFixture();
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9, 10, 80),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await createWorkSegment(actor(fixture.member), {
      ...plannedInput(fixture.member.person.id, 9.25, 10.25, 50),
      taskId: fixture.taskId,
      nodeId: fixture.activeNodeId,
    });
    await scanConflictsForPerson({
      personId: fixture.member.person.id,
      startAt: atHour(9),
      endAt: atHour(11),
    });
    const conflict = await prisma.resourceConflict.findFirstOrThrow({
      where: { personId: fixture.member.person.id, kind: "ALLOCATION_OVER_LIMIT" },
      include: { segments: { include: { segment: true } } },
    });

    await expectServiceError(
      resolveConflict(actor(fixture.outsider), {
        conflictId: conflict.id,
        resolutionNote: "越权解决",
      }),
      "NOT_FOUND",
    );
    const acknowledged = await acknowledgeConflict(actor(fixture.member), {
      conflictId: conflict.id,
      note: "我已知晓",
    });
    expect(acknowledged.status).toBe("ACKNOWLEDGED");

    const beforePreviewChangeCount = await prisma.workSegmentChange.count();
    const preview = await previewConflictSuggestion(actor(fixture.resourceManager), {
      conflictId: conflict.id,
    });
    expect(preview.suggestions[0]?.moves.length).toBeGreaterThan(0);
    expect(await prisma.workSegmentChange.count()).toBe(beforePreviewChangeCount);

    await expectServiceError(
      applyConflictSuggestion(actor(fixture.resourceManager), {
        conflictId: conflict.id,
        confirmApply: false,
        proposal: preview.suggestions[0],
      }),
      "VALIDATION_ERROR",
    );
    const applied = await applyConflictSuggestion(actor(fixture.resourceManager), {
      conflictId: conflict.id,
      confirmApply: true,
      proposal: preview.suggestions[0],
    });
    expect(applied.status).toBe("RESOLVED");
    expect(applied.movedSegments.affectedSegmentIds.length).toBeGreaterThan(0);
  });
});

async function createActivatedFixture(options: {
  owner?: Awaited<ReturnType<typeof createAccountPerson>>;
  member?: Awaited<ReturnType<typeof createAccountPerson>>;
  title?: string;
  team?: string;
  techGroup?: string;
} = {}) {
  const admin = await createAccountPerson("P5 Conflict Team Admin");
  const owner = options.owner ?? (await createAccountPerson("P5 Conflict Owner"));
  const member = options.member ?? (await createAccountPerson("P5 Conflict Member"));
  const team = options.team ?? "英雄";
  const techGroup = options.techGroup ?? "电控";
  const reviewer = await createAccountPerson("P5 Conflict Reviewer");
  const viewer = await createAccountPerson("P5 Conflict Viewer");
  const outsider = await createAccountPerson("P5 Conflict Outsider");
  const resourceManager = await createAccountPerson("P5 Conflict Resource Manager");
  await grantRole(admin.account.id, "TEAM_ADMINISTRATOR", {
    team,
    techGroup,
  });
  await grantRole(resourceManager.account.id, "RESOURCE_MANAGER", {
    team,
    techGroup,
  });
  const draft = await createTaskDraft(actor(admin), {
    title: `${options.title ?? "P5 Conflict Task"} ${randomUUID()}`,
    description: "P5 Conflict 测试",
    team,
    techGroup,
    priority: "HIGH",
    tagIds: [],
    members: [
      { personId: owner.person.id, role: "OWNER" },
      { personId: member.person.id, role: "MEMBER" },
      { personId: reviewer.person.id, role: "REVIEWER" },
      { personId: viewer.person.id, role: "VIEWER" },
    ],
    milestones: [milestoneInput("阶段一", "完成阶段一", 1)],
    termination: terminationInput(4),
    idempotencyKey: `p5-conflict-task-${randomUUID()}`,
  });
  const activated = await activateTask(actor(owner), {
    taskId: draft.taskId,
    expectedLockVersion: draft.lockVersion,
  });
  const activeNode = await currentActiveMilestone(draft.taskId);
  return {
    admin,
    owner,
    member,
    reviewer,
    viewer,
    outsider,
    resourceManager,
    taskId: draft.taskId,
    currentPlanVersionId: activated.currentPlanVersionId,
    activeNodeId: activeNode.nodeId,
  };
}

function plannedInput(
  personId: string,
  startHour: number,
  endHour: number,
  allocation: number | null,
) {
  return {
    personId,
    type: "PLANNED",
    startAt: atHour(startHour),
    endAt: atHour(endHour),
    content: `冲突计划 ${startHour}-${endHour}`,
    allocation,
    role: "DEVELOPER",
    priority: "MEDIUM",
    tagIds: [],
  };
}

function milestoneInput(goal: string, criteria: string, daysFromBase: number) {
  return {
    goal,
    completionCriteria: criteria,
    expectedCompletedAt: new Date(Date.UTC(2026, 7, daysFromBase, 10, 0, 0)),
    reviewRequirements: "提交文本或链接证据",
    businessDescription: goal,
  };
}

function terminationInput(daysFromBase: number) {
  return {
    plannedOutcomeCriteria: "所有 Milestone 完成并完成总结",
    plannedAt: new Date(Date.UTC(2026, 7, daysFromBase, 10, 0, 0)),
    businessDescription: "结束确认",
  };
}

async function currentActiveMilestone(taskId: string) {
  return prisma.planVersionNode.findFirstOrThrow({
    where: {
      planVersion: { taskId, status: "CURRENT" },
      node: { type: "MILESTONE", status: "ACTIVE" },
    },
    select: { nodeId: true },
  });
}

async function createAccountPerson(displayName: string) {
  const openId = `ou_pm_p5_conflict_${randomUUID()}`;
  const account = await prisma.account.create({
    data: {
      status: "ACTIVE",
      identities: {
        create: {
          provider: "FEISHU",
          tenantId: "default",
          providerSubject: `open:${openId}`,
          openId,
        },
      },
      person: {
        create: {
          displayName,
          status: "ACTIVE",
        },
      },
    },
    include: { person: true },
  });
  if (!account.person) throw new Error("测试账号缺少 Person");
  return { account, person: account.person, openId };
}

async function grantRole(
  accountId: string,
  role: "TEAM_ADMINISTRATOR" | "RESOURCE_MANAGER" | "SYSTEM_ADMINISTRATOR",
  scope: { team: string; techGroup: string } = { team: "", techGroup: "" },
) {
  await prisma.systemRoleAssignment.create({
    data: {
      accountId,
      role,
      team: scope.team,
      techGroup: scope.techGroup,
    },
  });
}

function actor(
  input: Awaited<ReturnType<typeof createAccountPerson>>,
  systemRoles: ProjectManagementActor["systemRoles"] = [],
): ProjectManagementActor {
  return {
    accountId: input.account.id,
    personId: input.person.id,
    openId: input.openId,
    unionId: null,
    systemRoles,
  };
}

function atHour(hour: number) {
  const fullHour = Math.trunc(hour);
  const minutes = Math.round((hour - fullHour) * 60);
  return new Date(Date.UTC(2026, 7, 11, fullHour, minutes, 0));
}

async function expectServiceError(
  promise: Promise<unknown>,
  code: ReturnType<typeof toProjectManagementServiceError>["code"],
) {
  await expect(
    promise.catch((error) => toProjectManagementServiceError(error).code),
  ).resolves.toBe(code);
}

async function expectServiceAcceptance(
  promise: Promise<unknown>,
  accepted: boolean,
) {
  if (accepted) {
    await expect(promise).resolves.toBeTruthy();
    return;
  }
  await expectServiceError(promise, "STATE_CONFLICT");
}

async function setConflictStatus(
  conflictId: string,
  status: "OPEN" | "ACKNOWLEDGED" | "IGNORED" | "RESOLVED",
) {
  await prisma.resourceConflict.update({
    where: { id: conflictId },
    data: { status },
  });
}

async function expectProjectManagementOutbox(
  eventKeyPrefix: string,
  type: string,
  prefix = false,
) {
  const row = prefix
    ? await prisma.notificationOutbox.findFirstOrThrow({
        where: { eventKey: { startsWith: eventKeyPrefix } },
      })
    : await prisma.notificationOutbox.findUniqueOrThrow({
        where: { eventKey: eventKeyPrefix },
      });
  expect(row.channel).toBe("project-management");
  expect(row.type).toBe(type);
  expect(row.botKind).toBe("notification");
  const payload = JSON.parse(row.payload) as { purpose?: string };
  expect(payload.purpose).toBe("notification");
}
