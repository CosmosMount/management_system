import "dotenv/config";
import {
  runProjectManagementReleaseRehearsal,
  type ReleaseRehearsalScenario,
} from "./project-management-release-rehearsal-lib";

async function main(): Promise<void> {
  const scenario =
    process.env.PM_RELEASE_REHEARSAL_SCENARIO ?? "shared_snapshot";
  if (scenario !== "empty" && scenario !== "shared_snapshot") {
    throw new Error(
      "PM_RELEASE_REHEARSAL_SCENARIO must be empty or shared_snapshot",
    );
  }
  const report = await runProjectManagementReleaseRehearsal({
    confirmation: process.env.PM_RELEASE_REHEARSAL_CONFIRM,
    notificationDeliveryDisabled:
      process.env.NOTIFICATION_DELIVERY_DISABLED,
    scenario: scenario as ReleaseRehearsalScenario,
    sourceDatabaseUrl: process.env.DATABASE_URL,
    uploadSourceDirectory: process.env.PM_RELEASE_REHEARSAL_UPLOAD_SOURCE_DIR,
  });
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    JSON.stringify(
      {
        message,
        result: "failure",
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});
