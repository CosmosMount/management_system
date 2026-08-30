"use client";

import Image from "next/image";
import { X } from "lucide-react";
import { useId, useState } from "react";
import {
  UserSelect,
  type UserPickerScope,
} from "@/components/project-management/user-picker";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field-error";
import type { PersonOptionDto } from "@/lib/project-management/types/time-canvas";

export type EditableTaskMember = {
  personId: string;
  role: "OWNER" | "PARTICIPANT";
};

export function TaskMemberRolePicker({
  members,
  people,
  scope,
  editable,
  onChange,
  onPersonResolved,
  protectedOwnerId,
  requireOwner = true,
  focusTargetId,
  error,
}: {
  members: EditableTaskMember[];
  people: PersonOptionDto[];
  scope: UserPickerScope;
  editable: boolean;
  onChange: (members: EditableTaskMember[]) => void;
  onPersonResolved?: (person: PersonOptionDto) => void;
  protectedOwnerId?: string;
  requireOwner?: boolean;
  focusTargetId?: string;
  error?: string | readonly string[];
}) {
  const [memberError, setMemberError] = useState("");
  const externalErrorId = useId();
  const hasExternalError =
    typeof error === "string" ? Boolean(error) : Boolean(error?.some(Boolean));
  const owners = members.filter((member) => member.role === "OWNER");
  const participants = members.filter((member) => member.role === "PARTICIPANT");

  const selectPerson = (
    personId: string | null,
    role: EditableTaskMember["role"],
  ) => {
    if (!personId) return;
    const existing = members.find((member) => member.personId === personId);
    if (existing?.role === role) return;
    if (existing?.role === "OWNER" && role === "PARTICIPANT" && personId === protectedOwnerId) {
      setMemberError("你当前是 Project 负责人，不能降级自己。");
      return;
    }
    if (requireOwner && existing?.role === "OWNER" && owners.length === 1) {
      setMemberError("至少保留一名负责人。");
      return;
    }
    setMemberError("");
    onChange(
      existing
        ? members.map((member) =>
            member.personId === personId ? { ...member, role } : member,
          )
        : [...members, { personId, role }],
    );
  };

  const removePerson = (personId: string) => {
    const member = members.find((item) => item.personId === personId);
    if (requireOwner && member?.role === "OWNER" && owners.length === 1) return;
    setMemberError("");
    onChange(members.filter((item) => item.personId !== personId));
  };

  return (
    <div
      id={focusTargetId}
      tabIndex={focusTargetId ? -1 : undefined}
      className="space-y-4"
      role="group"
      aria-label="成员与角色"
      aria-describedby={hasExternalError ? externalErrorId : undefined}
    >
      <MemberGroup
        label="负责人"
        role="OWNER"
        members={owners}
        people={people}
        scope={scope}
        editable={editable}
        lastOwnerId={
          requireOwner && owners.length === 1 ? owners[0]?.personId : undefined
        }
        protectedOwnerId={protectedOwnerId}
        placeholder="搜索负责人"
        onSelect={selectPerson}
        onRemove={removePerson}
        onPersonResolved={onPersonResolved}
      />
      <MemberGroup
        label="参与人员"
        role="PARTICIPANT"
        members={participants}
        people={people}
        scope={scope}
        editable={editable}
        placeholder="搜索参与人员"
        onSelect={selectPerson}
        onRemove={removePerson}
        onPersonResolved={onPersonResolved}
      />
      <FieldError id={externalErrorId} messages={error} />
      {memberError && <p className="text-sm text-destructive" role="alert">{memberError}</p>}
      {protectedOwnerId && owners.some((member) => member.personId === protectedOwnerId) && <p className="text-xs text-muted-foreground">你当前是 Project 负责人，不能移除或降级自己；请由其他负责人操作。</p>}
    </div>
  );
}

function MemberGroup({
  label,
  role,
  members,
  people,
  scope,
  editable,
  lastOwnerId,
  protectedOwnerId,
  placeholder,
  onSelect,
  onRemove,
  onPersonResolved,
}: {
  label: string;
  role: EditableTaskMember["role"];
  members: EditableTaskMember[];
  people: PersonOptionDto[];
  scope: UserPickerScope;
  editable: boolean;
  lastOwnerId?: string;
  protectedOwnerId?: string;
  placeholder: string;
  onSelect: (personId: string | null, role: EditableTaskMember["role"]) => void;
  onRemove: (personId: string) => void;
  onPersonResolved?: (person: PersonOptionDto) => void;
}) {
  return (
    <section className="space-y-2" aria-label={label}>
      <h4 className="text-sm font-medium">{label}</h4>
      {members.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {members.map((member) => {
            const person = people.find((item) => item.id === member.personId);
            const name = person?.displayName ?? "已选择成员";
            return (
              <span
                key={member.personId}
                className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-border bg-background py-1 pl-1 pr-2 text-sm shadow-sm"
              >
                <PersonAvatar person={person} name={name} />
                <span className="max-w-48 truncate">{name}</span>
                {editable && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="size-5 rounded-full"
                    disabled={member.personId === lastOwnerId || member.personId === protectedOwnerId}
                    aria-label={`移除 ${name} ${label}`}
                    onClick={() => onRemove(member.personId)}
                  >
                    <X className="size-3.5" aria-hidden="true" />
                  </Button>
                )}
              </span>
            );
          })}
        </div>
      )}
      {editable && (
        <UserSelect
          ariaLabel={placeholder}
          scope={scope}
          value={null}
          onValueChange={(personId) => onSelect(personId, role)}
          onOptionChange={(person) => {
            if (person) onPersonResolved?.(person);
          }}
          initialOptions={people}
          excludeIds={members.map((member) => member.personId)}
          clearable={false}
          placeholder={placeholder}
        />
      )}
    </section>
  );
}

function PersonAvatar({
  person,
  name,
}: {
  person: PersonOptionDto | undefined;
  name: string;
}) {
  return person?.avatar ? (
    <Image
      src={person.avatar}
      alt=""
      width={24}
      height={24}
      className="size-6 shrink-0 rounded-full object-cover"
    />
  ) : (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium">
      {name.slice(0, 1)}
    </span>
  );
}
