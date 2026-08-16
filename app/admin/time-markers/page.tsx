import { listAdminGlobalTimeMarkers } from "@/app/actions/adminGlobalTimeMarkers";
import { AdminGlobalTimeMarkersPanel } from "@/components/admin/global-time-markers-panel";

export default async function AdminGlobalTimeMarkersPage() {
  const initialCollection = await listAdminGlobalTimeMarkers();
  return (
    <AdminGlobalTimeMarkersPanel
      initialCollection={initialCollection}
      initialNow={new Date().toISOString()}
    />
  );
}
