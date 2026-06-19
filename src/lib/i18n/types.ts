// src/lib/i18n/types.ts
import { en } from "./dictionaries/en";

export type Locale = "en" | "id";
export type TranslationKey = keyof typeof en;
export type TParams = Record<string, string | number>;
