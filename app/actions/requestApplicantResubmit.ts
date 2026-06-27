"use server";

import { rejectProcurementOrder } from "@/app/actions/rejectOrder";

/** @deprecated 请使用 rejectProcurementOrder({ outcome: "resubmit" }) */
export async function requestApplicantResubmit(input: {
  orderId: string;
  reason: string;
}) {
  return rejectProcurementOrder({
    orderId: input.orderId,
    reason: input.reason,
    outcome: "resubmit",
  });
}
