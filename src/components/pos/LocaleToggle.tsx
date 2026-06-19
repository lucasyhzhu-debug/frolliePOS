// src/components/pos/LocaleToggle.tsx
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { motion, useReducedMotion } from "framer-motion";
import { api } from "../../../convex/_generated/api";
import { useSession } from "@/hooks/useSession";
import { useLocale, useT } from "@/lib/i18n";
import { Card } from "@/components/ui/card";
import { gridItemVariants } from "@/lib/motion";
import { FlagGB, FlagID } from "./flags";

export function LocaleToggle() {
  const [locale, setLocale] = useLocale();
  const t = useT();
  const session = useSession();
  const setOwnLocale = useMutation(api.staff.public.setOwnLocale);
  const reduce = useReducedMotion() ?? false;

  const next = locale === "en" ? "id" : "en";
  const currentName = locale === "en" ? t("locale.english") : t("locale.bahasa");
  const nextName = next === "en" ? t("locale.english") : t("locale.bahasa");

  const onToggle = async () => {
    if (session.status !== "active") return;
    const prev = locale;
    setLocale(next); // optimistic — provider is the single writer post-login
    try {
      await setOwnLocale({ idempotencyKey: crypto.randomUUID(), sessionId: session.sessionId, locale: next });
    } catch {
      setLocale(prev); // revert
      toast.error(t("locale.saveFailed")); // async failure stays a toast (#12 policy)
    }
  };

  const Flag = locale === "en" ? FlagGB : FlagID;

  return (
    <motion.div variants={gridItemVariants(reduce)}>
      <Card className="relative overflow-hidden p-0">
        <button
          type="button"
          role="switch"
          aria-checked={locale === "id"}
          aria-label={t("locale.toggleLabel", { current: currentName, next: nextName })}
          onClick={onToggle}
          className="relative block w-full min-h-[64px] text-left"
        >
          <Flag className="absolute inset-0 h-full w-full object-cover" />
          <span className="absolute inset-0 bg-foreground/45" aria-hidden />
          <span className="relative flex items-center justify-between gap-2 p-3 text-background">
            <span className="text-sm font-semibold drop-shadow">{currentName}</span>
            <span aria-hidden className="text-lg leading-none drop-shadow">⇄</span>
          </span>
        </button>
      </Card>
    </motion.div>
  );
}
