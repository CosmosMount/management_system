import { AdminBudgetPoolsPanel } from "@/components/admin-budget-pools-panel";
import { listAdminBudgetPools } from "@/app/actions/adminBudgetPools";

export default async function AdminBudgetPoolsPage() {
  const pools = await listAdminBudgetPools();

  return <AdminBudgetPoolsPanel pools={pools} />;
}
