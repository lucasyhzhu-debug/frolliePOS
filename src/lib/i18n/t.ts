// src/lib/i18n/t.ts
import { en } from "./dictionaries/en";
import { id } from "./dictionaries/id";
import type { Locale, TParams, TranslationKey } from "./types";

const DICTS: Record<Locale, Record<string, string>> = { en, id };

function interpolate(template: string, params?: TParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_m, k) =>
    k in params ? String(params[k]) : `{${k}}`,
  );
}

/**
 * Pure translation lookup. Plural rule (the only grammar): keys authored as
 * `${base}_one` / `${base}_other`; callers reference the `_other` key and pass a
 * numeric `count`. English swaps to `_one` when count === 1; Indonesian (analytic)
 * always uses `_other`.
 */
export function t(locale: Locale, key: TranslationKey, params?: TParams): string {
  const dict = DICTS[locale];
  let k: string = key;
  if (
    params &&
    typeof params.count === "number" &&
    locale === "en" &&
    params.count === 1 &&
    key.endsWith("_other")
  ) {
    const oneKey = key.slice(0, -"_other".length) + "_one";
    if (oneKey in dict) k = oneKey;
  }
  const template = dict[k] ?? en[k as TranslationKey] ?? k;
  return interpolate(template, params);
}
