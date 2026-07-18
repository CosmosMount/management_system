import type { ProgressApprovalReminderSetting } from "@prisma/client";
import { prisma } from "@/lib/prisma";

const SETTING_ID = "default";
export const DEFAULT_PROGRESS_APPROVAL_REMINDER_COOLDOWN_MINUTES = 10;
export const MAX_PROGRESS_APPROVAL_REMINDER_COOLDOWN_MINUTES = 1440;

export type ProgressApprovalReminderSettingView = {
  cooldownMinutes: number;
  updatedAt: string | null;
};

export async function getProgressApprovalReminderSetting(): Promise<ProgressApprovalReminderSettingView> {
  return toSettingView(await ensureProgressApprovalReminderSetting());
}

export async function saveProgressApprovalReminderSetting(input: {
  cooldownMinutes: number;
}): Promise<ProgressApprovalReminderSettingView> {
  const cooldownMinutes = normalizeCooldownMinutes(input.cooldownMinutes);
  const setting = await prisma.progressApprovalReminderSetting.upsert({
    where: { id: SETTING_ID },
    create: { id: SETTING_ID, cooldownMinutes },
    update: { cooldownMinutes },
  });
  return toSettingView(setting);
}

async function ensureProgressApprovalReminderSetting(): Promise<ProgressApprovalReminderSetting> {
  return prisma.progressApprovalReminderSetting.upsert({
    where: { id: SETTING_ID },
    create: {
      id: SETTING_ID,
      cooldownMinutes: DEFAULT_PROGRESS_APPROVAL_REMINDER_COOLDOWN_MINUTES,
    },
    update: {},
  });
}

function normalizeCooldownMinutes(value: number): number {
  if (!Number.isInteger(value)) {
    throw new Error("审批提醒冷却时间必须为整数分钟");
  }
  if (value < 0 || value > MAX_PROGRESS_APPROVAL_REMINDER_COOLDOWN_MINUTES) {
    throw new Error("审批提醒冷却时间必须在 0 到 1440 分钟之间");
  }
  return value;
}

function toSettingView(
  setting: ProgressApprovalReminderSetting,
): ProgressApprovalReminderSettingView {
  return {
    cooldownMinutes: setting.cooldownMinutes,
    updatedAt: setting.updatedAt?.toISOString() ?? null,
  };
}
