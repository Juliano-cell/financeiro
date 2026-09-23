"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, CalendarClock, ChevronLeft, ChevronRight, CreditCard, Pencil, Link2, Plus, Receipt, RotateCcw, Search, Sparkles, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { activeBillCategories, activeBillSubcategories, billActions, billClassificationError, billDayRefreshDelay, billReferenceMonthInSaoPaulo, billRelativeDueLabel, billsForSelectedMonthAndGlobalOverdue, billTiming, billTodayInSaoPaulo, buildBillPaymentPayload, buildRecurringBillCalendarPayload, changeBillCategory, eligibleRecurringBillIds, filterAndSortBills, filterAndSortPaidBills, friendlyBillPaymentError, globalOverdueBills, initialBillPaymentAccountId, normalizeBillAccountId, normalizeRecurringBillSelection, paidBillAccountId, paidBillsForSelectedMonth, recurringBillOccurrences, summarizePendingBills, toggleRecurringBillSelection } from "@/lib/bill-ui-rules.mjs";
import { activeSubcategories, changeTransactionCategory, transactionClassificationError } from "@/lib/finance-ui-rules.mjs";
import { InvoiceLifecycle, type CanonicalInvoice, type FinancialController, type FinancialRefresh } from "@/app/invoice-lifecycle";
import { CardOnboardingAction } from "@/app/card-onboarding-dialog";
import { CardExistingInstallmentAction } from "@/app/card-existing-installment-dialog";
import { formatFinancialCents } from "@/lib/ui-preferences.mjs";
import { billPaymentAdjustment, formatBillPaymentInput, parseBillPaymentCents } from "@/lib/bill-payment.mjs";

export type AdvancedView = "cards" | "installments" | "bills" | "simulator" | "settings";
type Account = { id: string; name: string; currentBalanceCents: number; isActive: boolean };
type Subcategory = { id: string; name: string; categoryId: string; isActive?: boolean };
type Category = { id: string; name: string; type: "income" | "expense" | "both"; isActive: boolean; subcategories: Subcategory[] };
type Card = { id: string; name: string; institution: string; holder: string; limitCents: number; closingDay: number; dueDay: number; isActive: boolean; notes: string | null; usedCents: number; availableCents: number; currentInvoiceCents: number; nextInvoiceCents: number; installmentPurchaseCount: number; hasCompletedInitialImport: boolean; openingResidualCents: number };
type Installment = { id: string; purchaseId: string; invoiceId: string; installmentNumber: number; installmentCount: number; amountCents: number; status: string; purchase?: { description: string; status: string }; invoice?: { referenceMonth: string; dueDate: string; status: string }; card?: { name: string } };
type Invoice = CanonicalInvoice & { status: "open" | "closed" | "paid"; totalCents: number; installments: Installment[]; openingBalance: { originalCents: number; openingCents: number; initialStateInstallmentsCents: number; allocatedCents: number; residualCents: number; identifiedCents: number } | null };
type BillPayment = { transactionId: string; paidAmountCents: number; paidOn: string; accountId: string; adjustmentAmountCents: number; adjustmentType: "normal" | "surcharge" | "discount" };
type Bill = { id: string; description: string; amountCents: number; dueDate: string; categoryId: string | null; subcategoryId: string | null; recurrence: "none" | "monthly"; recurrenceSeriesId: string | null; recurrenceEndDate: string | null; status: "pending" | "paid" | "cancelled"; displayStatus: "pending" | "paid" | "cancelled" | "overdue"; accountId: string | null; notes: string | null; payment: BillPayment | null };
type BillStatusFilter = "pending" | "overdue" | "paid" | "cancelled" | "all";
type PaidBillDateView = "due" | "payment";
type NotificationPreference = { exists: boolean; channel: "telegram"; enabled: boolean; billDueTomorrow: boolean; billDueToday: boolean; billOverdue: boolean; preferredLocalTime: string; timezone: "America/Sao_Paulo" };
export type AdvancedSnapshot = { selectedMonth: string; cards: Card[]; invoices: Invoice[]; installments: Installment[]; bills: Bill[]; notificationSettings: { enabled: boolean; offsets: number[] }; summary: { availableCents: number; incomeCents: number; expenseCents: number; paidBillsCents: number; pendingBillsCents: number; cardCents: number; installmentCents: number; commitmentsCents: number; projectedCents: number } };

const brl = (cents: number) => formatFinancialCents(cents);
const monthLabel = (month: string) => new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`));
const addMonth = (month: string, amount: number) => { const [year, value] = month.split("-").map(Number); const date = new Date(Date.UTC(year, value - 1 + amount, 1)); return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`; };
const cents = (value: FormDataEntryValue | null) => { const normalized = String(value ?? "").trim().replace(/\./g, "").replace(",", "."); return Math.round(Number(normalized) * 100); };

export function cardInvoiceSummary(card: Card, invoices: Invoice[], selectedMonth: string) {
  const currentInvoice = invoices.find((invoice) => invoice.cardId === card.id && invoice.referenceMonth === selectedMonth && invoice.remainingCents > 0);
  return currentInvoice
    ? { label: "Restante da fatura", cents: currentInvoice.remainingCents }
    : { label: "Próxima fatura", cents: card.nextInvoiceCents };
}

export class AdvancedApiError extends Error {
  constructor(message: string, public code?: string, public status?: number) { super(message); this.name = "AdvancedApiError"; }
}

export async function advancedApi(body?: Record<string, unknown>, month?: string, signal?: AbortSignal) {
  const response = await fetch(body ? "/api/finance/advanced" : `/api/finance/advanced?month=${encodeURIComponent(month ?? billReferenceMonthInSaoPaulo())}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal } : { signal });
  let data: { error?: string; code?: string } & Record<string, unknown>;
  try { data = await response.json(); } catch { throw new AdvancedApiError("Não foi possível confirmar o resultado da operação.", undefined, response.status); }
  if (!response.ok) throw new AdvancedApiError(data.error ?? "Não foi possível concluir a operação.", data.code, response.status);
  return data;
}

async function telegramLinkStatus(signal?: AbortSignal) {
  const response = await fetch("/api/telegram/link", { signal, cache: "no-store" });
  const result = await response.json() as { connected?: boolean; error?: string };
  if (!response.ok) throw new Error(result.error ?? "Não foi possível verificar a conexão.");
  return Boolean(result.connected);
}

async function notificationPreferencesApi(preference?: Omit<NotificationPreference, "exists">, signal?: AbortSignal) {
  const response = await fetch("/api/notifications/preferences", preference ? {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(preference),
    signal,
  } : { signal, cache: "no-store" });
  const result = await response.json() as NotificationPreference & { error?: string };
  if (!response.ok) throw new Error(result.error ?? "Não foi possível carregar as preferências.");
  return result;
}

export function MonthNavigator({ month, onChange }: { month: string; onChange: (month: string) => void }) {
  return <div className="flex items-center justify-between gap-1 rounded-xl border bg-card p-1 shadow-sm" aria-label="Selecionar mês"><Button variant="ghost" size="icon" onClick={() => onChange(addMonth(month, -1))} aria-label="Mês anterior"><ChevronLeft className="h-4 w-4" /></Button><button className="min-w-32 px-2 text-sm font-semibold capitalize" onClick={() => onChange(billReferenceMonthInSaoPaulo())} title="Voltar ao mês atual">{monthLabel(month)}</button><Button variant="ghost" size="icon" onClick={() => onChange(addMonth(month, 1))} aria-label="Próximo mês"><ChevronRight className="h-4 w-4" /></Button></div>;
}

export function AdvancedFinanceView({ view, data, accounts, categories, onChanged, financial, onFinancialRefresh }: { view: AdvancedView; data: AdvancedSnapshot | null; accounts: Account[]; categories: Category[]; onChanged: () => Promise<void>; financial?: FinancialController; onFinancialRefresh?: FinancialRefresh }) {
  if (!data) return <div className="rounded-3xl border bg-white p-10 text-center text-sm text-[#71837e]">Carregando planejamento financeiro…</div>;
  if (view === "cards") return <CardsView data={data} accounts={accounts} categories={categories} onChanged={onChanged} financial={financial} onFinancialRefresh={onFinancialRefresh} />;
  if (view === "installments") return <InstallmentsView data={data} />;
  if (view === "bills") return <BillsView data={data} accounts={accounts} categories={categories} onChanged={onChanged} />;
  if (view === "simulator") return <SimulatorView data={data} />;
  return <TelegramSettings />;
}

export function CardsView({ data, accounts, categories, onChanged, financial, onFinancialRefresh }: { data: AdvancedSnapshot; accounts: Account[]; categories: Category[]; onChanged: () => Promise<void>; financial?: FinancialController; onFinancialRefresh?: FinancialRefresh }) {
  const [classification, setClassification] = useState<{ categoryId: string | null; subcategoryId: string | null }>({ categoryId: null, subcategoryId: null });
  const purchaseCategories = categories.filter((item) => item.isActive && (item.type === "expense" || item.type === "both"));
  const purchaseSubcategories = activeSubcategories(purchaseCategories, classification.categoryId);
  const [cardOpen, setCardOpen] = useState(false);
  const [purchaseOpen, setPurchaseOpen] = useState(false);
  const [editing, setEditing] = useState<Card | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(null);
  const card = data.cards.find((item) => item.id === selectedCardId) ?? null;
  const activeCards = data.cards.filter((item) => item.isActive);
  const inactiveCards = data.cards.filter((item) => !item.isActive);
  const invoices = card ? data.invoices.filter((item) => item.cardId === card.id).sort((a, b) => a.referenceMonth.localeCompare(b.referenceMonth)) : [];
  const relevantInvoice = invoices.find((invoice) => invoice.referenceMonth === data.selectedMonth)
    ?? invoices.find((invoice) => invoice.remainingCents > 0)
    ?? invoices.at(-1);
  const selectedInvoice = invoices.find((invoice) => invoice.id === selectedInvoiceId) ?? relevantInvoice;
  const upcomingInvoices = invoices.filter((invoice) => invoice.id !== relevantInvoice?.id && invoice.referenceMonth > data.selectedMonth && invoice.paymentStatus !== "settled");
  const historicalInvoices = invoices.filter((invoice) => invoice.id !== relevantInvoice?.id && !upcomingInvoices.some((upcoming) => upcoming.id === invoice.id)).reverse();
  const saveCard = async (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await advancedApi({ action: editing ? "update_card" : "create_card", ...(editing ? { id: editing.id } : {}), name: form.get("name"), institution: form.get("institution"), holder: form.get("holder"), limitCents: cents(form.get("limit")), closingDay: Number(form.get("closingDay")), dueDay: Number(form.get("dueDay")), isActive: form.get("isActive") !== "false", notes: form.get("notes") || null }); setCardOpen(false); toast.success(editing ? "Cartão atualizado." : "Cartão cadastrado."); await onChanged(); } catch (error) { toast.error(error instanceof Error ? error.message : "Falha ao salvar."); } };
  const savePurchase = async (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); const error = transactionClassificationError({ type: "expense", ...classification }, purchaseCategories); if (error) { toast.error(error); return; } try { await advancedApi({ action: "create_card_purchase", cardId: form.get("cardId"), description: form.get("description"), totalCents: cents(form.get("total")), purchaseDate: form.get("purchaseDate"), installmentCount: Number(form.get("installmentCount")), categoryId: classification.categoryId, subcategoryId: classification.subcategoryId, notes: form.get("notes") || null, origin: "web" }); setPurchaseOpen(false); toast.success("Compra e parcelas registradas."); await onChanged(); } catch (error) { toast.error(error instanceof Error ? error.message : "Falha ao registrar compra."); } };
  const deactivateCard = async (item: Card) => { try { await advancedApi({ action: "deactivate_card", id: item.id }); toast.success("Cartão inativado. O histórico foi preservado."); await onChanged(); } catch (error) { toast.error(error instanceof Error ? error.message : "Falha ao inativar."); } };
  const reactivateCard = async (item: Card) => { try { await advancedApi({ action: "reactivate_card", id: item.id }); toast.success("Cartão reativado."); await onChanged(); } catch (error) { toast.error(error instanceof Error ? error.message : "Falha ao reativar."); } };
  const openCard = (item: Card) => { setSelectedCardId(item.id); setSelectedInvoiceId(null); };
  const cardGrid = (items: Card[]) => <div className="mt-3 grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-3">{items.map((item) => { const summary = cardInvoiceSummary(item, data.invoices, data.selectedMonth); return <article key={item.id} className="min-w-0 rounded-[24px] border bg-white p-4 sm:p-5"><div className="flex min-w-0 items-start justify-between gap-3"><div className="min-w-0"><h3 className="break-words font-semibold">{item.name}</h3><p className="mt-0.5 break-words text-sm text-[#71837e]">{item.institution} · {item.holder}</p></div><Badge variant={item.isActive ? "secondary" : "outline"}>{item.isActive ? "Ativo" : "Inativo"}</Badge></div><dl className="mt-4 grid grid-cols-2 gap-2.5 text-sm sm:mt-5 sm:gap-3"><Stat label="Disponível" value={brl(item.availableCents)} /><Stat label={summary.label} value={brl(summary.cents)} /><div className="col-span-2"><dt className="text-xs text-[#71837e]">Vencimento</dt><dd className="mt-1 font-medium">Dia {item.dueDay}</dd></div></dl><Button type="button" className="mt-4 min-h-11 w-full sm:mt-5" onClick={() => openCard(item)}>Ver cartão</Button></article>; })}</div>;
  const invoiceShortcut = (invoice: Invoice) => <article key={invoice.id} className="min-w-0 rounded-2xl border border-[#dce4e1] bg-white p-3.5 sm:p-4">
    <div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><p className="font-semibold">{invoice.referenceMonth.split("-").reverse().join("/")}</p><p className="mt-1 text-xs text-[#71837e]">Vence {new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC" }).format(new Date(`${invoice.dueDate}T00:00:00Z`))}</p></div><Badge variant={invoice.paymentStatus === "settled" ? "secondary" : "outline"}>{invoice.paymentStatus === "settled" ? "Quitada" : invoice.paymentStatus === "partial" ? "Parcial" : "Em aberto"}</Badge></div>
    <dl className="mt-2 grid grid-cols-2 gap-2 text-sm"><div><dt className="text-xs text-[#71837e]">Total</dt><dd className="font-medium">{brl(invoice.invoiceTotalCents)}</dd></div><div><dt className="text-xs text-[#71837e]">Restante</dt><dd className="font-semibold">{brl(invoice.remainingCents)}</dd></div></dl>
    <Button type="button" variant="outline" className="mt-3 min-h-11 w-full sm:w-auto" aria-current={selectedInvoice?.id === invoice.id ? "true" : undefined} onClick={() => setSelectedInvoiceId(invoice.id)}>Abrir fatura</Button>
  </article>;
  return <section>
    {!card ? <>
      <Heading title="Cartões" text="Acompanhe cada cartão em um resumo compacto e abra somente o que precisa." action={<div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => { setClassification({ categoryId: null, subcategoryId: null }); setPurchaseOpen(true); }} disabled={!data.cards.some((item) => item.isActive)}><Receipt className="h-4 w-4" /> Compra</Button><Button onClick={() => { setEditing(null); setCardOpen(true); }}><Plus className="h-4 w-4" /> Cartão</Button></div>} />
      {data.cards.length ? <div className="mt-6 grid gap-8"><section aria-labelledby="active-cards-title"><h3 id="active-cards-title" className="text-lg font-semibold">Cartões ativos</h3>{activeCards.length ? cardGrid(activeCards) : <p className="mt-3 rounded-2xl border bg-white p-5 text-sm text-[#71837e]">Nenhum cartão ativo.</p>}</section>{inactiveCards.length > 0 && <details className="rounded-2xl border bg-[#f7faf9] p-4"><summary className="cursor-pointer font-semibold">Cartões inativos ({inactiveCards.length})</summary>{cardGrid(inactiveCards)}</details>}</div> : <Empty icon={CreditCard} text="Cadastre o primeiro cartão da família." />}
    </> : <>
      <Button type="button" variant="ghost" className="-ml-3 mb-4 min-h-11 text-[#48645e]" onClick={() => { setSelectedCardId(null); setSelectedInvoiceId(null); }}><ArrowLeft className="h-4 w-4" /> Voltar para cartões</Button>
      <div className="flex min-w-0 flex-col justify-between gap-4 lg:flex-row lg:items-start"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h2 className="break-words text-3xl font-semibold tracking-[-.04em]">{card.name}</h2><Badge variant={card.isActive ? "secondary" : "outline"}>{card.isActive ? "Ativo" : "Inativo"}</Badge></div><p className="mt-2 break-words text-[#71837e]">{card.institution} · {card.holder}</p><p className="mt-1 text-sm text-[#71837e]">Fecha dia {card.closingDay} · vence dia {card.dueDay}</p></div><div className="flex flex-wrap gap-2">{card.isActive && <><CardOnboardingAction key={`onboarding-${card.id}`} card={card} categories={categories} onChanged={onChanged} />{card.hasCompletedInitialImport && <CardExistingInstallmentAction key={`existing-${card.id}`} card={card} categories={categories} onChanged={onChanged} />}</>}<Button variant="outline" onClick={() => { setEditing(card); setCardOpen(true); }}><Pencil className="h-4 w-4" /> Editar</Button>{card.isActive ? <Button variant="outline" onClick={() => void deactivateCard(card)}><XCircle className="h-4 w-4" /> Inativar</Button> : <Button onClick={() => void reactivateCard(card)}><RotateCcw className="h-4 w-4" /> Reativar cartão</Button>}</div></div>
      <dl className="mt-6 grid min-w-0 grid-cols-2 gap-3 xl:grid-cols-4"><div className="min-w-0 rounded-2xl border bg-white p-3 sm:p-4"><Stat label="Limite" value={brl(card.limitCents)} /></div><div className="min-w-0 rounded-2xl border bg-white p-3 sm:p-4"><Stat label="Utilizado" value={brl(card.usedCents)} /></div><div className="min-w-0 rounded-2xl border bg-white p-3 sm:p-4"><Stat label="Disponível" value={brl(card.availableCents)} /></div><div className="min-w-0 rounded-2xl border bg-white p-3 sm:p-4"><Stat label="Fatura do mês" value={brl(card.currentInvoiceCents)} /></div></dl>
      {selectedInvoice ? <section className="mt-6" aria-labelledby="relevant-invoice-title"><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h3 id="relevant-invoice-title" className="text-lg font-semibold">{selectedInvoice.id === relevantInvoice?.id ? "Fatura relevante" : "Fatura selecionada"}</h3>{selectedInvoice.id !== relevantInvoice?.id && relevantInvoice && <Button type="button" variant="ghost" onClick={() => setSelectedInvoiceId(relevantInvoice.id)}>Voltar à fatura relevante</Button>}</div>{selectedInvoice.openingBalance && selectedInvoice.openingBalance.residualCents > 0 && <div className="mb-4 grid gap-3 rounded-2xl border bg-[#f7faf9] p-4 sm:grid-cols-3"><Stat label="Total da fatura" value={brl(selectedInvoice.invoiceTotalCents)} /><Stat label="Lançamentos identificados" value={brl(selectedInvoice.openingBalance.identifiedCents)} /><Stat label="Saldo inicial ainda não identificado" value={brl(selectedInvoice.openingBalance.residualCents)} /><div className="sm:col-span-3"><CardExistingInstallmentAction key={`identify-${card.id}-${selectedInvoice.id}`} card={card} categories={categories} onChanged={onChanged} defaultMode="included" triggerLabel="Identificar saldo inicial" /></div></div>}<InvoiceLifecycle key={selectedInvoice.id} invoice={selectedInvoice} accounts={accounts} onChanged={onChanged} financial={financial} onFinancialRefresh={onFinancialRefresh} /></section> : <p className="mt-6 rounded-2xl border bg-white py-8 text-center text-sm text-[#71837e]">Nenhuma fatura neste cartão.</p>}
      {upcomingInvoices.length > 0 && <section className="mt-7" aria-labelledby="upcoming-invoices-title"><h3 id="upcoming-invoices-title" className="text-lg font-semibold">Próximas faturas</h3><p className="mt-1 text-sm text-[#71837e]">Veja os próximos vencimentos deste cartão.</p><div className="mt-3 grid min-w-0 gap-2.5 lg:grid-cols-2">{upcomingInvoices.map(invoiceShortcut)}</div></section>}
      {historicalInvoices.length > 0 && <section className="mt-7" aria-labelledby="historical-invoices-title"><h3 id="historical-invoices-title" className="text-lg font-semibold">Histórico e faturas quitadas</h3><p className="mt-1 text-sm text-[#71837e]">Consulte competências anteriores sem ocupar a tela principal.</p><div className="mt-3 grid min-w-0 gap-3 md:grid-cols-2">{historicalInvoices.map(invoiceShortcut)}</div></section>}
    </>}
    <Dialog open={cardOpen} onOpenChange={setCardOpen}><DialogContent><DialogHeader><DialogTitle>{editing ? "Editar cartão" : "Novo cartão"}</DialogTitle><DialogDescription>O cartão sempre será associado à família autenticada.</DialogDescription></DialogHeader><form onSubmit={saveCard} className="grid gap-4 sm:grid-cols-2"><Field name="name" label="Nome/apelido" defaultValue={editing?.name} required /><Field name="institution" label="Instituição/banco" defaultValue={editing?.institution} required /><Field name="holder" label="Titular" defaultValue={editing?.holder} required /><Field name="limit" label="Limite total (R$)" defaultValue={editing ? (editing.limitCents / 100).toFixed(2).replace(".", ",") : ""} inputMode="decimal" required /><Field name="closingDay" label="Dia de fechamento" type="number" min={1} max={31} defaultValue={editing?.closingDay} required /><Field name="dueDay" label="Dia de vencimento" type="number" min={1} max={31} defaultValue={editing?.dueDay} required /><div className="sm:col-span-2"><Field name="notes" label="Observação" defaultValue={editing?.notes ?? ""} /></div><input type="hidden" name="isActive" value={editing?.isActive === false ? "false" : "true"} /><DialogFooter className="sm:col-span-2"><Button type="button" variant="outline" onClick={() => setCardOpen(false)}>Cancelar</Button><Button type="submit">Salvar</Button></DialogFooter></form></DialogContent></Dialog>
    <Dialog open={purchaseOpen} onOpenChange={setPurchaseOpen}><DialogContent><DialogHeader><DialogTitle>Compra no cartão</DialogTitle><DialogDescription>Os centavos são distribuídos com soma exata, e cada parcela entra na fatura correta.</DialogDescription></DialogHeader><form onSubmit={savePurchase} className="grid gap-4 sm:grid-cols-2"><SelectField name="cardId" label="Cartão" items={data.cards.filter((item) => item.isActive).map((item) => ({ value: item.id, label: item.name }))} /><Field name="purchaseDate" label="Data da compra" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required /><div className="sm:col-span-2"><Field name="description" label="Descrição" required /></div><Field name="total" label="Valor total (R$)" inputMode="decimal" required /><Field name="installmentCount" label="Parcelas" type="number" min={1} max={120} defaultValue={1} required /><div className="grid gap-2"><Label htmlFor="purchase-category">Categoria</Label><select id="purchase-category" name="categoryId" className="min-h-11 w-full min-w-0 rounded-md border px-3" value={classification.categoryId ?? ""} onChange={(event) => setClassification((current) => changeTransactionCategory(current, event.target.value))} required><option value="" disabled>Selecione uma categoria</option>{purchaseCategories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>{purchaseSubcategories.length > 0 && <div className="grid gap-2"><Label htmlFor="purchase-subcategory">Subcategoria</Label><select id="purchase-subcategory" name="subcategoryId" className="min-h-11 w-full min-w-0 rounded-md border px-3" value={classification.subcategoryId ?? ""} onChange={(event) => setClassification((current) => ({ ...current, subcategoryId: event.target.value || null }))} required><option value="" disabled>Selecione uma subcategoria</option>{purchaseSubcategories.map((item: Subcategory) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>}<Field name="notes" label="Observação" /><DialogFooter className="sm:col-span-2"><Button type="button" variant="outline" onClick={() => setPurchaseOpen(false)}>Cancelar</Button><Button type="submit">Registrar compra</Button></DialogFooter></form></DialogContent></Dialog>
  </section>;
}

function InstallmentsView({ data }: { data: AdvancedSnapshot }) {
  const [period, setPeriod] = useState("month"); const end = period === "month" ? data.selectedMonth : period === "next" ? addMonth(data.selectedMonth, 1) : period === "three" ? addMonth(data.selectedMonth, 2) : "9999-12";
  const start = period === "next" ? addMonth(data.selectedMonth, 1) : data.selectedMonth; const rows = data.installments.filter((item) => item.invoice && item.invoice.referenceMonth >= start && item.invoice.referenceMonth <= end && item.status !== "cancelled").sort((a, b) => (a.invoice?.referenceMonth ?? "").localeCompare(b.invoice?.referenceMonth ?? ""));
  return <section><Heading title="Parcelas" text="Acompanhe cada compromisso sem perder o vínculo com a compra original." action={<Select value={period} onValueChange={setPeriod}><SelectTrigger className="w-52 bg-white"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="month">Este mês</SelectItem><SelectItem value="next">Próximo mês</SelectItem><SelectItem value="three">Próximos 3 meses</SelectItem><SelectItem value="all">Todas as futuras</SelectItem></SelectContent></Select>} /><div className="mt-6 grid gap-3">{rows.length ? rows.map((item) => <div key={item.id} className="grid gap-3 rounded-2xl border bg-white p-4 sm:grid-cols-[1.5fr_1fr_1fr_auto] sm:items-center"><div><p className="font-medium">{item.purchase?.description}</p><p className="text-xs text-[#71837e]">{item.card?.name}</p></div><span>{item.installmentNumber}/{item.installmentCount}</span><span className="capitalize">{item.invoice && monthLabel(item.invoice.referenceMonth)}</span><strong>{brl(item.amountCents)}</strong></div>) : <Empty icon={Receipt} text="Não há parcelas no período selecionado." />}</div></section>;
}

function BillsView({ data, accounts, categories, onChanged }: { data: AdvancedSnapshot; accounts: Account[]; categories: Category[]; onChanged: () => Promise<void> }) {
  const [editor, setEditor] = useState<{ item: Bill | null; session: string } | null>(null);
  const [payment, setPayment] = useState<{ bill: Bill; session: string } | null>(null);
  const [confirmation, setConfirmation] = useState<{ bill: Bill; kind: "cancel" | "undo"; session: string } | null>(null);
  const [statusFilter, setStatusFilter] = useState<BillStatusFilter>("pending");
  const [search, setSearch] = useState("");
  const [accountFilter, setAccountFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [paidDateView, setPaidDateView] = useState<PaidBillDateView>("due");
  const [today, setToday] = useState(() => billTodayInSaoPaulo());
  useEffect(() => {
    let timer = 0;
    const scheduleNextDay = () => {
      timer = window.setTimeout(() => {
        setToday(billTodayInSaoPaulo());
        scheduleNextDay();
      }, billDayRefreshDelay());
    };
    scheduleNextDay();
    return () => window.clearTimeout(timer);
  }, []);
  const monthRows = data.bills.filter((item) => item.dueDate.startsWith(data.selectedMonth));
  const globalOverdueRows = globalOverdueBills(data.bills, today) as Bill[];
  const relevantRows = billsForSelectedMonthAndGlobalOverdue(data.bills, data.selectedMonth, today) as Bill[];
  const paidScopeRows = paidBillsForSelectedMonth(data.bills, data.selectedMonth, paidDateView) as Bill[];
  const rows = statusFilter === "paid"
    ? filterAndSortPaidBills(data.bills, { selectedMonth: data.selectedMonth, dateView: paidDateView, search, accountId: accountFilter, categoryId: categoryFilter }) as Bill[]
    : filterAndSortBills(relevantRows, { today, status: statusFilter, search, accountId: accountFilter, categoryId: categoryFilter }) as Bill[];
  const filterSourceRows = statusFilter === "paid" ? paidScopeRows : relevantRows;
  const monthSummary = summarizePendingBills(monthRows, today);
  const overdueSummary = summarizePendingBills(globalOverdueRows, today).overdue;
  const summary = { overdue: overdueSummary, today: monthSummary.today, upcoming: monthSummary.upcoming };
  const categoryName = (bill: Bill) => categories.find((category) => category.id === bill.categoryId)?.name ?? "Sem categoria";
  const subcategoryName = (bill: Bill) => categories.flatMap((category) => category.subcategories ?? []).find((subcategory) => subcategory.id === bill.subcategoryId)?.name ?? "Sem subcategoria";
  const accountName = (bill: Bill) => {
    const accountId = statusFilter === "paid" ? paidBillAccountId(bill, paidDateView) : bill.accountId;
    return accounts.find((account) => account.id === accountId)?.name ?? (paidDateView === "payment" ? "Conta indisponível" : "Definir ao pagar");
  };
  const filterAccounts = accounts.filter((account) => account.id === accountFilter || filterSourceRows.some((bill) => paidBillAccountId(bill, statusFilter === "paid" ? paidDateView : "due") === account.id));
  const filterCategories = categories.filter((category) => category.id === categoryFilter || filterSourceRows.some((bill) => bill.categoryId === category.id));
  const nextSession = () => crypto.randomUUID();
  const openEditor = (item: Bill | null) => setEditor({ item, session: nextSession() });
  const openPayment = (bill: Bill) => setPayment({ bill, session: nextSession() });
  const selectStatus = (value: BillStatusFilter) => {
    if (paidDateView === "payment") setAccountFilter("all");
    setPaidDateView("due");
    setStatusFilter(value);
  };
  const selectPaidDateView = (value: PaidBillDateView) => {
    setAccountFilter("all");
    setPaidDateView(value);
  };
  const hasSecondaryFilters = Boolean(search || accountFilter !== "all" || categoryFilter !== "all");
  const sectionDefinitions = [
    { key: "overdue", title: "Atrasadas — todos os meses", description: "Pendências vencidas em qualquer competência", tone: "text-destructive" },
    { key: "today", title: "Vencem hoje", description: "Pendências do dia no mês selecionado", tone: "text-chart-2" },
    { key: "upcoming", title: "Próximas", description: "Vencimentos futuros no mês selecionado", tone: "text-foreground" },
    { key: "paid", title: paidDateView === "payment" ? "Pagamentos realizados no mês" : "Pagas da competência", description: paidDateView === "payment" ? "Contas efetivamente pagas no mês selecionado" : "Contas com vencimento no mês selecionado", tone: "text-foreground" },
    { key: "cancelled", title: "Canceladas", description: "Sem efeito financeiro no mês selecionado", tone: "text-muted-foreground" },
  ].map((section) => ({ ...section, items: rows.filter((bill) => billTiming(bill, today) === section.key) })).filter((section) => section.items.length > 0);

  return <section>
    <Heading title="Contas e vencimentos" text="Pendências, recorrências e pagamentos ligados a uma única movimentação." action={<Button onClick={() => openEditor(null)}><Plus className="h-4 w-4" /> Nova conta</Button>} />
    <dl className="mt-6 grid min-w-0 grid-cols-3 gap-2 sm:gap-3" aria-label="Resumo dos vencimentos pendentes">
      {[
        { key: "overdue", label: "Atrasadas", value: summary.overdue, tone: "border-destructive/30 bg-destructive/10 text-destructive" },
        { key: "today", label: "Hoje", value: summary.today, tone: "border-chart-2/40 bg-chart-2/10 text-chart-2" },
        { key: "upcoming", label: "Próximas", value: summary.upcoming, tone: "border-border bg-muted text-foreground" },
      ].map((item) => <div key={item.key} className={`min-w-0 rounded-2xl border p-3 sm:p-4 ${item.tone}`}><dt className="truncate text-xs font-semibold sm:text-sm">{item.label}</dt><dd className="mt-1 flex min-w-0 flex-col gap-0.5"><span className="text-xl font-semibold tabular-nums">{item.value.count}</span><span className="break-words text-xs font-medium tabular-nums sm:text-sm">{brl(item.value.valueCents)}</span></dd></div>)}
    </dl>
    <div className="mt-5 rounded-2xl border bg-card p-3 sm:p-4">
      <div className="flex flex-wrap gap-2" aria-label="Filtrar vencimentos por status">
        {([{"value":"pending","label":"Pendentes"},{"value":"overdue","label":"Atrasadas"},{"value":"paid","label":"Pagas"},{"value":"cancelled","label":"Canceladas"},{"value":"all","label":"Todas"}] as Array<{ value: BillStatusFilter; label: string }>).map((item) => <Button key={item.value} type="button" size="sm" variant={statusFilter === item.value ? "default" : "outline"} className="min-h-10 flex-1 sm:flex-none" aria-pressed={statusFilter === item.value} onClick={() => selectStatus(item.value)}>{item.label}</Button>)}
      </div>
      {statusFilter === "paid" && <div className="mt-3 flex flex-col gap-2 rounded-xl bg-muted p-2 sm:flex-row sm:items-center sm:justify-between"><span className="px-1 text-xs font-medium text-muted-foreground">Organizar pagas por</span><div className="flex gap-2" role="group" aria-label="Organizar contas pagas"><Button type="button" size="sm" className="min-h-10 flex-1 sm:flex-none" variant={paidDateView === "due" ? "default" : "outline"} aria-pressed={paidDateView === "due"} onClick={() => selectPaidDateView("due")}>Por vencimento</Button><Button type="button" size="sm" className="min-h-10 flex-1 sm:flex-none" variant={paidDateView === "payment" ? "default" : "outline"} aria-pressed={paidDateView === "payment"} onClick={() => selectPaidDateView("payment")}>Por pagamento</Button></div></div>}
      <div className="mt-3 grid min-w-0 gap-2 md:grid-cols-[minmax(12rem,1fr)_minmax(10rem,.7fr)_minmax(10rem,.7fr)_auto]">
        <label className="relative min-w-0"><span className="sr-only">Buscar por descrição</span><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input value={search} onChange={(event) => setSearch(event.target.value)} className="min-h-11 pl-9" placeholder="Buscar descrição" /></label>
        <Select value={accountFilter} onValueChange={setAccountFilter}><SelectTrigger className="min-h-11 w-full"><SelectValue placeholder="Todas as contas" /></SelectTrigger><SelectContent><SelectItem value="all">Todas as contas</SelectItem>{!(statusFilter === "paid" && paidDateView === "payment") && <SelectItem value="unassigned">Definir ao pagar</SelectItem>}{filterAccounts.map((account) => <SelectItem key={account.id} value={account.id}>{account.name}</SelectItem>)}</SelectContent></Select>
        <Select value={categoryFilter} onValueChange={setCategoryFilter}><SelectTrigger className="min-h-11 w-full"><SelectValue placeholder="Todas as categorias" /></SelectTrigger><SelectContent><SelectItem value="all">Todas as categorias</SelectItem>{filterCategories.map((category) => <SelectItem key={category.id} value={category.id}>{category.name}</SelectItem>)}</SelectContent></Select>
        {hasSecondaryFilters && <Button type="button" variant="ghost" className="min-h-11" onClick={() => { setSearch(""); setAccountFilter("all"); setCategoryFilter("all"); }}>Limpar</Button>}
      </div>
    </div>
    <div className="mt-6 grid min-w-0 gap-6">{sectionDefinitions.length ? sectionDefinitions.map((section) => <section key={section.key} aria-labelledby={`bill-section-${section.key}`}><div className="mb-2 flex min-w-0 flex-wrap items-baseline justify-between gap-2"><div className="min-w-0"><h3 id={`bill-section-${section.key}`} className={`font-semibold ${section.tone}`}>{section.title}</h3><p className="text-xs text-muted-foreground">{section.description}</p></div><span className="text-xs tabular-nums text-muted-foreground">{section.items.length} {section.items.length === 1 ? "item" : "itens"}</span></div><div className="grid min-w-0 gap-3">{section.items.map((item) => {
      const actions = billActions(item.status);
      const timing = billTiming(item, today);
      const status = item.status === "paid" ? "Paga" : item.status === "cancelled" ? "Cancelada" : timing === "overdue" ? "Atrasada" : timing === "today" ? "Vence hoje" : "Pendente";
      const relative = item.status === "pending" ? billRelativeDueLabel(item.dueDate, today) : null;
      const classification = item.subcategoryId ? `${categoryName(item)} · ${subcategoryName(item)}` : categoryName(item);
      return <article key={item.id} className={`min-w-0 rounded-2xl border bg-card p-4 ${timing === "overdue" ? "border-destructive/30" : timing === "today" ? "border-chart-2/40" : ""} ${item.status === "cancelled" ? "opacity-70" : ""}`}>
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1"><div className="flex min-w-0 flex-wrap items-center gap-2"><h4 className="min-w-0 break-words font-medium">{item.description}</h4><Badge variant={item.status === "cancelled" || timing === "overdue" ? "destructive" : item.status === "paid" ? "secondary" : "outline"} className={timing === "today" ? "border-chart-2/40 bg-chart-2/10 text-chart-2" : undefined}>{status}</Badge></div><p className="mt-1.5 flex flex-wrap gap-x-1.5 gap-y-0.5 text-sm"><span className={timing === "overdue" ? "font-semibold text-destructive" : timing === "today" ? "font-semibold text-chart-2" : "text-foreground"}>{relative ?? `Vencimento em ${formatBillDate(item.dueDate)}`}</span>{relative && <><span className="text-muted-foreground" aria-hidden="true">·</span><span className="text-muted-foreground">{formatBillDate(item.dueDate)}</span></>}</p>{timing === "overdue" && <p className="mt-1 text-xs font-medium text-muted-foreground">Competência: {monthLabel(item.dueDate.slice(0, 7))}</p>}<p className="mt-1.5 break-words text-xs text-muted-foreground">{classification} · {item.recurrence === "monthly" ? "Mensal" : "Avulsa"}</p><p className="mt-1 break-words text-xs text-muted-foreground">{statusFilter === "paid" && paidDateView === "payment" ? "Conta do pagamento" : "Conta"}: {accountName(item)}</p></div>
          <div className="sm:max-w-[40%] sm:text-right"><span className="block text-xs text-muted-foreground">{item.payment ? "Valor pago" : "Valor previsto"}</span><strong className="mt-1 block break-words text-xl tabular-nums">{brl(item.payment?.paidAmountCents ?? item.amountCents)}</strong></div>
        </div>
        {item.payment && <dl className="mt-3 grid gap-2 rounded-xl bg-muted p-3 text-sm sm:grid-cols-3"><BillDetail label="Valor previsto" value={brl(item.amountCents)} /><BillDetail label="Pago em" value={formatBillDate(item.payment.paidOn)} />{item.payment.adjustmentType === "normal" ? <BillDetail label="Ajuste" value="Sem ajuste" /> : <BillDetail label={item.payment.adjustmentType === "surcharge" ? "Acréscimo / juros" : "Desconto"} value={`${item.payment.adjustmentType === "surcharge" ? "+ " : ""}${brl(Math.abs(item.payment.adjustmentAmountCents))}`} />}</dl>}
        {item.notes && <details className="mt-3 text-sm text-muted-foreground"><summary className="cursor-pointer font-medium text-foreground">Ver observação</summary><p className="mt-2 break-words rounded-xl bg-muted p-3">{item.notes}</p></details>}
        {actions.length > 0 && <div className="mt-4 flex flex-wrap justify-end gap-2 border-t pt-3">
          {actions.includes("pay") && <Button className="min-h-11 flex-1 sm:flex-none" variant={timing === "overdue" ? "destructive" : "default"} onClick={() => openPayment(item)}>{timing === "overdue" ? "Pagar atrasada" : "Pagar"}</Button>}
          {actions.includes("edit") && <Button className="min-h-11" variant="outline" onClick={() => openEditor(item)}><Pencil className="h-4 w-4" /> Editar</Button>}
          {actions.includes("cancel") && <Button className="min-h-11" variant="ghost" onClick={() => setConfirmation({ bill: item, kind: "cancel", session: nextSession() })}><XCircle className="h-4 w-4" /> Cancelar</Button>}
          {actions.includes("undo") && <Button className="min-h-11 w-full sm:w-auto" variant="outline" onClick={() => setConfirmation({ bill: item, kind: "undo", session: nextSession() })}><RotateCcw className="h-4 w-4" /> Desfazer pagamento</Button>}
        </div>}
      </article>;
    })}</div></section>) : <Empty icon={CalendarClock} text={relevantRows.length ? "Nenhum vencimento corresponde aos filtros." : "Nenhum vencimento neste mês e nenhuma conta atrasada."} />}</div>
    {editor && <BillEditorDialog key={editor.session} open item={editor.item} bills={data.bills} accounts={accounts} categories={categories} onOpenChange={(open) => { if (!open) setEditor(null); }} onChanged={onChanged} />}
    {payment && <BillPaymentDialog key={payment.session} open bill={payment.bill} accounts={accounts} categories={categories} onOpenChange={(open) => { if (!open) setPayment(null); }} onChanged={onChanged} onEdit={() => { const bill = payment.bill; setPayment(null); openEditor(bill); }} />}
    {confirmation && <BillConfirmationDialog key={confirmation.session} open bill={confirmation.bill} kind={confirmation.kind} onOpenChange={(open) => { if (!open) setConfirmation(null); }} onChanged={onChanged} />}
  </section>;
}

function BillEditorDialog({ open, item, bills, accounts, categories, onOpenChange, onChanged }: { open: boolean; item: Bill | null; bills: Bill[]; accounts: Account[]; categories: Category[]; onOpenChange: (open: boolean) => void; onChanged: () => Promise<void> }) {
  const availableCategories = activeBillCategories(categories) as Category[];
  const initialCategoryId = availableCategories.some((category) => category.id === item?.categoryId) ? item?.categoryId ?? null : null;
  const initialSubcategories = activeBillSubcategories(categories, initialCategoryId) as Subcategory[];
  const [classification, setClassification] = useState({ categoryId: initialCategoryId, subcategoryId: initialSubcategories.some((subcategory) => subcategory.id === item?.subcategoryId) ? item?.subcategoryId ?? null : null });
  const [accountId, setAccountId] = useState(accounts.some((account) => account.id === item?.accountId && account.isActive) ? item?.accountId ?? null : null);
  const [recurrence, setRecurrence] = useState<"none" | "monthly">(item?.recurrence ?? "none");
  const [scope, setScope] = useState<"occurrence" | "future" | "selected">("occurrence");
  const [selectedOccurrenceIds, setSelectedOccurrenceIds] = useState<string[]>(item?.recurrenceSeriesId ? [item.id] : []);
  const [changeSelectedDueDate, setChangeSelectedDueDate] = useState(false);
  const [changeFutureDueDate, setChangeFutureDueDate] = useState(false);
  const [changeFutureRecurrenceEnd, setChangeFutureRecurrenceEnd] = useState(false);
  const [busy, setBusy] = useState(false);
  const recurringEdit = Boolean(item?.recurrenceSeriesId);
  const seriesOccurrences = recurringBillOccurrences(bills, item?.recurrenceSeriesId) as Bill[];
  const eligibleIds = eligibleRecurringBillIds(bills, item?.recurrenceSeriesId) as string[];
  const futureIds = eligibleRecurringBillIds(bills, item?.recurrenceSeriesId, item?.dueDate) as string[];
  const selectedIds = normalizeRecurringBillSelection(selectedOccurrenceIds, eligibleIds) as string[];
  const affectedCount = scope === "occurrence" ? 1 : scope === "future" ? futureIds.length : selectedIds.length;
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const classificationMessage = billClassificationError(classification, categories);
    if (classificationMessage) { toast.error(classificationMessage); return; }
    const form = new FormData(event.currentTarget);
    setBusy(true);
    let completed = false;
    try {
      if (!item) {
        await advancedApi({ action: "create_bill", description: form.get("description"), amountCents: cents(form.get("amount")), dueDate: form.get("dueDate"), categoryId: classification.categoryId, subcategoryId: classification.subcategoryId, accountId, recurrence, recurrenceEndDate: recurrence === "monthly" ? form.get("recurrenceEndDate") || null : null, notes: form.get("notes") || null });
        toast.success("Vencimento criado.");
      } else if (scope !== "occurrence" && item.recurrenceSeriesId) {
        const occurrenceIds = scope === "future" ? futureIds : selectedIds;
        const calendar = buildRecurringBillCalendarPayload({ scope, changeDueDate: scope === "future" ? changeFutureDueDate : changeSelectedDueDate, changeRecurrenceEnd: scope === "future" && changeFutureRecurrenceEnd, dayOfMonth: form.get("dayOfMonth"), endsOn: form.get("recurrenceEndDate") });
        await advancedApi({ action: "update_recurring_bill_series", id: item.recurrenceSeriesId, anchorBillId: item.id, scope, occurrenceIds, ...calendar, description: form.get("description"), amountCents: cents(form.get("amount")), categoryId: classification.categoryId, subcategoryId: classification.subcategoryId, accountId, notes: form.get("notes") || null });
        toast.success(`${occurrenceIds.length} vencimento(s) atualizado(s).`);
      } else {
        await advancedApi({ action: "update_bill_occurrence", id: item.id, description: form.get("description"), amountCents: cents(form.get("amount")), dueDate: form.get("dueDate"), categoryId: classification.categoryId, subcategoryId: classification.subcategoryId, accountId, notes: form.get("notes") || null });
        toast.success("Vencimento atualizado.");
      }
      await onChanged();
      completed = true;
    } catch (error) { toast.error(error instanceof Error ? error.message : "Não foi possível salvar o vencimento."); }
    finally { setBusy(false); if (completed) onOpenChange(false); }
  };
  return <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}><DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-xl"><DialogHeader><DialogTitle>{item ? "Editar vencimento" : "Novo vencimento"}</DialogTitle><DialogDescription>{item ? "Apenas vencimentos pendentes podem ter dados financeiros alterados." : "Cadastre a classificação e escolha uma conta ou deixe para definir no pagamento."}</DialogDescription></DialogHeader><form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
    {recurringEdit && <div className="sm:col-span-2"><Label>Quais vencimentos você deseja alterar?</Label><Select value={scope} onValueChange={(value) => setScope(value as "occurrence" | "future" | "selected")}><SelectTrigger className="mt-2 w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="occurrence">Somente este vencimento</SelectItem><SelectItem value="future">Este e os próximos vencimentos pendentes</SelectItem><SelectItem value="selected">Escolher vencimentos</SelectItem></SelectContent></Select></div>}
    <div className="sm:col-span-2"><Field name="description" label="Descrição" defaultValue={item?.description ?? ""} required /></div><Field name="amount" label="Valor (R$)" defaultValue={item ? (item.amountCents / 100).toFixed(2).replace(".", ",") : ""} inputMode="decimal" required />
    {scope === "future" && recurringEdit ? changeFutureDueDate ? <Field name="dayOfMonth" label="Novo dia do vencimento" type="number" min={1} max={31} defaultValue={Number(item?.dueDate.slice(8))} required /> : null : scope === "selected" && recurringEdit ? changeSelectedDueDate ? <Field name="dayOfMonth" label="Novo dia do vencimento" type="number" min={1} max={31} defaultValue={Number(item?.dueDate.slice(8))} required /> : null : <Field name="dueDate" label="Vencimento" type="date" defaultValue={item?.dueDate} required />}
    <BillClassificationFields categories={availableCategories} classification={classification} onChange={setClassification} />
    <div><Label>Conta para pagamento</Label><Select value={accountId ?? "none"} onValueChange={(value) => setAccountId(normalizeBillAccountId(value))}><SelectTrigger className="mt-2 w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Definir ao pagar</SelectItem>{accounts.filter((account) => account.isActive).map((account) => <SelectItem key={account.id} value={account.id}>{account.name}</SelectItem>)}</SelectContent></Select></div>
    {!item && <div><Label>Recorrência</Label><Select value={recurrence} onValueChange={(value) => setRecurrence(value as "none" | "monthly")}><SelectTrigger className="mt-2 w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Não recorrente</SelectItem><SelectItem value="monthly">Todo mês</SelectItem></SelectContent></Select></div>}
    {((!item && recurrence === "monthly") || (scope === "future" && recurringEdit && changeFutureRecurrenceEnd)) && <Field name="recurrenceEndDate" label="Repetir até (opcional)" type="date" defaultValue={item?.recurrenceEndDate ?? ""} />}
    {scope === "future" && recurringEdit && <div className="sm:col-span-2 grid gap-2 rounded-2xl border border-[#d8e1de] p-3"><label className="flex cursor-pointer items-start gap-3 rounded-xl bg-[#f4f7f5] p-3"><Checkbox checked={changeFutureDueDate} onCheckedChange={(value) => setChangeFutureDueDate(value === true)} /><span><span className="block text-sm font-medium">Alterar também o dia de vencimento</span><span className="block text-xs text-[#71837e]">Desmarcado, cada ocorrência mantém sua própria data.</span></span></label><label className="flex cursor-pointer items-start gap-3 rounded-xl bg-[#f4f7f5] p-3"><Checkbox checked={changeFutureRecurrenceEnd} onCheckedChange={(value) => setChangeFutureRecurrenceEnd(value === true)} /><span><span className="block text-sm font-medium">Alterar também a data limite da recorrência</span><span className="block text-xs text-[#71837e]">Desmarcado, o término atual da série é preservado.</span></span></label></div>}
    {scope === "selected" && recurringEdit && <div className="sm:col-span-2 rounded-2xl border border-[#d8e1de] p-3"><label className="flex cursor-pointer items-start gap-3 rounded-xl bg-[#f4f7f5] p-3"><Checkbox checked={changeSelectedDueDate} onCheckedChange={(value) => setChangeSelectedDueDate(value === true)} /><span><span className="block text-sm font-medium">Alterar também o dia do vencimento</span><span className="block text-xs text-[#71837e]">Desmarcado, cada ocorrência mantém sua própria data.</span></span></label><div className="mt-3 flex flex-wrap items-center justify-between gap-2"><div><Label>Escolher ocorrências</Label><p className="text-xs text-[#71837e]">Pagas e canceladas são exibidas apenas para contexto.</p></div><Button type="button" size="sm" variant="ghost" onClick={() => setSelectedOccurrenceIds(selectedIds.length === eligibleIds.length ? [] : eligibleIds)}>{selectedIds.length === eligibleIds.length ? "Desmarcar todos" : "Selecionar todos os elegíveis"}</Button></div><div className="mt-3 max-h-56 space-y-2 overflow-y-auto pr-1">{seriesOccurrences.map((occurrence) => { const eligible = occurrence.status === "pending"; const checked = selectedIds.includes(occurrence.id); const status = occurrence.status === "paid" ? "Pago" : occurrence.status === "cancelled" ? "Cancelado" : occurrence.displayStatus === "overdue" ? "Vencido · pendente" : "Pendente"; return <label key={occurrence.id} className={`flex items-center gap-3 rounded-xl border p-3 ${eligible ? "cursor-pointer bg-white" : "cursor-not-allowed bg-[#f4f7f5] opacity-65"}`}><Checkbox checked={checked} disabled={!eligible} onCheckedChange={(value) => setSelectedOccurrenceIds(toggleRecurringBillSelection(selectedIds, occurrence.id, value === true, eligibleIds))} /><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{formatBillDate(occurrence.dueDate)}</span><span className="block text-xs text-[#71837e]">{brl(occurrence.amountCents)} · {status}</span></span></label>; })}</div></div>}
    {recurringEdit && <div className="sm:col-span-2 rounded-xl bg-[#edf6f3] px-3 py-2 text-sm font-medium text-[#285f56]">{affectedCount} vencimento(s) será(ão) alterado(s).</div>}
    <div className="sm:col-span-2"><Field name="notes" label="Observação" defaultValue={item?.notes ?? ""} /></div><DialogFooter className="sm:col-span-2"><Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancelar</Button><Button type="submit" disabled={busy || (scope === "selected" && selectedIds.length === 0)}>{busy ? "Salvando..." : item ? "Salvar alterações" : "Criar vencimento"}</Button></DialogFooter>
  </form></DialogContent></Dialog>;
}

function BillClassificationFields({ categories, classification, onChange }: { categories: Category[]; classification: { categoryId: string | null; subcategoryId: string | null }; onChange: (value: { categoryId: string | null; subcategoryId: string | null }) => void }) {
  const subcategories = activeBillSubcategories(categories, classification.categoryId) as Subcategory[];
  return <><div><Label>Categoria *</Label><Select value={classification.categoryId ?? "none"} onValueChange={(value) => onChange(changeBillCategory(classification, value === "none" ? null : value))}><SelectTrigger className="mt-2 w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none" disabled>Selecione uma categoria</SelectItem>{categories.map((category) => <SelectItem key={category.id} value={category.id}>{category.name}</SelectItem>)}</SelectContent></Select></div>{classification.categoryId && subcategories.length > 0 ? <div><Label>Subcategoria *</Label><Select value={classification.subcategoryId ?? "none"} onValueChange={(value) => onChange({ ...classification, subcategoryId: value === "none" ? null : value })}><SelectTrigger className="mt-2 w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none" disabled>Selecione uma subcategoria</SelectItem>{subcategories.map((subcategory) => <SelectItem key={subcategory.id} value={subcategory.id}>{subcategory.name}</SelectItem>)}</SelectContent></Select></div> : classification.categoryId ? <div className="self-end rounded-xl bg-[#f4f7f5] px-3 py-3 text-sm text-[#71837e]">Esta categoria não possui subcategorias ativas.</div> : null}</>;
}

function BillPaymentDialog({ open, bill, accounts, categories, onOpenChange, onChanged, onEdit }: { open: boolean; bill: Bill; accounts: Account[]; categories: Category[]; onOpenChange: (open: boolean) => void; onChanged: () => Promise<void>; onEdit: () => void }) {
  const activeAccounts = accounts.filter((account) => account.isActive);
  const [accountId, setAccountId] = useState<string | null>(initialBillPaymentAccountId(bill, accounts));
  const [paidAmount, setPaidAmount] = useState(formatBillPaymentInput(bill.amountCents));
  const today = billTodayInSaoPaulo();
  const [paidOn, setPaidOn] = useState(today);
  const [discountConfirmed, setDiscountConfirmed] = useState(false);
  const [operationId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; classification: boolean } | null>(null);
  const category = categories.find((item) => item.id === bill.categoryId);
  const subcategory = category?.subcategories.find((item) => item.id === bill.subcategoryId);
  let paidAmountCents: number | null = null;
  let amountError = "";
  try { paidAmountCents = parseBillPaymentCents(paidAmount); } catch (cause) { amountError = cause instanceof Error ? cause.message : "Valor pago inválido."; }
  const adjustment = paidAmountCents === null ? null : billPaymentAdjustment(bill.amountCents, paidAmountCents);
  const invalidDate = !/^\d{4}-\d{2}-\d{2}$/u.test(paidOn) || paidOn > today;
  const confirm = async () => {
    if (!accountId || paidAmountCents === null || invalidDate || busy || (adjustment?.adjustmentType === "discount" && !discountConfirmed)) return;
    setBusy(true); setError(null);
    let completed = false;
    try {
      await advancedApi(buildBillPaymentPayload({ billId: bill.id, accountId, paidAmountCents, paidOn, expectedAmountCents: bill.amountCents, operationId, differenceTreatment: adjustment?.adjustmentType === "discount" ? ("discount" as const) : null }));
      toast.success(`Pagamento realizado usando ${accounts.find((account) => account.id === accountId)?.name ?? "a conta selecionada"}.`);
      await onChanged();
      completed = true;
    } catch (cause) {
      const code = cause instanceof AdvancedApiError ? cause.code : undefined;
      const message = friendlyBillPaymentError(code, cause instanceof Error ? cause.message : undefined);
      setError({ message, classification: code === "BILL_CLASSIFICATION_REQUIRED" });
    } finally { setBusy(false); if (completed) onOpenChange(false); }
  };
  return <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}><DialogContent className="max-h-[85dvh] overflow-y-auto"><DialogHeader><DialogTitle>Confirmar pagamento</DialogTitle><DialogDescription>Informe o valor efetivamente pago, a data financeira e a conta utilizada.</DialogDescription></DialogHeader>
    <div className="grid gap-3 rounded-2xl bg-[#f4f7f5] p-4 text-sm sm:grid-cols-2"><BillDetail label="Descrição" value={bill.description} /><BillDetail label="Valor previsto" value={brl(bill.amountCents)} /><BillDetail label="Vencimento" value={formatBillDate(bill.dueDate)} /><BillDetail label="Categoria" value={category?.name ?? "Sem categoria"} /><BillDetail label="Subcategoria" value={subcategory?.name ?? "Sem subcategoria"} /></div>
    <div className="grid gap-4 sm:grid-cols-2"><div><Label htmlFor="bill-paid-amount">Valor pago *</Label><Input id="bill-paid-amount" className="mt-2" inputMode="decimal" value={paidAmount} onChange={(event) => { setPaidAmount(event.target.value); setDiscountConfirmed(false); setError(null); }} aria-invalid={Boolean(amountError)} />{amountError && <p className="mt-2 text-xs text-destructive">{amountError}</p>}</div><div><Label htmlFor="bill-paid-on">Data do pagamento *</Label><Input id="bill-paid-on" className="mt-2" type="date" max={today} value={paidOn} onChange={(event) => { setPaidOn(event.target.value); setError(null); }} aria-invalid={invalidDate} />{invalidDate && <p className="mt-2 text-xs text-destructive">Informe uma data válida que não seja futura.</p>}</div></div>
    {adjustment?.adjustmentType === "normal" && <div className="rounded-xl border bg-muted/50 p-3 text-sm"><span className="font-medium">Sem ajuste</span><span className="ml-2 text-muted-foreground">O valor pago é igual ao previsto.</span></div>}
    {adjustment?.adjustmentType === "surcharge" && <div className="rounded-xl border bg-muted/50 p-3 text-sm text-foreground"><span className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">Acréscimo / juros</span><strong className="mt-1 block text-lg">+ {brl(adjustment.adjustmentAmountCents)}</strong><p className="mt-1">O saldo será reduzido pelo valor total de {brl(paidAmountCents ?? 0)}.</p></div>}
    {adjustment?.adjustmentType === "discount" && <div className="rounded-xl border bg-muted/50 p-3 text-sm text-foreground"><span className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">Desconto</span><strong className="mt-1 block text-lg">{brl(Math.abs(adjustment.adjustmentAmountCents))}</strong><label className="mt-3 flex cursor-pointer items-start gap-3 rounded-lg border bg-background p-3"><Checkbox checked={discountConfirmed} onCheckedChange={(value) => setDiscountConfirmed(value === true)} /><span>Este vencimento será considerado totalmente pago. A diferença de {brl(Math.abs(adjustment.adjustmentAmountCents))} será tratada como desconto.</span></label></div>}
    <div><Label>Conta utilizada *</Label><Select value={accountId ?? "none"} onValueChange={(value) => { setAccountId(normalizeBillAccountId(value)); setError(null); }}><SelectTrigger className="mt-2 w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none" disabled>Selecione uma conta</SelectItem>{activeAccounts.map((account) => <SelectItem key={account.id} value={account.id}>{account.name} · {brl(account.currentBalanceCents)}</SelectItem>)}</SelectContent></Select>{bill.accountId && accountId === bill.accountId && <p className="mt-2 text-xs text-[#71837e]">Conta previamente definida para este vencimento. Você pode alterá-la antes de confirmar.</p>}{bill.accountId && accountId !== bill.accountId && <p className="mt-2 text-xs text-[#71837e]">A conta planejada será preservada; este pagamento usará somente a conta selecionada acima.</p>}{bill.accountId && !accountId && <p className="mt-2 text-xs text-[#9b5b17]">A conta anteriormente definida não está ativa. Selecione outra conta para pagar.</p>}{!activeAccounts.length && <p className="mt-2 text-xs text-[#9b5b17]">Não existe uma conta ativa disponível para este pagamento.</p>}</div>
    {error && <div className="rounded-xl border border-[#e7b9b9] bg-[#fff4f4] p-3 text-sm text-[#8c3434]"><p>{error.message}</p>{error.classification && <Button className="mt-2" size="sm" variant="outline" onClick={onEdit}>Editar classificação</Button>}</div>}
    <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Voltar</Button><Button type="button" disabled={busy || !accountId || paidAmountCents === null || invalidDate || (adjustment?.adjustmentType === "discount" && !discountConfirmed)} onClick={confirm}>{busy ? "Pagando..." : "Confirmar pagamento"}</Button></DialogFooter>
  </DialogContent></Dialog>;
}

function BillConfirmationDialog({ open, bill, kind, onOpenChange, onChanged }: { open: boolean; bill: Bill; kind: "cancel" | "undo"; onOpenChange: (open: boolean) => void; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState<"occurrence" | "future">("occurrence");
  const recurring = Boolean(bill.recurrenceSeriesId);
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    let completed = false;
    try {
      if (kind === "undo") await advancedApi({ action: "undo_bill_payment", id: bill.id });
      else if (scope === "future" && bill.recurrenceSeriesId) await advancedApi({ action: "cancel_recurring_bill_series", id: bill.recurrenceSeriesId });
      else await advancedApi({ action: "cancel_bill_occurrence", id: bill.id });
      toast.success(kind === "undo" ? "Pagamento desfeito. O vencimento voltou para pendente." : scope === "future" && recurring ? "Série e vencimentos futuros cancelados." : "Vencimento cancelado.");
      await onChanged();
      completed = true;
    } catch (error) { toast.error(error instanceof Error ? error.message : "Não foi possível concluir a operação."); }
    finally { setBusy(false); if (completed) onOpenChange(false); }
  };
  return <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}><DialogContent><DialogHeader><DialogTitle>{kind === "undo" ? "Desfazer pagamento?" : "Cancelar vencimento?"}</DialogTitle><DialogDescription>{kind === "undo" ? "O vencimento voltará para pendente, a transação financeira vinculada será removida e o efeito no saldo será revertido." : "O vencimento cancelado não poderá ser pago e não será tratado como despesa realizada."}</DialogDescription></DialogHeader>{kind === "cancel" && recurring && <div><Label>Alcance do cancelamento</Label><Select value={scope} onValueChange={(value) => setScope(value as "occurrence" | "future")}><SelectTrigger className="mt-2 w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="occurrence">Somente esta ocorrência</SelectItem><SelectItem value="future">Todos os vencimentos futuros da série</SelectItem></SelectContent></Select></div>}<DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Voltar</Button><Button type="button" variant={kind === "cancel" ? "destructive" : "default"} disabled={busy} onClick={confirm}>{busy ? kind === "undo" ? "Desfazendo..." : "Cancelando..." : kind === "undo" ? "Desfazer pagamento" : "Confirmar cancelamento"}</Button></DialogFooter></DialogContent></Dialog>;
}

function BillDetail({ label, value }: { label: string; value: string }) { return <div><p className="text-xs text-[#71837e]">{label}</p><p className="mt-1 font-medium">{value}</p></div>; }
function formatBillDate(date: string) { return new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`)); }

function SimulatorView({ data }: { data: AdvancedSnapshot }) {
  const [result, setResult] = useState<{ rating: string | null; label?: string; reasons: string[]; installmentCents?: number; lowestBalanceCents?: number; months: Array<{ month: string; projectedBalanceCents: number; simulatedCents: number }> } | null>(null);
  const run = async (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { const response = await advancedApi({ action: "simulate_purchase", description: form.get("description"), purchaseCents: cents(form.get("amount")), purchaseDate: form.get("purchaseDate"), paymentMethod: form.get("paymentMethod"), installmentCount: Number(form.get("installmentCount")), cardId: form.get("cardId") === "none" ? null : form.get("cardId") }); setResult(response as unknown as typeof result); } catch (error) { toast.error(error instanceof Error ? error.message : "Falha na simulação."); } };
  const tone = result?.rating === "green" ? "border-[#84b15e] bg-[#f3faed]" : result?.rating === "yellow" ? "border-[#e0bd63] bg-[#fff9e8]" : "border-[#d77b82] bg-[#fff1f2]";
  return <section><Heading title="Simulador de Compra" text="Projete a compra nos próximos meses sem criar qualquer lançamento real." /><div className="mt-6 grid gap-5 xl:grid-cols-[.8fr_1.2fr]"><form onSubmit={run} className="grid gap-4 rounded-[24px] border bg-white p-5"><Field name="description" label="Descrição da compra" required /><Field name="amount" label="Valor total (R$)" inputMode="decimal" required /><Field name="purchaseDate" label="Data provável" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required /><SelectField name="paymentMethod" label="Forma de pagamento" items={[{ value: "cash", label: "À vista" }, { value: "credit_card", label: "Cartão de crédito" }]} /><Field name="installmentCount" label="Número de parcelas" type="number" min={1} max={120} defaultValue={1} required /><SelectField name="cardId" label="Cartão (se aplicável)" items={[{ value: "none", label: "Sem cartão" }, ...data.cards.filter((item) => item.isActive).map((item) => ({ value: item.id, label: item.name }))]} /><Button type="submit"><Sparkles className="h-4 w-4" /> Analisar compra</Button></form><div className="rounded-[24px] border bg-white p-5">{result ? <div><div className={`rounded-2xl border p-5 ${tone}`}><p className="text-xs font-semibold uppercase tracking-wider">{result.rating ? result.rating : "Dados insuficientes"}</p><h3 className="mt-1 text-xl font-semibold">{result.label ?? "Não existem informações suficientes para uma análise confiável."}</h3>{result.installmentCents != null && <p className="mt-2 text-sm">Parcela base: {brl(result.installmentCents)} · menor saldo: {brl(result.lowestBalanceCents ?? 0)}</p>}</div><ul className="mt-5 space-y-2 text-sm text-[#526b65]">{result.reasons.map((reason) => <li key={reason}>• {reason}</li>)}</ul>{result.months.length > 0 && <div className="mt-5 grid gap-2">{result.months.map((row) => <div key={row.month} className="flex justify-between rounded-xl bg-[#f5f7f6] p-3 text-sm"><span className="capitalize">{monthLabel(row.month)} · +{brl(row.simulatedCents)}</span><strong>{brl(row.projectedBalanceCents)}</strong></div>)}</div>}</div> : <Empty icon={Sparkles} text="Preencha os dados para comparar a compra com renda, contas, faturas e parcelas futuras." />}</div></div></section>;
}

function TelegramSettings() {
  const [code, setCode] = useState("");
  const [connection, setConnection] = useState<"loading" | "connected" | "disconnected" | "error">("loading");
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [preference, setPreference] = useState<NotificationPreference | null>(null);
  const [preferenceState, setPreferenceState] = useState<"loading" | "ready" | "saving" | "saved" | "error">("loading");
  const [preferenceError, setPreferenceError] = useState("");
  const loadConnection = async (signal?: AbortSignal) => {
    try {
      const connected = await telegramLinkStatus(signal);
      if (!signal?.aborted) setConnection(connected ? "connected" : "disconnected");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (!signal?.aborted) setConnection("error");
    }
  };
  const loadPreferences = async (signal?: AbortSignal) => {
    setPreferenceState("loading");
    setPreferenceError("");
    try {
      const result = await notificationPreferencesApi(undefined, signal);
      if (!signal?.aborted) {
        setPreference(result);
        setPreferenceState("ready");
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (!signal?.aborted) {
        setPreferenceError(error instanceof Error ? error.message : "Não foi possível carregar as preferências.");
        setPreferenceState("error");
      }
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    void telegramLinkStatus(controller.signal).then(
      (connected) => { if (!controller.signal.aborted) setConnection(connected ? "connected" : "disconnected"); },
      (error: unknown) => { if (!(error instanceof DOMException && error.name === "AbortError") && !controller.signal.aborted) setConnection("error"); },
    );
    void notificationPreferencesApi(undefined, controller.signal).then(
      (result) => { if (!controller.signal.aborted) { setPreference(result); setPreferenceState("ready"); } },
      (error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError") && !controller.signal.aborted) {
          setPreferenceError(error instanceof Error ? error.message : "Não foi possível carregar as preferências.");
          setPreferenceState("error");
        }
      },
    );
    return () => controller.abort();
  }, []);
  const generate = async () => { setConnectionBusy(true); try { const response = await fetch("/api/telegram/link-code", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); const result = await response.json() as { code?: string; error?: string }; if (!response.ok) throw new Error(result.error); setCode(result.code ?? ""); } catch (error) { toast.error(error instanceof Error ? error.message : "Não foi possível gerar o código."); } finally { setConnectionBusy(false); } };
  const disconnect = async () => {
    if (!window.confirm("Desvincular seu Telegram? Você poderá gerar um novo código de conexão depois.")) return;
    setConnectionBusy(true);
    try {
      const response = await fetch("/api/telegram/link", { method: "DELETE" });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Não foi possível desvincular o Telegram.");
      setCode("");
      setConnection("disconnected");
      toast.success("Telegram desvinculado. Agora você pode gerar um novo código.");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Não foi possível desvincular o Telegram."); }
    finally { setConnectionBusy(false); }
  };
  const updatePreference = (changes: Partial<NotificationPreference>) => setPreference((current) => current ? { ...current, ...changes } : current);
  const savePreferences = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!preference || preferenceState === "saving") return;
    setPreferenceState("saving");
    setPreferenceError("");
    try {
      const saved = await notificationPreferencesApi({
        channel: "telegram",
        enabled: preference.enabled,
        billDueTomorrow: preference.billDueTomorrow,
        billDueToday: preference.billDueToday,
        billOverdue: preference.billOverdue,
        preferredLocalTime: preference.preferredLocalTime,
        timezone: "America/Sao_Paulo",
      });
      setPreference(saved);
      setPreferenceState("saved");
      toast.success("Preferências de notificações salvas.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Não foi possível salvar as preferências.";
      setPreferenceError(message);
      setPreferenceState("error");
      toast.error(message);
    }
  };
  return <section><Heading title="Configurações" text="Conecte seu Telegram e escolha quando deseja receber avisos." /><div className="mt-6 grid max-w-4xl gap-5 md:grid-cols-2"><div className="rounded-[24px] border bg-white p-4 sm:p-6"><div className="flex items-start gap-4"><div className="rounded-2xl bg-[#edf6f3] p-3"><Link2 className="h-5 w-5" /></div><div><h3 className="font-semibold">Telegram</h3><p className="mt-1 text-sm leading-6 text-[#71837e]">O vínculo é individual: cada pessoa conecta seu próprio Telegram à família.</p></div></div><div className="mt-5">{connection === "loading" && <p className="text-sm text-[#71837e]">Verificando conexão...</p>}{connection === "error" && <div><p className="text-sm text-[#a1444d]">Não foi possível verificar a conexão.</p><Button className="mt-3 min-h-11" variant="outline" onClick={() => { setConnection("loading"); void loadConnection(); }} disabled={connectionBusy}>Tentar novamente</Button></div>}{connection === "connected" && <div><p className="font-semibold text-[#287461]">✓ Telegram conectado</p><p className="mt-1 text-sm text-[#71837e]">Seu Telegram está pronto para receber os avisos que você ativar.</p><Button className="mt-4 min-h-11 w-full sm:w-auto" variant="outline" onClick={() => void disconnect()} disabled={connectionBusy}>{connectionBusy ? "Desvinculando..." : "Desvincular Telegram"}</Button></div>}{connection === "disconnected" && <div><p className="font-semibold">Telegram não conectado</p><p className="mt-1 text-sm leading-6 text-[#71837e]">Conecte seu Telegram para receber avisos. Use o mesmo fluxo seguro: gere um código e envie <strong>/conectar CÓDIGO</strong> ao bot. O código expira em 10 minutos.</p>{code ? <div className="mt-4 rounded-2xl bg-[#0d2925] p-5 text-center text-white"><p className="text-xs text-white/60">Código temporário · expira em 10 minutos</p><p className="mt-1 font-mono text-3xl tracking-[.25em]">{code}</p><p className="mt-2 text-xs text-white/60">/conectar {code}</p></div> : <Button className="mt-4 min-h-11 w-full sm:w-auto" onClick={() => void generate()} disabled={connectionBusy}>{connectionBusy ? "Gerando..." : "Gerar código de conexão"}</Button>}</div>}</div></div><div className="rounded-[24px] border bg-white p-4 sm:p-6"><h3 className="font-semibold">Notificações</h3><p className="mt-1 text-sm leading-6 text-[#71837e]">Escolha seus avisos de contas e vencimentos. Salvar não envia nenhuma mensagem agora.</p>{preferenceState === "loading" && <div className="mt-5 rounded-2xl bg-[#f5f7f6] p-4 text-sm text-[#71837e]">Carregando preferências...</div>}{preferenceState === "error" && !preference && <div className="mt-5" role="alert"><p className="text-sm text-[#a1444d]">{preferenceError || "Não foi possível carregar as preferências."}</p><Button className="mt-3 min-h-11" type="button" variant="outline" onClick={() => void loadPreferences()}>Tentar novamente</Button></div>}{preference && <form onSubmit={savePreferences} className="mt-5 grid gap-5"><label className="flex min-h-11 items-center gap-3 rounded-2xl border p-3 text-sm font-medium"><input type="checkbox" name="enabled" checked={preference.enabled} onChange={(event) => updatePreference({ enabled: event.target.checked })} /> Ativar notificações</label><fieldset className="grid gap-2"><legend className="mb-2 text-sm font-semibold">Quero ser avisado:</legend>{[["billDueTomorrow", "1 dia antes"], ["billDueToday", "No dia do vencimento"], ["billOverdue", "Quando a conta ficar atrasada"]].map(([field, label]) => <label key={field} className="flex min-h-11 items-center gap-3 rounded-xl px-2 text-sm"><input type="checkbox" name={field} checked={preference[field as "billDueTomorrow" | "billDueToday" | "billOverdue"]} onChange={(event) => updatePreference({ [field]: event.target.checked })} /> {label}</label>)}</fieldset><div><Label htmlFor="notification-time">Horário preferido</Label><Input id="notification-time" name="preferredLocalTime" className="mt-2 min-h-11" type="time" value={preference.preferredLocalTime} onChange={(event) => updatePreference({ preferredLocalTime: event.target.value })} required /><p className="mt-2 text-xs text-[#71837e]">Seus avisos serão programados com base neste horário.</p></div><div className="rounded-2xl bg-[#f5f7f6] p-4"><p className="text-xs text-[#71837e]">Fuso horário</p><p className="mt-1 text-sm font-medium">Horário de Brasília</p></div>{preferenceState === "saved" && <p className="text-sm font-medium text-[#287461]" role="status">Preferências salvas.</p>}{preferenceState === "error" && preferenceError && <p className="text-sm text-[#a1444d]" role="alert">{preferenceError}</p>}<Button className="min-h-11 w-full sm:w-auto" type="submit" disabled={preferenceState === "saving"}>{preferenceState === "saving" ? "Salvando..." : "Salvar preferências"}</Button></form>}</div></div></section>;
}

function Heading({ title, text, action }: { title: string; text: string; action?: React.ReactNode }) { return <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><h2 className="text-3xl font-semibold tracking-[-.04em]">{title}</h2><p className="mt-2 max-w-2xl text-[#71837e]">{text}</p></div>{action}</div>; }
function Field({ label, name, ...props }: { label: string; name: string } & React.ComponentProps<typeof Input>) { return <div><Label htmlFor={name}>{label}</Label><Input id={name} name={name} className="mt-2" {...props} /></div>; }
function SelectField({ label, name, items }: { label: string; name: string; items: Array<{ value: string; label: string }> }) { return <div><Label>{label}</Label><Select name={name} defaultValue={items[0]?.value}><SelectTrigger className="mt-2 w-full"><SelectValue /></SelectTrigger><SelectContent>{items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select></div>; }
function Stat({ label, value }: { label: string; value: string }) { return <div className="min-w-0"><p className="text-xs text-[#71837e]">{label}</p><p className="mt-1 break-words font-semibold tabular-nums">{value}</p></div>; }
function Empty({ icon: Icon, text }: { icon: typeof CreditCard; text: string }) { return <div className="mt-6 flex min-h-52 flex-col items-center justify-center rounded-[24px] border border-dashed bg-white p-8 text-center"><Icon className="h-8 w-8 text-[#78918b]" /><p className="mt-3 text-sm text-[#71837e]">{text}</p></div>; }
