import type {
  Account,
  AccountIdentity,
  Person,
  ProjectManagementSystemRole,
  User,
} from "@prisma/client";

export type ProjectManagementIdentityInput = {
  openId: string;
  unionId?: string | null;
  name?: string | null;
  avatar?: string | null;
};

export type ProjectManagementActor = {
  accountId: string;
  personId: string;
  openId: string;
  unionId?: string | null;
  /** 运行时身份解析会显式设置；省略仅用于既有领域测试 fixture。 */
  isActive?: boolean;
  systemRoles: ProjectManagementSystemRoleRecord[];
};

export type ProjectManagementSystemRoleRecord = {
  role: ProjectManagementSystemRole;
  team: string;
  techGroup: string;
};

export type ResolvedProjectManagementIdentity = {
  account: Account;
  identity: AccountIdentity;
  person: Person;
  reimbursementUser: User;
  created: boolean;
  reimbursementUserCreated: boolean;
};

export class ProjectManagementIdentityError extends Error {
  constructor(
    readonly code:
      | "UNAUTHENTICATED"
      | "IDENTITY_CONFLICT"
      | "VALIDATION_ERROR",
    message: string,
  ) {
    super(message);
    this.name = "ProjectManagementIdentityError";
  }
}
