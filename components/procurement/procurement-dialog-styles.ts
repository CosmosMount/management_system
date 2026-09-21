import styles from "@/components/procurement/procurement-responsive.module.css";

/** 采购相关弹窗：收紧顶部留白 */
export const procurementDialogContentClass =
  "gap-2.5 overflow-y-auto p-4 pt-3 sm:max-w-2xl max-h-[90vh]";

/** 上传报销凭证：窄屏明细纵向排列，宽屏保留表格的局部滚动。 */
export const procurementVoucherDialogContentClass =
  `${styles.voucherDialog} gap-2.5 overflow-y-auto p-4 pt-3 max-h-[90dvh] [&_form]:min-w-0 [&_form]:max-w-full`;

export const procurementDialogHeaderClass = "gap-0.5 text-left";

export const procurementDialogTitleClass = "text-base leading-snug";

export const procurementDialogDescriptionClass = "text-xs leading-relaxed";
