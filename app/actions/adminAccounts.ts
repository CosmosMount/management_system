"use server";

import { ZodError } from "zod";
import { requireGlobalSuperAdministrator } from "@/lib/account-authorization";
import {
  resolveAdminAccountOptionRecords,
  searchAdminAccountOptionPage,
} from "@/lib/admin-account-options";
import {
  resolveAdminAccountOptionsInputSchema,
  searchAdminAccountOptionsInputSchema,
} from "@/lib/validations/account-management";

function inputError(error: unknown): never {
  if (error instanceof ZodError) {
    throw new Error(error.issues[0]?.message ?? "提交的数据无效");
  }
  throw error;
}

export async function searchAdminAccountOptions(input: unknown) {
  try {
    const parsed = searchAdminAccountOptionsInputSchema.parse(input);
    await requireGlobalSuperAdministrator();
    const result = await searchAdminAccountOptionPage(parsed);
    return result;
  } catch (error) {
    inputError(error);
  }
}

export async function resolveAdminAccountOptionsByIds(input: unknown) {
  try {
    const parsed = resolveAdminAccountOptionsInputSchema.parse(input);
    await requireGlobalSuperAdministrator();
    const result = await resolveAdminAccountOptionRecords(parsed);
    return result;
  } catch (error) {
    inputError(error);
  }
}
