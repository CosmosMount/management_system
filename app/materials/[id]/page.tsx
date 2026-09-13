import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, History, PackageCheck, PackageOpen } from "lucide-react";
import { MaterialQrCode } from "@/components/material-management/material-qr-code";
import { D110SerialPrinter } from "@/components/material-management/d110-serial-printer";
import { ImagePreview } from "@/components/image-preview";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { List, ListContent, ListEmpty, ListItem } from "@/components/ui/list";
import { buildAppUrl } from "@/lib/app-origin";
import { getMaterialDetail } from "@/lib/material-management/queries";
import {
  formatMaterialDateTime,
  formatMaterialPrice,
} from "@/lib/material-management/presentation";
import { getRequestAppOrigin } from "@/lib/request-origin";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { getMaterialActorOrRedirect } from "../_auth";

export default async function MaterialDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await getMaterialActorOrRedirect(routes.materials.detail(id));
  const material = await getMaterialDetail(id).catch(() => null);
  if (!material) notFound();
  const scanUrl = buildAppUrl(
    routes.materials.scan(material.qrToken),
    await getRequestAppOrigin(),
  );

  return (
    <>
      <PageCommandBar
        title={material.name}
        description="查看物资信息、专属二维码与领用历史。"
        sectionLabel="物资管理"
        testId="material-management-command-bar"
        actions={
          <Link
            href={routes.materials.root}
            className={cn(buttonVariants({ variant: "outline" }))}
          >
            <ArrowLeft aria-hidden="true" />
            返回台账
          </Link>
        }
      />
      <div className="mx-auto grid w-full min-w-0 max-w-5xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)]">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>物资信息</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-4 sm:grid-cols-2">
                <Info label="名称" value={material.name} />
                <Info
                  label="价格"
                  value={formatMaterialPrice(material.price)}
                />
                <Info label="所属技术组" value={material.techGroup} />
                <Info
                  label="登记时间"
                  value={formatMaterialDateTime(material.createdAt)}
                />
                <Info label="登记人" value={material.createdByName} />
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="grid grid-cols-[1fr_auto] items-start">
              <div>
                <CardTitle>当前状态</CardTitle>
                <p className="mt-1 text-sm text-muted-foreground">
                  台账中的在用关系以最近一次成功扫码为准。
                </p>
              </div>
              <Badge variant={material.activeLoan ? "secondary" : "default"}>
                {material.activeLoan ? "使用中" : "可领用"}
              </Badge>
            </CardHeader>
            <CardContent>
              {material.activeLoan ? (
                <div className="flex items-start gap-3 rounded-lg bg-muted/60 p-4">
                  <PackageOpen
                    className="mt-0.5 size-5 shrink-0 text-primary"
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <p className="break-words font-medium">
                      {material.activeLoan.borrowerName}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {formatMaterialDateTime(
                        material.activeLoan.checkedOutAt,
                      )} 领用
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-3 rounded-lg bg-muted/60 p-4">
                  <PackageCheck
                    className="mt-0.5 size-5 shrink-0 text-primary"
                    aria-hidden="true"
                  />
                  <p className="text-sm text-muted-foreground">
                    当前无人使用，登录用户扫描右侧二维码后可确认领用。
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          <section aria-labelledby="material-history-heading">
            <div className="mb-3 flex items-center gap-2">
              <History className="size-5 text-primary" aria-hidden="true" />
              <h2 id="material-history-heading" className="text-lg font-semibold">
                领用历史
              </h2>
            </div>
            {material.history.length === 0 ? (
              <ListEmpty>暂无领用记录</ListEmpty>
            ) : (
              <List aria-label="领用历史">
                {material.history.map((loan) => (
                  <ListItem key={loan.id}>
                    <ListContent>
                      <p className="break-words font-medium">
                        {loan.borrowerName}
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {formatMaterialDateTime(loan.checkedOutAt)} 领用
                        <span aria-hidden="true"> · </span>
                        {loan.returnedAt
                          ? `${formatMaterialDateTime(loan.returnedAt)} 归还`
                          : "尚未归还"}
                      </p>
                      {loan.returnPhotoPath && (
                        <ImagePreview
                          src={loan.returnPhotoPath}
                          alt={`${loan.borrowerName}的物资归还照片`}
                          wrapperClassName="mt-3 block w-fit rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          className="h-20 w-20 rounded-lg border bg-muted object-cover"
                        />
                      )}
                    </ListContent>
                    <Badge variant={loan.returnedAt ? "outline" : "secondary"}>
                      {loan.returnedAt ? "已归还" : "使用中"}
                    </Badge>
                  </ListItem>
                ))}
              </List>
            )}
          </section>
        </div>

        <Card className="h-fit lg:sticky lg:top-20">
          <CardHeader>
            <CardTitle>专属二维码</CardTitle>
            <p className="text-sm text-muted-foreground">
              此二维码长期对应当前物资。请下载并粘贴到实物上，不要为每次领用重复生成。
            </p>
          </CardHeader>
          <CardContent>
            <MaterialQrCode
              materialName={material.name}
              scanUrl={scanUrl}
            />
            <D110SerialPrinter
              materialName={material.name}
              price={formatMaterialPrice(material.price)}
              scanUrl={scanUrl}
              techGroup={material.techGroup}
            />
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words font-medium">{value}</dd>
    </div>
  );
}
