"use client";

import { deleteRejectedProjectEstablishment } from "@/app/actions/progress/createProject";
import { AdminDeleteRecordButton } from "@/components/admin-delete-record-button";

type Props = {
  projectId: string;
  canDelete: boolean;
  className?: string;
  redirectTo?: string;
};

export function RejectedProjectEstablishmentDeleteButton({
  projectId,
  canDelete,
  className,
  redirectTo,
}: Props) {
  if (!canDelete) return null;

  return (
    <AdminDeleteRecordButton
      title="删除被驳回立项"
      description="将永久删除该立项项目、阶段草案和活动记录，此操作不可恢复。"
      confirmLabel="确认删除"
      triggerLabel="删除立项"
      size="default"
      className={className}
      redirectTo={redirectTo}
      onConfirm={async () => {
        await deleteRejectedProjectEstablishment(projectId);
      }}
    />
  );
}
