// src/lib/i18n/context.tsx
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import { useSession } from "@/hooks/useSession";
import { t as translate } from "./t";
import type { Locale, TParams, TranslationKey } from "./types";

interface LocaleContextValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: TranslationKey, params?: TParams) => string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>("en");
  const session = useSession();
  const prevStatus = useRef(session.status);
  const savedLocale =
    session.status === "active"
      ? ("locale" in session.staff ? (session.staff.locale as Locale) : null)
      : null;

  // LOGIN-TRANSITION SEED (not continuous sync): apply the staffer's saved locale
  // only when the session transitions into "active". Afterwards the toggle is the
  // single writer, so an optimistic flip is never clobbered by a getSession refetch.
  useEffect(() => {
    const became = prevStatus.current !== "active" && session.status === "active";
    prevStatus.current = session.status;
    if (became) setLocale(savedLocale ?? "en");
    else if (session.status === "none") setLocale("en"); // reset on logout
  }, [session.status, savedLocale]);

  const t = useCallback(
    (key: TranslationKey, params?: TParams) => translate(locale, key, params),
    [locale],
  );
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, t]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useT() {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error("useT must be used within LocaleProvider");
  return ctx.t;
}

export function useLocale(): [Locale, (l: Locale) => void] {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error("useLocale must be used within LocaleProvider");
  return [ctx.locale, ctx.setLocale];
}
