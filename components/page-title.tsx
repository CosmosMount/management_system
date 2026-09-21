import { APP_NAME } from "@/lib/branding";

type Props = {
  subtitle?: string;
};

export function PageTitle({ subtitle }: Props) {
  return (
    <div className="mb-6 min-w-0 [overflow-wrap:anywhere] sm:mb-8">
      <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
        {APP_NAME}
      </h1>
      {subtitle && (
        <p className="mt-2 text-lg text-muted-foreground">{subtitle}</p>
      )}
    </div>
  );
}
