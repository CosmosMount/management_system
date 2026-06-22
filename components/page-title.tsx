import { APP_NAME } from "@/lib/branding";

type Props = {
  subtitle?: string;
};

export function PageTitle({ subtitle }: Props) {
  return (
    <div className="mb-8">
      <h1 className="text-3xl font-bold tracking-tight text-foreground">
        {APP_NAME}
      </h1>
      {subtitle && (
        <p className="mt-2 text-lg text-muted-foreground">{subtitle}</p>
      )}
    </div>
  );
}
