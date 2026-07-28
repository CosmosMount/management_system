import "dotenv/config";
import { backfillProjectManagementIdentities } from "@/lib/project-management/identity";

async function main() {
  const dryRun = process.env.APPLY_PM_IDENTITY_BACKFILL !== "true";
  const result = await backfillProjectManagementIdentities({ dryRun });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    JSON.stringify(
      {
        result: "failure",
        message,
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
