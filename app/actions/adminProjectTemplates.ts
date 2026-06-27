"use server";

import { Prisma } from "@prisma/client";
import { requireSuperAdmin } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { revalidateAdmin } from "@/lib/revalidate";
import {
  createProjectTemplateSchema,
  deleteProjectTemplateSchema,
  projectTemplateEnabledSchema,
  projectTemplateIdSchema,
  updateProjectTemplateSchema,
  type CreateProjectTemplateInput,
  type UpdateProjectTemplateInput,
} from "@/lib/validations/progress";

export async function createProjectTemplate(input: CreateProjectTemplateInput) {
  await requireSuperAdmin();
  const parsed = createProjectTemplateSchema.parse(input);
  if (parsed.isDefault && !parsed.enabled) {
    throw new Error("默认模板必须保持启用");
  }

  try {
    await prisma.$transaction(async (tx) => {
      const maxSort = await tx.projectTemplate.aggregate({
        _max: { sortOrder: true },
      });
      if (parsed.isDefault) {
        await tx.projectTemplate.updateMany({ data: { isDefault: false } });
      }

      await tx.projectTemplate.create({
        data: {
          name: parsed.name,
          description: parsed.description ?? "",
          enabled: parsed.enabled,
          isDefault: parsed.isDefault,
          sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
          stages: {
            create: parsed.stages.map((stage, index) => ({
              name: stage.name,
              goal: stage.goal,
              dueOffsetDays: stage.durationDays,
              sortOrder: index,
            })),
          },
        },
      });
    });
  } catch (error) {
    handleProjectTemplateWriteError(error);
  }

  revalidateAdmin();
}

export async function updateProjectTemplate(input: UpdateProjectTemplateInput) {
  await requireSuperAdmin();
  const parsed = updateProjectTemplateSchema.parse(input);
  if (parsed.isDefault && !parsed.enabled) {
    throw new Error("默认模板必须保持启用");
  }

  try {
    await prisma.$transaction(async (tx) => {
      const existing = await tx.projectTemplate.findUnique({
        where: { id: parsed.templateId },
        select: { id: true, isDefault: true },
      });
      if (!existing) throw new Error("项目模板不存在");
      if (existing.isDefault && !parsed.isDefault) {
        throw new Error("默认模板不能取消默认，请先将其他模板设为默认");
      }
      if (existing.isDefault && !parsed.enabled) {
        throw new Error("默认模板不能停用，请先将其他模板设为默认");
      }

      if (parsed.isDefault) {
        await tx.projectTemplate.updateMany({
          where: { id: { not: parsed.templateId } },
          data: { isDefault: false },
        });
      }

      await tx.projectTemplate.update({
        where: { id: parsed.templateId },
        data: {
          name: parsed.name,
          description: parsed.description ?? "",
          enabled: parsed.enabled,
          isDefault: parsed.isDefault,
          stages: {
            deleteMany: {},
            create: parsed.stages.map((stage, index) => ({
              name: stage.name,
              goal: stage.goal,
              dueOffsetDays: stage.durationDays,
              sortOrder: index,
            })),
          },
        },
      });
    });
  } catch (error) {
    handleProjectTemplateWriteError(error);
  }

  revalidateAdmin();
}

export async function setDefaultProjectTemplate(input: { templateId: string }) {
  await requireSuperAdmin();
  const parsed = projectTemplateIdSchema.parse(input);

  await prisma.$transaction(async (tx) => {
    const template = await tx.projectTemplate.findUnique({
      where: { id: parsed.templateId },
      include: { stages: true },
    });
    if (!template) throw new Error("项目模板不存在");
    if (!template.enabled) throw new Error("停用模板不能设为默认");
    if (template.stages.length === 0) {
      throw new Error("没有阶段的模板不能设为默认");
    }

    await tx.projectTemplate.updateMany({ data: { isDefault: false } });
    await tx.projectTemplate.update({
      where: { id: template.id },
      data: { isDefault: true },
    });
  });

  revalidateAdmin();
}

export async function updateProjectTemplateEnabled(input: {
  templateId: string;
  enabled: boolean;
}) {
  await requireSuperAdmin();
  const parsed = projectTemplateEnabledSchema.parse(input);

  await prisma.$transaction(async (tx) => {
    const template = await tx.projectTemplate.findUnique({
      where: { id: parsed.templateId },
      select: { id: true, isDefault: true },
    });
    if (!template) throw new Error("项目模板不存在");
    if (template.isDefault && !parsed.enabled) {
      throw new Error("默认模板不能停用，请先将其他模板设为默认");
    }

    await tx.projectTemplate.update({
      where: { id: template.id },
      data: { enabled: parsed.enabled },
    });
  });

  revalidateAdmin();
}

export async function deleteProjectTemplate(input: { templateId: string }) {
  await requireSuperAdmin();
  const parsed = deleteProjectTemplateSchema.parse(input);

  await prisma.$transaction(async (tx) => {
    const template = await tx.projectTemplate.findUnique({
      where: { id: parsed.templateId },
      select: { id: true, name: true, isDefault: true, enabled: true },
    });
    if (!template) throw new Error("项目模板不存在");
    if (template.isDefault) {
      throw new Error("默认模板不能删除，请先将其他模板设为默认");
    }

    if (template.enabled) {
      const enabledCount = await tx.projectTemplate.count({
        where: { enabled: true },
      });
      if (enabledCount <= 1) {
        throw new Error("至少需要保留一个启用模板");
      }
    }

    await tx.projectTemplate.delete({ where: { id: template.id } });
  });

  revalidateAdmin();
}

function handleProjectTemplateWriteError(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    const target = Array.isArray(error.meta?.target)
      ? error.meta.target.join(",")
      : String(error.meta?.target ?? "");
    if (target.includes("ProjectTemplate_single_default_idx")) {
      throw new Error("默认模板已被更新，请刷新后重试");
    }
    throw new Error("项目模板名称已存在");
  }
  throw error;
}
