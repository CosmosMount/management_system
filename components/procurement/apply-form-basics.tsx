"use client";

import { Controller, type UseFormReturn } from "react-hook-form";
import type { ApplyFormValues } from "@/components/procurement/apply-form-contract";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { FieldError } from "@/components/ui/field-error";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TEAM_OPTIONS, TECH_GROUP_OPTIONS } from "@/lib/constants";

export function ApplyFormBasics({ form }: { form: UseFormReturn<ApplyFormValues> }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>基本信息</CardTitle>
        <CardDescription>选择车组与技术组</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="purchase-team">车组</Label>
          <Controller
            control={form.control}
            name="team"
            render={({ field }) => (
              <Select value={field.value ?? ""} onValueChange={field.onChange}>
                <SelectTrigger
                  ref={field.ref}
                  id="purchase-team"
                  className="w-full"
                  aria-invalid={Boolean(form.formState.errors.team)}
                  aria-describedby={
                    form.formState.errors.team ? "purchase-team-error" : undefined
                  }
                >
                  <SelectValue placeholder="请选择车组" />
                </SelectTrigger>
                <SelectContent>
                  {TEAM_OPTIONS.map((team) => (
                    <SelectItem key={team} value={team}>{team}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
          <FieldError
            id="purchase-team-error"
            messages={form.formState.errors.team?.message}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="purchase-tech-group">技术组</Label>
          <Controller
            control={form.control}
            name="techGroup"
            render={({ field }) => (
              <Select value={field.value ?? ""} onValueChange={field.onChange}>
                <SelectTrigger
                  ref={field.ref}
                  id="purchase-tech-group"
                  className="w-full"
                  aria-invalid={Boolean(form.formState.errors.techGroup)}
                  aria-describedby={
                    form.formState.errors.techGroup
                      ? "purchase-tech-group-error"
                      : undefined
                  }
                >
                  <SelectValue placeholder="请选择技术组" />
                </SelectTrigger>
                <SelectContent>
                  {TECH_GROUP_OPTIONS.map((group) => (
                    <SelectItem key={group} value={group}>{group}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
          <FieldError
            id="purchase-tech-group-error"
            messages={form.formState.errors.techGroup?.message}
          />
        </div>
      </CardContent>
    </Card>
  );
}
