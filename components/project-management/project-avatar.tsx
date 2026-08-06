import { FolderKanban } from "lucide-react";
import Image from "next/image";
import { cn } from "@/lib/utils";

export function ProjectAvatar({ name, avatarPath, className }: { name: string; avatarPath: string | null; className?: string }) {
  if (avatarPath) return <Image src={avatarPath} alt={`${name}头像`} width={80} height={80} unoptimized className={cn("size-12 shrink-0 rounded-xl object-cover ring-1 ring-border", className)} />;
  return <span className={cn("flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/15", className)} aria-label={`${name}默认头像`}><FolderKanban className="size-6" aria-hidden="true" /></span>;
}
