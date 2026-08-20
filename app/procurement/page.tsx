import { redirect } from "next/navigation";
import { routes } from "@/lib/routes";

export default function ProcurementPage() {
  redirect(routes.procurement.dashboard);
}
