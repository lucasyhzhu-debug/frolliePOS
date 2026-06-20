import { useT } from "@/lib/i18n";

/**
 * Stub — temporary placeholder for routes that are scaffolded but not yet
 * implemented. Each Wave 5-7 task replaces a stub with the real screen.
 * Kept around so partial-checkpoint state still renders something coherent.
 */
export default function Stub({ name }: { name: string }) {
  const t = useT();
  return (
    <main className="flex-1 grid place-items-center p-6">
      <div className="max-w-sm rounded-xl border border-border bg-card p-6 text-center shadow-sm">
        <div className="text-xs uppercase tracking-widest text-muted-foreground">{t("stub.brand")}</div>
        <h1 className="mt-2 text-2xl font-semibold">{name}</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          {t("stub.body")}
        </p>
      </div>
    </main>
  );
}
