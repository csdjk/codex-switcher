import { useEffect, useSyncExternalStore } from "react";
import { zh } from "./translations.ts";

export type Language = "en" | "zh";
export type MessageKey = keyof typeof zh;
export const LANGUAGE_STORAGE_KEY = "codex-switcher-language";
const LANGUAGE_EVENT = "language-changed";
const subscribers = new Set<() => void>();

export function resolveLanguage(saved: string | null, systemLanguage: string): Language {
  return saved === "en" || saved === "zh" ? saved : /^zh\b/i.test(systemLanguage) ? "zh" : "en";
}

function readLanguage(): Language {
  let saved: string | null = null;
  try {
    if (typeof window !== "undefined") saved = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  } catch (error) {
    console.warn("Could not read language preference", error);
  }
  return resolveLanguage(saved, typeof navigator === "undefined" ? "en" : navigator.language);
}

let language = readLanguage();
export function getLocale(): string { return language === "zh" ? "zh-CN" : "en-US"; }
export function pluralSuffix(count: number): string { return language === "en" && count !== 1 ? "s" : ""; }

export function translate(locale: Language, key: MessageKey, values: readonly (string | number)[] = []): string {
  const template = locale === "zh" ? zh[key] : key;
  return template.replace(/\{(\d+)\}/g, (match, index: string) => String(values[Number(index)] ?? match));
}

export function t(key: MessageKey, ...values: (string | number)[]): string {
  return translate(language, key, values);
}

// Only translate known application errors; preserve server diagnostics verbatim.
export function localizeMessage(message: string): string {
  return Object.prototype.hasOwnProperty.call(zh, message) ? t(message as MessageKey) : message;
}

function applyLanguage(next: Language): void {
  language = next;
  if (typeof document !== "undefined") document.documentElement.lang = getLocale();
  subscribers.forEach((notify) => notify());
}

export async function setLanguage(next: Language): Promise<void> {
  // Failed persistence is surfaced to the selector instead of silently pretending it saved.
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
  applyLanguage(next);
  if ("__TAURI_INTERNALS__" in window) {
    const { emit } = await import("@tauri-apps/api/event");
    await emit(LANGUAGE_EVENT, next);
  }
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify);
  return () => { subscribers.delete(notify); };
}

// Subscribe once in each window root; changing locale never remounts account forms.
export function useLanguage(): Language {
  const current = useSyncExternalStore(subscribe, () => language, () => "en" as Language);
  useEffect(() => {
    applyLanguage(readLanguage());
    const onStorage = (event: StorageEvent) => {
      if (event.key === LANGUAGE_STORAGE_KEY || event.key === null) applyLanguage(readLanguage());
    };
    window.addEventListener("storage", onStorage);
    let disposed = false;
    let stop: (() => void) | undefined;
    if ("__TAURI_INTERNALS__" in window) {
      void import("@tauri-apps/api/event").then(async ({ listen, emit }) => {
        const unlisten = await listen<Language>(LANGUAGE_EVENT, ({ payload }) => {
          if (payload === "zh" || payload === "en") applyLanguage(payload);
        });
        if (disposed) unlisten(); else stop = unlisten;
        // Catch changes while the listener was being registered.
        applyLanguage(readLanguage());
        if (!disposed) await emit(LANGUAGE_EVENT, language);
      }).catch((error) => console.error("Could not synchronize language", error));
    }
    return () => { disposed = true; stop?.(); window.removeEventListener("storage", onStorage); };
  }, []);
  return current;
}
