"use client";

import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import { ThemeProvider, useTheme } from "next-themes";
import { FINANCIAL_VALUES_STORAGE_KEY, THEME_STORAGE_KEY, nextFinancialValues, nextTheme, storedFinancialValues } from "@/lib/ui-preferences.mjs";

type UiPreferences = {
  theme: "light" | "dark";
  themeReady: boolean;
  valuesHidden: boolean;
  toggleTheme: () => void;
  toggleFinancialValues: () => void;
};

const UiPreferencesContext = createContext<UiPreferences | null>(null);
const financialValuesEvent = "ncf-financial-values-change";
const subscribeToMount = () => () => {};
const mountedClientSnapshot = () => true;
const mountedServerSnapshot = () => false;

function subscribeToFinancialValues(onStoreChange: () => void) {
  window.addEventListener("storage", onStoreChange);
  window.addEventListener(financialValuesEvent, onStoreChange);
  return () => {
    window.removeEventListener("storage", onStoreChange);
    window.removeEventListener(financialValuesEvent, onStoreChange);
  };
}

function financialValuesSnapshot() {
  return storedFinancialValues(window.localStorage.getItem(FINANCIAL_VALUES_STORAGE_KEY));
}

function FinancialPrivacyProvider({ children }: { children: React.ReactNode }) {
  const { resolvedTheme, setTheme } = useTheme();
  const themeReady = useSyncExternalStore(subscribeToMount, mountedClientSnapshot, mountedServerSnapshot);
  const valuesMode = useSyncExternalStore(subscribeToFinancialValues, financialValuesSnapshot, () => "visible");

  useEffect(() => {
    document.documentElement.dataset.financialValues = valuesMode;
  }, [valuesMode]);

  const value = useMemo<UiPreferences>(() => ({
    theme: resolvedTheme === "dark" ? "dark" : "light",
    themeReady,
    valuesHidden: valuesMode === "hidden",
    toggleTheme: () => {
      if (themeReady) setTheme(nextTheme(resolvedTheme));
    },
    toggleFinancialValues: () => {
      const next = nextFinancialValues(financialValuesSnapshot());
      window.localStorage.setItem(FINANCIAL_VALUES_STORAGE_KEY, next);
      document.documentElement.dataset.financialValues = next;
      window.dispatchEvent(new Event(financialValuesEvent));
    },
  }), [resolvedTheme, setTheme, themeReady, valuesMode]);

  return <UiPreferencesContext.Provider value={value}>{children}</UiPreferencesContext.Provider>;
}

export function UiPreferencesProvider({ children }: { children: React.ReactNode }) {
  return <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} storageKey={THEME_STORAGE_KEY} disableTransitionOnChange><FinancialPrivacyProvider>{children}</FinancialPrivacyProvider></ThemeProvider>;
}

export function useUiPreferences() {
  const value = useContext(UiPreferencesContext);
  if (!value) throw new Error("useUiPreferences deve ser usado dentro de UiPreferencesProvider.");
  return value;
}
