import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  addSummaryMonths,
  currentSummaryMonthInSaoPaulo,
  parseSummaryResponse,
  summaryDateLabel,
  summaryMonthLabel,
  summaryMonthOptions,
  uniqueSummaryWarnings,
} from "../lib/chatgpt-financial-summary-ui.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const component = read("../app/finance-chatgpt-summary.tsx");
const shell = read("../app/finance-app.tsx");

function response(overrides = {}) {
  return {
    month: "2026-09",
    generatedAt: "2026-09-18T12:00:00.000Z",
    asOfDate: "2026-09-18",
    summaryText: "Resumo completo\n- Saldo: R$ 100,00",
    warnings: [{ code: "LIMIT", message: "Cobertura limitada." }],
    ...overrides,
  };
}

test("competência padrão respeita a virada civil de America/Sao_Paulo", () => {
  assert.equal(currentSummaryMonthInSaoPaulo(new Date("2026-10-01T02:59:59.000Z")), "2026-09");
  assert.equal(currentSummaryMonthInSaoPaulo(new Date("2026-10-01T03:00:00.000Z")), "2026-10");
});

test("seletor oferece somente mês atual até 23 meses à frente", () => {
  const options = summaryMonthOptions(new Date("2026-10-08T12:00:00.000Z"));
  assert.equal(options.length, 24);
  assert.equal(options[0].value, "2026-10");
  assert.equal(options[23].value, "2028-09");
  assert.equal(addSummaryMonths("2026-12", 1), "2027-01");
  assert.equal(summaryMonthLabel("2027-01"), "janeiro de 2027");
  assert.equal(summaryDateLabel("2026-09-18"), "18/09/2026");
});

test("resposta aceita somente a competência solicitada e contrato público mínimo", () => {
  assert.deepEqual(parseSummaryResponse(response(), "2026-09"), response());
  assert.throws(() => parseSummaryResponse(response({ month: "2026-10" }), "2026-09"), /Competência divergente/u);
  assert.throws(() => parseSummaryResponse(response({ summaryText: null }), "2026-09"), /Resposta inválida/u);
  assert.throws(() => parseSummaryResponse(response({ warnings: [{ code: "X", message: 10 }] }), "2026-09"), /Resposta inválida/u);
});

test("warnings idênticos são exibidos uma única vez sem mudar sua mensagem", () => {
  const warnings = [{ code: "A", message: "Aviso A" }, { code: "A", message: "Aviso A" }, { code: "A", message: "Aviso B" }];
  assert.deepEqual(uniqueSummaryWarnings(warnings), [warnings[0], warnings[2]]);
});

test("navegação adiciona Resumo após Previsão somente no menu lateral", () => {
  const forecast = shell.indexOf('{ id: "forecast", label: "Previsão"');
  const summary = shell.indexOf('{ id: "chatgpt-summary", label: "Resumo para o ChatGPT"');
  assert.ok(forecast >= 0 && summary > forecast);
  assert.match(shell, /view === "chatgpt-summary".*<FinanceChatGptSummary/u);
  assert.match(shell, /setMobileOpen\(false\)/u);
  assert.match(shell, /\["dashboard", "reports", "forecast", "transactions", "bills", "settings"\]/u);
  assert.match(shell, /grid-cols-6/u);
  assert.doesNotMatch(shell, /\["dashboard", "reports", "forecast", "chatgpt-summary"/u);
});

test("componente consulta exclusivamente a API read-only existente", () => {
  assert.match(component, /\/api\/finance\/chatgpt-summary\?month=\$\{encodeURIComponent\(month\)\}/u);
  assert.match(component, /method: "GET"/u);
  assert.match(component, /cache: "no-store"/u);
  assert.doesNotMatch(component, /method: "(?:POST|PUT|PATCH|DELETE)"/u);
  assert.doesNotMatch(component, /householdId|userId|amountCents|balanceCents/u);
});

test("troca de competência invalida tela anterior e bloqueia respostas fora de ordem", () => {
  assert.match(component, /new AbortController\(\)/u);
  assert.match(component, /return \(\) => controller\.abort\(\)/u);
  assert.match(component, /requestSequence\.current !== requestId/u);
  assert.match(component, /next\.month !== selectedMonth/u);
  assert.match(component, /setSummary\(null\);\s*setError\(null\);\s*setCopyStatus\("idle"\);\s*setSelectedMonth\(month\)/u);
  assert.doesNotMatch(component, /NativeSelect[^>]*disabled=\{loading\}/u);
});

test("preview reproduz summaryText completo sem interpretar valores", () => {
  assert.match(component, /whitespace-pre-wrap/u);
  assert.match(component, /overflow-auto/u);
  assert.match(component, /\{summary\.summaryText\}/u);
  assert.doesNotMatch(component, /\.split\(|\.slice\(|substring\(|line-clamp/u);
  assert.doesNotMatch(component, /Intl\.NumberFormat|formatFinancialCents|parseFloat|reduce\(/u);
});

test("privacidade remove resumo e warnings do DOM e desabilita cópia", () => {
  assert.match(component, /valuesHidden \? <PrivacyShield \/> : hasText \? <SummaryPreview summary=\{validSummary\}/u);
  assert.match(component, /const canCopy = !valuesHidden && !loading && hasText/u);
  assert.match(component, /disabled=\{!canCopy \|\| copyStatus === "copying"\}/u);
  assert.match(component, /Revele os valores financeiros para habilitar a cópia/u);
  assert.doesNotMatch(component, /display:\s*none|visibility:\s*hidden|opacity-0.*summaryText/u);
});

test("cópia usa exatamente summaryText e só confirma após a Promise", () => {
  const awaitCopy = component.indexOf("await navigator.clipboard.writeText(validSummary.summaryText)");
  const success = component.indexOf('setCopyStatus("success")');
  assert.ok(awaitCopy >= 0 && success > awaitCopy);
  assert.doesNotMatch(component, /writeText\([^)]*(?:prefix|month|generatedAt)/u);
  assert.match(component, /Não foi possível copiar o resumo/u);
  assert.match(component, /aria-live="polite"/u);
});

test("loading, erro, retry, vazio e sessão expirada são explícitos", () => {
  for (const expected of ["aria-busy=\"true\"", "Não foi possível carregar o resumo", "Tentar novamente", "Resumo vazio", "Sessão expirada"]) {
    assert.match(component, new RegExp(expected, "u"));
  }
  assert.match(component, /response\.status === 401/u);
  assert.match(component, /setRetryKey\(\(value\) => value \+ 1\)/u);
});

test("warnings vêm da API, são deduplicados e não geram conteúdo financeiro novo", () => {
  assert.match(component, /summary\.warnings\.map/u);
  assert.match(component, /\{warning\.message\}/u);
  assert.match(component, /parseSummaryResponse\(body, month\)/u);
  assert.doesNotMatch(component, /warning\.code\s*===|switch\s*\(warning/u);
});

test("nenhum resumo bruto é enviado a console, analytics ou atributos HTML", () => {
  assert.doesNotMatch(component, /console\.|analytics|data-summary|title=\{[^}]*summary|aria-label=\{[^}]*summary\.summaryText/u);
  assert.doesNotMatch(component, /dangerouslySetInnerHTML/u);
});

test("layout usa tokens de tema, responsividade e controles acessíveis", () => {
  for (const token of ["bg-card", "text-card-foreground", "text-muted-foreground", "border-border", "text-primary", "text-destructive"]) {
    assert.match(component, new RegExp(token, "u"));
  }
  assert.doesNotMatch(component, /#[0-9a-f]{3,8}/iu);
  assert.match(component, /sm:grid-cols-3/u);
  assert.match(component, /htmlFor="chatgpt-summary-month"/u);
  assert.match(component, /aria-labelledby="chatgpt-summary-title"/u);
  assert.match(component, /role="alert"/u);
});
