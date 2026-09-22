import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  FINANCIAL_VALUES_MASK,
  FINANCIAL_VALUES_STORAGE_KEY,
  THEME_STORAGE_KEY,
  formatFinancialCents,
  nextFinancialValues,
  nextTheme,
  storedFinancialValues,
  storedTheme,
} from "../lib/ui-preferences.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const provider = read("../app/ui-preferences.tsx");
const layout = read("../app/layout.tsx");
const financeApp = read("../app/finance-app.tsx");
const themeToggle = read("../app/theme-toggle.tsx");
const styles = read("../app/globals.css");

test("tema mantém claro como padrão e alterna nos dois sentidos", () => {
  assert.equal(storedTheme(null), "light");
  assert.equal(storedTheme("invalid"), "light");
  assert.equal(nextTheme("light"), "dark");
  assert.equal(nextTheme("dark"), "light");
});

test("preferências usam armazenamento local e next-themes sem banco ou API", () => {
  assert.equal(THEME_STORAGE_KEY, "ncf-theme");
  assert.equal(FINANCIAL_VALUES_STORAGE_KEY, "ncf-financial-values");
  assert.match(provider, /ThemeProvider/u);
  assert.match(provider, /window\.localStorage\.getItem\(FINANCIAL_VALUES_STORAGE_KEY\)/u);
  assert.match(provider, /window\.localStorage\.setItem\(FINANCIAL_VALUES_STORAGE_KEY, next\)/u);
  assert.doesNotMatch(provider, /fetch\(|\/api\//u);
});

test("tema cobre raiz, autenticação, modal, inputs e estados disabled", () => {
  assert.match(layout, /suppressHydrationWarning/u);
  assert.match(layout, /UiPreferencesProvider/u);
  assert.match(styles, /\.dark \{/u);
  assert.match(styles, /\[role="dialog"\]/u);
  assert.match(styles, /input:disabled/u);
  assert.match(read("../app/auth-shell.tsx"), /ThemeToggle/u);
  assert.match(read("../app/page.tsx"), /ThemeToggle/u);
  assert.match(provider, /themeReady/u);
  assert.match(provider, /useSyncExternalStore\(subscribeToMount, mountedClientSnapshot, mountedServerSnapshot\)/u);
  assert.match(themeToggle, /aria-label=\{dark \? "Ativar tema claro" : "Ativar tema escuro"\}/u);
});

test("privacidade alterna, mascara sem inventar zero e preserva o número", () => {
  const cents = 325689;
  assert.equal(storedFinancialValues(null), "visible");
  assert.equal(nextFinancialValues("visible"), "hidden");
  assert.equal(nextFinancialValues("hidden"), "visible");
  assert.equal(formatFinancialCents(cents, { hidden: true }), FINANCIAL_VALUES_MASK);
  assert.equal(formatFinancialCents(cents, { hidden: false }), "R$ 3.256,89");
  assert.equal(cents, 325689);
  assert.doesNotMatch(FINANCIAL_VALUES_MASK, /0,00/u);
});

test("cabeçalho expõe controles acessíveis de olho e sol/lua", () => {
  assert.match(financeApp, /EyeOff/u);
  assert.match(financeApp, /Ocultar valores financeiros/u);
  assert.match(financeApp, /Exibir valores financeiros/u);
  assert.match(financeApp, /aria-pressed=\{valuesHidden\}/u);
  assert.match(financeApp, /ThemeToggle/u);
  assert.match(financeApp, /TooltipContent/u);
});

test("Dashboard, conta, vencimento, cartão, fatura e relatórios usam o mesmo formatador", () => {
  const covered = [
    "../app/finance-dashboard.tsx",
    "../app/account-statement.tsx",
    "../app/advanced-finance.tsx",
    "../app/invoice-detail-dialog.tsx",
    "../app/invoice-lifecycle.tsx",
    "../app/finance-reports.tsx",
    "../app/card-onboarding-dialog.tsx",
    "../app/card-existing-installment-dialog.tsx",
  ].map(read).join("\n");
  assert.match(covered, /formatFinancialCents/u);
  for (const source of ["finance-dashboard", "advanced-finance", "invoice-detail-dialog", "finance-reports"]) {
    assert.match(read(`../app/${source}.tsx`), /formatFinancialCents/u);
  }
  assert.match(read("../lib/account-statement-ui.mjs"), /formatFinancialCents/u);
});

test("preferência visual não altera transportes nem cálculos financeiros", () => {
  const utility = read("../lib/ui-preferences.mjs");
  assert.doesNotMatch(utility, /fetch\(|POST|PUT|DELETE|amountCents\s*=|cents\s*[+*-]=/u);
  assert.match(utility, /\.format\(cents \/ 100\)/u);
});
