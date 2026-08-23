import { cn } from "@/lib/utils";

type FieldErrorProps = {
  id?: string;
  messages?: string | readonly string[] | null;
  className?: string;
};

export function FieldError({ id, messages, className }: FieldErrorProps) {
  const visibleMessages = (Array.isArray(messages) ? messages : [messages]).filter(
    (message): message is string => Boolean(message),
  );
  if (visibleMessages.length === 0) return null;
  if (visibleMessages.length === 1) {
    return (
      <p
        id={id}
        className={cn("text-sm text-destructive", className)}
        role="alert"
      >
        {visibleMessages[0]}
      </p>
    );
  }
  return (
    <ul
      id={id}
      className={cn("space-y-1 text-sm text-destructive", className)}
      role="alert"
    >
      {visibleMessages.map((message, index) => (
        <li key={`${message}:${index}`}>{message}</li>
      ))}
    </ul>
  );
}
