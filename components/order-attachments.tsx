import { Paperclip } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AttachmentFileLink } from "@/components/attachment-file-link";
import {
  groupOrderAttachments,
  hasReimbursementAttachments,
  type OrderAttachmentGroups,
} from "@/lib/order-attachments";

type Props = {
  order: {
    invoicePaths: string;
    invoicePath?: string | null;
    listDocPath: string | null;
    screenshotPath: string | null;
  };
  canView: boolean;
};

function AttachmentLinks({
  label,
  paths,
}: {
  label: string;
  paths: string[];
}) {
  if (paths.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium text-muted-foreground">{label}</p>
      <ul className="space-y-1">
        {paths.map((filePath) => (
          <li key={filePath}>
            <AttachmentFileLink filePath={filePath} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function InlineAttachments({ groups }: { groups: OrderAttachmentGroups }) {
  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-3 text-sm">
      <AttachmentLinks label="发票" paths={groups.invoices} />
      {groups.listDoc && (
        <div className="space-y-1">
          <p className="font-medium text-muted-foreground">采购清单</p>
          <AttachmentFileLink filePath={groups.listDoc} />
        </div>
      )}
      {groups.screenshot && (
        <div className="space-y-1">
          <p className="font-medium text-muted-foreground">报销截图</p>
          <AttachmentFileLink filePath={groups.screenshot} />
        </div>
      )}
    </div>
  );
}

export function OrderAttachmentsCard({ order, canView }: Props) {
  const groups = groupOrderAttachments(order);
  if (!hasReimbursementAttachments(groups)) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Paperclip className="h-4 w-4 text-primary" />
          流程附件
        </CardTitle>
        <CardDescription>
          各步骤上传的文件，可在对应环节查看与下载
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {(groups.invoices.length > 0 || groups.listDoc) && (
          <div className="space-y-2">
            <p className="text-sm font-semibold">采购人上传（发票与清单）</p>
            {canView ? (
              <InlineAttachments
                groups={{
                  invoices: groups.invoices,
                  listDoc: groups.listDoc,
                  screenshot: null,
                }}
              />
            ) : (
              <p className="text-sm text-muted-foreground">已上传，无查看权限</p>
            )}
          </div>
        )}
        {groups.screenshot && (
          <div className="space-y-2">
            <p className="text-sm font-semibold">报销员上传（报销截图）</p>
            {canView ? (
              <InlineAttachments
                groups={{
                  invoices: [],
                  listDoc: null,
                  screenshot: groups.screenshot,
                }}
              />
            ) : (
              <p className="text-sm text-muted-foreground">已上传，无查看权限</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export { InlineAttachments, groupOrderAttachments };
