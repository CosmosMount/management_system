import "dotenv/config";
import { seedDefaultProgressReminderRules } from "@/lib/progress-reminders";
import { prisma } from "@/lib/prisma";

seedDefaultProgressReminderRules()
  .then(async () => {
    console.log("[seed-progress-reminder-rules] 默认进度提醒规则已初始化");
    await prisma.$disconnect();
  })
  .catch(async (err) => {
    console.error("[seed-progress-reminder-rules] failed:", err);
    await prisma.$disconnect();
    process.exit(1);
  });
