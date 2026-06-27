import { UserRoleType } from "@prisma/client";
import { publicPathToAbsolute } from "@/lib/generate-reimbursement-docx";
import { prisma } from "@/lib/prisma";

export type ListSignatureContext = {
  acceptor1Path: string | null;
  acceptor2Path: string | null;
  receiverPath: string | null;
  acceptor1Label: string;
  acceptor2Label: string;
  receiverLabel: string;
};

type SignatureUser = {
  openId: string;
  name: string;
  signaturePath: string | null;
};

function pickAdminUser(
  roles: { role: UserRoleType; openId: string }[],
  role: UserRoleType,
  userByOpenId: Map<string, SignatureUser>,
): SignatureUser | undefined {
  const matches = roles.filter((r) => r.role === role);
  if (matches.length === 0) return undefined;

  for (const match of matches) {
    const user = userByOpenId.get(match.openId);
    if (user?.signaturePath) return user;
  }
  return userByOpenId.get(matches[0]!.openId);
}

async function resolveRoleAdminSignatures(
  team: string,
  techGroup: string,
): Promise<{ teamUser?: SignatureUser; techUser?: SignatureUser }> {
  const roles = await prisma.userRole.findMany({
    where: {
      OR: [
        { role: UserRoleType.TEAM_ADMIN, team },
        { role: UserRoleType.TECH_GROUP_ADMIN, techGroup },
      ],
    },
  });

  const openIds = roles.map((r) => r.openId);
  const users =
    openIds.length === 0
      ? []
      : await prisma.user.findMany({
          where: { openId: { in: openIds } },
          select: { openId: true, name: true, signaturePath: true },
        });
  const userByOpenId = new Map(users.map((u) => [u.openId, u]));

  return {
    teamUser: pickAdminUser(roles, UserRoleType.TEAM_ADMIN, userByOpenId),
    techUser: pickAdminUser(
      roles,
      UserRoleType.TECH_GROUP_ADMIN,
      userByOpenId,
    ),
  };
}

async function loadApproverUser(
  openId: string | null | undefined,
): Promise<SignatureUser | undefined> {
  if (!openId) return undefined;
  return (
    (await prisma.user.findUnique({
      where: { openId },
      select: { openId: true, name: true, signaturePath: true },
    })) ?? undefined
  );
}

/** 验收清单签名：优先使用管理审核实际审批人，旧订单回退到组长角色。 */
export async function resolveReimbursementListSignatures(order: {
  team: string;
  techGroup: string;
  teamApproverOpenId?: string | null;
  techGroupApproverOpenId?: string | null;
  initiator: { name: string; signaturePath: string | null };
}): Promise<ListSignatureContext> {
  const [storedTeamUser, storedTechUser, roleFallback] = await Promise.all([
    loadApproverUser(order.teamApproverOpenId),
    loadApproverUser(order.techGroupApproverOpenId),
    resolveRoleAdminSignatures(order.team, order.techGroup),
  ]);

  const teamUser = storedTeamUser ?? roleFallback.teamUser;
  const techUser = storedTechUser ?? roleFallback.techUser;

  return {
    acceptor1Path: teamUser?.signaturePath
      ? publicPathToAbsolute(teamUser.signaturePath)
      : null,
    acceptor2Path: techUser?.signaturePath
      ? publicPathToAbsolute(techUser.signaturePath)
      : null,
    receiverPath: order.initiator.signaturePath
      ? publicPathToAbsolute(order.initiator.signaturePath)
      : null,
    acceptor1Label: teamUser?.name ?? "车组组长",
    acceptor2Label: techUser?.name ?? "技术组组长",
    receiverLabel: order.initiator.name,
  };
}

export function assertListSignaturesReady(
  signatures: ListSignatureContext,
  requireAll: boolean,
): void {
  if (!requireAll) return;

  const missing: string[] = [];
  if (!signatures.acceptor1Path) {
    missing.push(`验收人 1（${signatures.acceptor1Label}）`);
  }
  if (!signatures.acceptor2Path) {
    missing.push(`验收人 2（${signatures.acceptor2Label}）`);
  }
  if (!signatures.receiverPath) {
    missing.push(`领用人（${signatures.receiverLabel}）`);
  }
  if (missing.length > 0) {
    throw new Error(
      `以下人员尚未上传电子签名，请先在「个人中心」上传：${missing.join("、")}`,
    );
  }
}
