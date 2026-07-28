import { redirect } from "next/navigation";
import { routes } from "@/lib/routes";

export default function LegacyProgressRoute() {
  redirect(routes.progress.root);
}
