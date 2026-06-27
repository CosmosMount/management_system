export type ProcurementRejectOutcome = "terminate" | "resubmit";

export type ProcurementRejectStage = "approval" | "finance";

export function procurementRejectOutcomeLabels(stage: ProcurementRejectStage): Record<
  ProcurementRejectOutcome,
  { title: string; description: string; confirmLabel: string }
> {
  if (stage === "finance") {
    return {
      terminate: {
        title: "终止报销",
        description: "驳回后本次报销流程结束，订单标记为已驳回。",
        confirmLabel: "确认终止",
      },
      resubmit: {
        title: "退回重新提交",
        description:
          "订单退回「待上传凭证」，已上传的发票、清单与照片将清空，采购人需重新提交。",
        confirmLabel: "确认退回",
      },
    };
  }

  return {
    terminate: {
      title: "终止采购",
      description: "驳回后本次采购终止，不计入采购汇总，原因将发送给采购人。",
      confirmLabel: "确认终止",
    },
    resubmit: {
      title: "退回重新提交",
      description:
        "订单退回草稿，采购人可修改采购明细后重新提交申请，管理审核将从头进行。",
      confirmLabel: "确认退回",
    },
  };
}
