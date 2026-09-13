import { prisma } from "@/lib/prisma";
import {
  materialIdSchema,
  materialListSchema,
  materialQrTokenSchema,
} from "@/lib/material-management/validations";

const activeLoanSelect = {
  id: true,
  borrowerAccountId: true,
  checkedOutAt: true,
  borrowerAccount: {
    select: {
      person: {
        select: {
          displayName: true,
          avatar: true,
        },
      },
    },
  },
} as const;

export type MaterialListItem = {
  id: string;
  name: string;
  price: string;
  techGroup: string;
  createdAt: string;
  activeLoan: {
    id: string;
    borrowerAccountId: string;
    borrowerName: string;
    borrowerAvatar: string | null;
    checkedOutAt: string;
  } | null;
};

export async function listMaterials(input: unknown) {
  const parsed = materialListSchema.parse(input);
  const where = {
    ...(parsed.query
      ? { name: { contains: parsed.query, mode: "insensitive" as const } }
      : {}),
    ...(parsed.techGroup ? { techGroup: parsed.techGroup } : {}),
    ...(parsed.status === "AVAILABLE"
      ? { loans: { none: { returnedAt: null } } }
      : parsed.status === "IN_USE"
        ? { loans: { some: { returnedAt: null } } }
        : {}),
  };

  const { totalCount, inUseCount, rows } = await prisma.$transaction(
    async (tx) => {
      // The pg adapter uses one client per interactive transaction, so keep
      // these reads sequential instead of overlapping client.query() calls.
      const totalCount = await tx.material.count();
      const inUseCount = await tx.materialLoan.count({
        where: { returnedAt: null },
      });
      const rows = await tx.material.findMany({
        where,
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        take: 101,
        select: {
          id: true,
          name: true,
          price: true,
          techGroup: true,
          createdAt: true,
          loans: {
            where: { returnedAt: null },
            take: 1,
            select: activeLoanSelect,
          },
        },
      });

      return { totalCount, inUseCount, rows };
    },
  );

  return {
    totalCount,
    inUseCount,
    availableCount: totalCount - inUseCount,
    hasMore: rows.length > 100,
    items: rows.slice(0, 100).map((row) => serializeListItem(row)),
  };
}

export async function getMaterialDetail(materialId: unknown) {
  const id = materialIdSchema.parse(materialId);
  const material = await prisma.material.findUnique({
    where: { id },
    select: {
      id: true,
      qrToken: true,
      name: true,
      price: true,
      techGroup: true,
      createdAt: true,
      createdByAccount: {
        select: { person: { select: { displayName: true } } },
      },
      loans: {
        orderBy: { checkedOutAt: "desc" },
        take: 20,
        select: {
          id: true,
          checkedOutAt: true,
          returnedAt: true,
          returnPhotoPath: true,
          borrowerAccountId: true,
          borrowerAccount: {
            select: {
              person: {
                select: { displayName: true, avatar: true },
              },
            },
          },
        },
      },
    },
  });
  if (!material) return null;

  const activeLoan = material.loans.find((loan) => loan.returnedAt === null);
  return {
    id: material.id,
    qrToken: material.qrToken,
    name: material.name,
    price: material.price.toFixed(2),
    techGroup: material.techGroup,
    createdAt: material.createdAt.toISOString(),
    createdByName:
      material.createdByAccount.person?.displayName ?? "未知用户",
    activeLoan: activeLoan ? serializeLoan(activeLoan) : null,
    history: material.loans.map(serializeLoan),
  };
}

export async function getMaterialByQrToken(qrToken: unknown) {
  const token = materialQrTokenSchema.parse(qrToken);
  const material = await prisma.material.findUnique({
    where: { qrToken: token },
    select: {
      id: true,
      qrToken: true,
      name: true,
      price: true,
      techGroup: true,
      loans: {
        where: { returnedAt: null },
        take: 1,
        select: activeLoanSelect,
      },
    },
  });
  if (!material) return null;
  return {
    id: material.id,
    qrToken: material.qrToken,
    name: material.name,
    price: material.price.toFixed(2),
    techGroup: material.techGroup,
    activeLoan: material.loans[0]
      ? serializeLoan(material.loans[0])
      : null,
  };
}

function serializeListItem(row: {
  id: string;
  name: string;
  price: { toFixed(digits: number): string };
  techGroup: string;
  createdAt: Date;
  loans: Array<{
    id: string;
    borrowerAccountId: string;
    checkedOutAt: Date;
    borrowerAccount: {
      person: { displayName: string; avatar: string | null } | null;
    };
  }>;
}): MaterialListItem {
  const activeLoan = row.loans[0];
  return {
    id: row.id,
    name: row.name,
    price: row.price.toFixed(2),
    techGroup: row.techGroup,
    createdAt: row.createdAt.toISOString(),
    activeLoan: activeLoan ? serializeLoan(activeLoan) : null,
  };
}

function serializeLoan(loan: {
  id: string;
  borrowerAccountId: string;
  checkedOutAt: Date;
  returnedAt?: Date | null;
  returnPhotoPath?: string | null;
  borrowerAccount: {
    person: { displayName: string; avatar: string | null } | null;
  };
}) {
  return {
    id: loan.id,
    borrowerAccountId: loan.borrowerAccountId,
    borrowerName:
      loan.borrowerAccount.person?.displayName ?? "未知用户",
    borrowerAvatar: loan.borrowerAccount.person?.avatar ?? null,
    checkedOutAt: loan.checkedOutAt.toISOString(),
    returnedAt: loan.returnedAt?.toISOString() ?? null,
    returnPhotoPath: loan.returnPhotoPath ?? null,
  };
}
