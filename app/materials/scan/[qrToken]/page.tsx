import Link from "next/link";
import { notFound } from "next/navigation";
import { PackageOpen } from "lucide-react";
import { MaterialScanConfirmation } from "@/components/material-management/material-scan-confirmation";
import { PageCommandBar } from "@/components/project-management/shell/page-command-bar";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getMaterialByQrToken } from "@/lib/material-management/queries";
import { formatMaterialPrice } from "@/lib/material-management/presentation";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { getMaterialActorOrRedirect } from "../../_auth";

export default async function MaterialScanPage({
  params,
}: {
  params: Promise<{ qrToken: string }>;
}) {
  const { qrToken } = await params;
  const actor = await getMaterialActorOrRedirect(
    routes.materials.scan(qrToken),
  );
  const material = await getMaterialByQrToken(qrToken).catch(() => null);
  if (!material) notFound();

  const isBorrower =
    material.activeLoan?.borrowerAccountId === actor.accountId;
  const operation = material.activeLoan ? "RETURN" : "CHECKOUT";

  return (
    <>
      <PageCommandBar
        title="扫码领用 / 归还"
        description="核对物资和当前状态后确认操作。"
        sectionLabel="物资管理"
        testId="material-management-command-bar"
      />
      <div className="mx-auto w-full min-w-0 max-w-xl px-4 py-8 sm:px-6">
        <Card>
          <CardHeader className="text-center">
            <PackageOpen
              className="mx-auto mb-2 size-10 text-primary"
              aria-hidden="true"
            />
            <CardTitle className="break-words text-xl">
              {material.name}
            </CardTitle>
            <div className="flex flex-wrap justify-center gap-2 pt-2">
              <Badge variant="outline">{material.techGroup}</Badge>
              <Badge variant={material.activeLoan ? "secondary" : "default"}>
                {material.activeLoan ? "使用中" : "可领用"}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            <dl className="grid grid-cols-2 gap-3 rounded-lg bg-muted/60 p-4 text-sm">
              <div>
                <dt className="text-muted-foreground">价格</dt>
                <dd className="mt-1 font-medium">
                  {formatMaterialPrice(material.price)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">当前使用人</dt>
                <dd className="mt-1 break-words font-medium">
                  {material.activeLoan
                    ? material.activeLoan.borrowerName
                    : "无人使用"}
                </dd>
              </div>
            </dl>

            {!actor.isActive ? (
              <p
                role="alert"
                className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
              >
                当前账号已停用，不能领用或归还物资。
              </p>
            ) : material.activeLoan && !isBorrower ? (
              <div className="space-y-4">
                <p
                  role="alert"
                  className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
                >
                  该物资当前由 {material.activeLoan.borrowerName}
                  使用，只有领用人可以归还。
                </p>
                <Link
                  href={routes.materials.root}
                  className={cn(
                    buttonVariants({ variant: "outline" }),
                    "w-full",
                  )}
                >
                  查看物资台账
                </Link>
              </div>
            ) : (
              <MaterialScanConfirmation
                key={material.activeLoan?.id ?? "available"}
                qrToken={material.qrToken}
                operation={operation}
                expectedActiveLoanId={material.activeLoan?.id ?? null}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
