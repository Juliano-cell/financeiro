import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const source = read("../app/theme-toggle.tsx");
const providerSource = read("../app/ui-preferences.tsx");
let preference = { theme: "light", themeReady: false, toggleTheme() {} };

const passthrough = ({ children }) => children;
const tooltipPrimitives = {
  Tooltip: passthrough,
  TooltipContent: ({ children }) => jsxRuntime.jsx("span", { children }),
  TooltipProvider: passthrough,
  TooltipTrigger: passthrough,
};
const icons = {
  Moon: (props) => jsxRuntime.jsx("svg", { ...props, "data-icon": "moon" }),
  Sun: (props) => jsxRuntime.jsx("svg", { ...props, "data-icon": "sun" }),
};

const compiled = ts.transpileModule(source, {
  compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const exports = {};
new Function("exports", "require", compiled)(exports, (name) => {
  if (name === "react/jsx-runtime") return jsxRuntime;
  if (name === "lucide-react") return icons;
  if (name === "@/app/ui-preferences") return { useUiPreferences: () => preference };
  if (name === "@/components/ui/tooltip") return tooltipPrimitives;
  throw new Error(`Dependência inesperada no teste de hidratação: ${name}`);
});
const { ThemeToggle } = exports;

function renderThemeToggle(nextPreference) {
  preference = { ...preference, ...nextPreference };
  return renderToStaticMarkup(createElement(ThemeToggle));
}

test("SSR e primeiro render do cliente são idênticos com tema escuro persistido", () => {
  const server = renderThemeToggle({ theme: "light", themeReady: false });
  const hydratingClient = renderThemeToggle({ theme: "dark", themeReady: false });
  assert.equal(hydratingClient, server);
  assert.match(server, /aria-hidden="true"/u);
  assert.match(server, /h-10 w-10/u);
  assert.doesNotMatch(server, /<button|aria-pressed|Ativar tema/u);
});

test("após mount o controle representa corretamente tema claro e escuro", () => {
  const light = renderThemeToggle({ theme: "light", themeReady: true });
  assert.match(light, /type="button"/u);
  assert.match(light, /aria-label="Ativar tema escuro"/u);
  assert.match(light, /aria-pressed="false"/u);
  assert.match(light, /data-icon="moon"/u);

  const dark = renderThemeToggle({ theme: "dark", themeReady: true });
  assert.match(dark, /type="button"/u);
  assert.match(dark, /aria-label="Ativar tema claro"/u);
  assert.match(dark, /aria-pressed="true"/u);
  assert.match(dark, /data-icon="sun"/u);
});

test("provider usa snapshot SSR determinístico e libera o tema somente no cliente", () => {
  assert.match(providerSource, /const mountedClientSnapshot = \(\) => true/u);
  assert.match(providerSource, /const mountedServerSnapshot = \(\) => false/u);
  assert.match(providerSource, /useSyncExternalStore\(subscribeToMount, mountedClientSnapshot, mountedServerSnapshot\)/u);
  assert.match(providerSource, /if \(themeReady\) setTheme/u);
});

test("página inicial, autenticação e Dashboard reutilizam o controle protegido", () => {
  assert.match(read("../app/page.tsx"), /ThemeToggle/u);
  assert.match(read("../app/auth-shell.tsx"), /ThemeToggle/u);
  assert.match(read("../app/finance-app.tsx"), /ThemeToggle/u);
});
