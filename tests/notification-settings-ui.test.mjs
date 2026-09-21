import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const frontend = readFileSync(new URL("../app/advanced-finance.tsx", import.meta.url), "utf8");
const route = readFileSync(new URL("../app/api/notifications/preferences/route.ts", import.meta.url), "utf8");
const settings = frontend.slice(frontend.indexOf("function TelegramSettings"), frontend.indexOf("function Heading"));

test("Configurações possui seção simples de Notificações", () => {
  assert.match(settings, /<h3 className="font-semibold">Notificações<\/h3>/u);
  assert.match(settings, /Salvar não envia nenhuma mensagem agora/u);
});

test("padrão sem preferência continua desativado e não grava ao abrir", () => {
  assert.match(route, /exists: false[\s\S]+enabled: false/u);
  assert.match(route, /if \(!preference\) return defaultPreference/u);
  assert.doesNotMatch(frontend.slice(frontend.indexOf("useEffect(() =>", frontend.indexOf("function TelegramSettings"))), /saveUserNotificationPreference/u);
});

test("ativação exige ação explícita do usuário", () => {
  assert.match(settings, /checked=\{preference\.enabled\}/u);
  assert.match(settings, /updatePreference\(\{ enabled: event\.target\.checked \}\)/u);
  assert.match(settings, /Ativar notificações/u);
});

test("avisos exibem amanhã, hoje e atraso", () => {
  assert.match(settings, /billDueTomorrow", "1 dia antes/u);
  assert.match(settings, /billDueToday", "No dia do vencimento/u);
  assert.match(settings, /billOverdue", "Quando a conta ficar atrasada/u);
});

test("horário preferido usa input time controlado", () => {
  assert.match(settings, /type="time"/u);
  assert.match(settings, /value=\{preference\.preferredLocalTime\}/u);
  assert.match(settings, /Horário preferido/u);
});

test("timezone aparece em linguagem de usuário como Brasília", () => {
  assert.match(settings, /Fuso horário/u);
  assert.match(settings, /Horário de Brasília/u);
  assert.doesNotMatch(settings, />America\/Sao_Paulo</u);
});

test("estado Telegram conectado é visível sem identificadores sensíveis", () => {
  const branch = settings.slice(settings.indexOf('connection === "connected"'), settings.indexOf('connection === "disconnected"'));
  assert.match(branch, /Telegram conectado/u);
  assert.match(branch, /Desvincular Telegram/u);
  assert.doesNotMatch(branch, /chat_id|telegram_user_id|token|secret/iu);
});

test("estado Telegram desconectado reutiliza o fluxo de código", () => {
  const branch = settings.slice(settings.indexOf('connection === "disconnected"'));
  assert.match(branch, /Telegram não conectado/u);
  assert.match(branch, /Gerar código de conexão/u);
  assert.match(branch, /\/conectar CÓDIGO/u);
});

test("loading de conexão e preferências é explícito", () => {
  assert.match(settings, /Verificando conexão\.\.\./u);
  assert.match(settings, /Carregando preferências\.\.\./u);
  assert.match(settings, /preferenceState === "loading"/u);
});

test("saving impede duplo submit", () => {
  assert.match(settings, /if \(!preference \|\| preferenceState === "saving"\) return/u);
  assert.match(settings, /disabled=\{preferenceState === "saving"\}/u);
  assert.match(settings, /Salvando\.\.\./u);
});

test("sucesso de save é comunicado", () => {
  assert.match(settings, /Preferências de notificações salvas\./u);
  assert.match(settings, /Preferências salvas\./u);
  assert.match(settings, /role="status"/u);
});

test("erros de carga e save oferecem feedback", () => {
  assert.match(settings, /preferenceState === "error"/u);
  assert.match(settings, /role="alert"/u);
  assert.match(settings, /Tentar novamente/u);
});

test("layout e ações priorizam mobile", () => {
  assert.match(settings, /grid max-w-4xl gap-5 md:grid-cols-2/u);
  assert.match(settings, /p-4 sm:p-6/u);
  assert.match(settings, /min-h-11 w-full sm:w-auto/u);
});

test("interface não expõe digest, faturas ou Push", () => {
  assert.doesNotMatch(settings, /upcomingDigest|resumo de vencimentos|card_invoices|fatura|Push|PWA/iu);
});

test("save usa somente endpoint de preferências e não dispara execução", () => {
  assert.match(frontend, /fetch\("\/api\/notifications\/preferences"/u);
  assert.doesNotMatch(settings, /update_notification_settings|notification_outbox|runBillNotificationPlanner|runNotificationDispatcher|sendTelegramMessage|scheduled\s*\(/u);
  assert.doesNotMatch(route, /notification_outbox|runBillNotificationPlanner|runNotificationDispatcher|sendTelegramMessage|scheduled\s*\(/u);
});
