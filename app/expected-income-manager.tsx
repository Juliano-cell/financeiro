"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarClock, Pencil, Plus, RefreshCcw, RotateCcw, XCircle } from "lucide-react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { formatFinancialCents } from "@/lib/ui-preferences.mjs";
import {
  centsToCurrencyInput,
  currencyInputToCents,
  expectedIncomeDifference,
  expectedIncomeFilterMatch,
  expectedIncomeStatusLabel,
  mutationSemanticKey,
  normalizeExpectedIncomeClassification,
  normalizeExpectedIncomeSelectId,
  recurringExpectedIncomePreview,
  recurringExpectedIncomeStartsOn,
} from "@/lib/expected-income-ui-rules.mjs";

type Account = { id: string; name: string; isActive: boolean };
type Subcategory = { id: string; name: string; isActive?: boolean };
type Category = { id: string; name: string; type: "income" | "expense" | "both"; isActive: boolean; subcategories: Subcategory[] };
type NamedReference = { id: string; name: string };
type Occurrence = {
  id: string;
  seriesId: string | null;
  occurrenceMonth: string | null;
  description: string;
  expectedAmountCents: number;
  expectedDate: string;
  plannedAccount: NamedReference | null;
  category: NamedReference | null;
  subcategory: NamedReference | null;
  notes: string | null;
  status: "pending" | "received" | "cancelled";
  timing: "pending" | "overdue" | "received" | "cancelled";
  receivedTransaction: { id: string; amountCents: number; receivedDate: string; actualAccount: NamedReference | null } | null;
  recurrence: { type: "monthly"; configuredDay: number; startsOn: string; endsOn: string | null; materializedThroughMonth: string; isActive: boolean } | null;
};
type Snapshot = { today: string; occurrences: Occurrence[] };
type Filter = "pending" | "overdue" | "received" | "cancelled";
type MutationIntent = { semantic: string; operationId: string };

const filters: Array<{ id: Filter; label: string }> = [
  { id: "pending", label: "A receber" },
  { id: "overdue", label: "Atrasadas" },
  { id: "received", label: "Recebidas" },
  { id: "cancelled", label: "Canceladas" },
];
const dateFormatter = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
const formatDate = (date: string | null | undefined) => date ? dateFormatter.format(new Date(`${date}T00:00:00Z`)) : "—";

async function expectedIncomeApi(body?: Record<string, unknown>, signal?: AbortSignal) {
  const response = await fetch("/api/finance/expected-income", body ? {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  } : { cache: "no-store", credentials: "same-origin", signal });
  const result = await response.json() as { error?: string } & Record<string, unknown>;
  if (!response.ok) throw new Error(result.error || "Não foi possível concluir a operação.");
  return result;
}

export function ExpectedIncomeManager({ accounts, categories, valuesHidden, onFinancialChanged }: { accounts: Account[]; categories: Category[]; valuesHidden: boolean; onFinancialChanged: () => Promise<void> }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("pending");
  const [visibleLimit, setVisibleLimit] = useState(8);
  const [entryOpen, setEntryOpen] = useState(false);
  const [editing, setEditing] = useState<Occurrence | null>(null);
  const [receiving, setReceiving] = useState<Occurrence | null>(null);
  const [cancelling, setCancelling] = useState<Occurrence | null>(null);
  const [reversing, setReversing] = useState<Occurrence | null>(null);
  const [materializing, setMaterializing] = useState<Occurrence | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const intents = useRef(new Map<string, MutationIntent>());
  const busy = useRef(new Set<string>());

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoadError(null);
    try { setSnapshot(await expectedIncomeApi(undefined, signal) as unknown as Snapshot); }
    catch (error) {
      if (signal?.aborted) return;
      setLoadError(error instanceof Error ? error.message : "Não foi possível carregar as entradas previstas.");
    } finally { if (!signal?.aborted) setLoading(false); }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => load(controller.signal));
    return () => controller.abort();
  }, [load]);

  const mutate = useCallback(async (key: string, action: string, payload: Record<string, unknown>, financial = false) => {
    if (busy.current.has(key)) return null;
    const semantic = mutationSemanticKey(action, payload);
    let intent = intents.current.get(key);
    if (!intent || intent.semantic !== semantic) {
      intent = { semantic, operationId: crypto.randomUUID() };
      intents.current.set(key, intent);
    }
    busy.current.add(key);
    setBusyKey(key);
    setMutationError(null);
    try {
      const result = await expectedIncomeApi({ action, operationId: intent.operationId, ...payload });
      intents.current.delete(key);
      await load();
      if (financial) await onFinancialChanged();
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Não foi possível concluir a operação.";
      setMutationError(message);
      toast.error(message);
      return null;
    } finally {
      busy.current.delete(key);
      setBusyKey((current) => current === key ? null : current);
    }
  }, [load, onFinancialChanged]);

  const visible = useMemo(() => (snapshot?.occurrences ?? []).filter((item) => expectedIncomeFilterMatch(item, filter)), [filter, snapshot]);
  const displayMoney = (cents: number) => formatFinancialCents(cents, { hidden: valuesHidden });
  const displayDifference = (difference: number) => valuesHidden ? formatFinancialCents(0, { hidden: true }) : difference === 0 ? "Sem diferença" : `${difference > 0 ? "+" : "−"} ${formatFinancialCents(Math.abs(difference), { hidden: false })}`;

  if (loading) return <section aria-busy="true" aria-label="Carregando entradas previstas" className="space-y-4"><Skeleton className="h-12 w-full max-w-md" /><Skeleton className="h-32 w-full rounded-3xl" /><Skeleton className="h-32 w-full rounded-3xl" /></section>;
  if (loadError) return <section role="alert" className="rounded-3xl border border-border bg-card p-8 text-center text-card-foreground"><h2 className="text-xl font-semibold">Não foi possível carregar as entradas previstas</h2><p className="mt-2 text-sm text-muted-foreground">{loadError}</p><Button className="mt-5" onClick={() => { setLoading(true); void load(); }}><RefreshCcw className="h-4 w-4" /> Tentar novamente</Button></section>;
  if (!snapshot) return null;

  return <section>
    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
      <div><h2 className="text-3xl font-semibold tracking-[-.04em]">Entradas previstas</h2><p className="mt-2 max-w-2xl text-muted-foreground">Acompanhe valores a receber. Eles só entram no realizado quando você confirmar o recebimento.</p></div>
      <Button onClick={() => { setEditing(null); setMutationError(null); setEntryOpen(true); }}><Plus className="h-4 w-4" /> Nova entrada prevista</Button>
    </div>
    <div role="tablist" aria-label="Filtrar entradas previstas" className="mt-6 grid grid-cols-2 gap-2 rounded-2xl border border-border bg-card p-2 sm:inline-flex">
      {filters.map((item) => <button key={item.id} role="tab" aria-selected={filter === item.id} onClick={() => { setFilter(item.id); setVisibleLimit(8); }} className={`rounded-xl px-4 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${filter === item.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}>{item.label}</button>)}
    </div>
    {visible.length ? <><div className="mt-5 grid gap-4 lg:grid-cols-2">{visible.slice(0, visibleLimit).map((item) => {
      const received = item.receivedTransaction;
      const difference = received ? expectedIncomeDifference(item.expectedAmountCents, received.amountCents) : null;
      return <article key={item.id} className="rounded-3xl border border-border bg-card p-5 text-card-foreground shadow-sm">
        <div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="break-words font-semibold">{item.description}</h3>{item.recurrence && <Badge variant="outline">Mensal</Badge>}</div><p className="mt-1 text-sm text-muted-foreground">Prevista para {formatDate(item.expectedDate)}</p></div><Badge variant={item.status === "received" ? "secondary" : "outline"}>{expectedIncomeStatusLabel(item)}</Badge></div>
        <p className="mt-5 text-2xl font-semibold" aria-label={valuesHidden ? "Valor previsto oculto" : undefined}>{displayMoney(item.expectedAmountCents)}</p>
        <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">Conta planejada</dt><dd>{item.plannedAccount?.name ?? "Definir ao receber"}</dd></div><div><dt className="text-muted-foreground">Categoria</dt><dd>{item.category?.name ?? "Sem categoria"}{item.subcategory ? ` · ${item.subcategory.name}` : ""}</dd></div></dl>
        {item.seriesId && <p className="mt-3 text-xs text-muted-foreground">Alterações afetam somente esta ocorrência.</p>}
        {received && <div className="mt-4 rounded-2xl bg-muted p-4"><dl className="grid gap-2 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">Recebido</dt><dd aria-label={valuesHidden ? "Valor recebido oculto" : undefined}>{displayMoney(received.amountCents)}</dd></div><div><dt className="text-muted-foreground">Recebido em</dt><dd>{formatDate(received.receivedDate)}</dd></div><div><dt className="text-muted-foreground">Conta efetiva</dt><dd>{received.actualAccount?.name ?? "Conta indisponível"}</dd></div><div><dt className="text-muted-foreground">Diferença</dt><dd aria-label={valuesHidden ? "Diferença oculta" : undefined}>{displayDifference(difference ?? 0)}</dd></div></dl></div>}
        {item.notes && <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">{item.notes}</p>}
        <div className="mt-5 flex flex-wrap gap-2 border-t border-border pt-4">
          {item.status === "pending" && <><Button size="sm" onClick={() => { setMutationError(null); setReceiving(item); }}>Receber</Button><Button size="sm" variant="outline" onClick={() => { setEditing(item); setMutationError(null); setEntryOpen(true); }}><Pencil className="h-4 w-4" /> Editar</Button><Button size="sm" variant="ghost" onClick={() => setCancelling(item)}><XCircle className="h-4 w-4" /> Cancelar</Button></>}
          {item.status === "received" && <Button size="sm" variant="outline" onClick={() => setReversing(item)}><RotateCcw className="h-4 w-4" /> Estornar recebimento</Button>}
          {item.recurrence?.isActive && <Button size="sm" variant="ghost" onClick={() => setMaterializing(item)}><CalendarClock className="h-4 w-4" /> Estender série</Button>}
        </div>
      </article>;
    })}</div>{visible.length > visibleLimit && <div className="mt-5 text-center"><Button variant="outline" onClick={() => setVisibleLimit((limit) => limit + 8)}>Mostrar mais {Math.min(8, visible.length - visibleLimit)}</Button></div>}</> : <div className="mt-5 rounded-3xl border border-dashed border-border bg-card p-12 text-center"><CalendarClock className="mx-auto h-10 w-10 text-muted-foreground" /><h3 className="mt-4 font-semibold">Nenhuma entrada neste estado</h3><p className="mt-1 text-sm text-muted-foreground">Use “Nova entrada prevista” para planejar um recebimento.</p></div>}

    <EntryDialog key={`${editing?.id ?? "new"}-${entryOpen}`} open={entryOpen} item={editing} accounts={accounts} categories={categories} valuesHidden={valuesHidden} error={mutationError} busy={busyKey === "entry"} onOpenChange={setEntryOpen} onSubmit={async (action, payload) => { const result = await mutate("entry", action, payload); if (result) { setEntryOpen(false); toast.success(editing ? "Entrada prevista atualizada." : "Entrada prevista criada."); } }} />
    <ReceiveDialog key={`${receiving?.id ?? "none"}`} item={receiving} accounts={accounts} today={snapshot.today} valuesHidden={valuesHidden} error={mutationError} busy={busyKey === `receive:${receiving?.id}`} onClose={() => setReceiving(null)} onSubmit={async (payload) => { if (!receiving) return; const result = await mutate(`receive:${receiving.id}`, "receive_occurrence", { occurrenceId: receiving.id, ...payload }, true); if (result) { setReceiving(null); toast.success("Recebimento confirmado e saldo atualizado."); } }} />
    <AlertDialog open={Boolean(cancelling)} onOpenChange={(open) => { if (!open) setCancelling(null); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Cancelar entrada prevista?</AlertDialogTitle><AlertDialogDescription>A entrada deixará de ficar disponível para edição ou recebimento. Nenhum saldo será alterado.</AlertDialogDescription></AlertDialogHeader>{mutationError && <p role="alert" className="text-sm text-destructive">{mutationError}</p>}<AlertDialogFooter><AlertDialogCancel>Voltar</AlertDialogCancel><AlertDialogAction disabled={busyKey === `cancel:${cancelling?.id}`} onClick={(event) => { event.preventDefault(); if (!cancelling) return; void mutate(`cancel:${cancelling.id}`, "cancel_occurrence", { occurrenceId: cancelling.id }).then((result) => { if (result) { setCancelling(null); toast.success("Entrada prevista cancelada."); } }); }}>{busyKey === `cancel:${cancelling?.id}` ? "Cancelando…" : "Cancelar entrada"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    <ReverseDialog key={reversing?.id ?? "none"} item={reversing} today={snapshot.today} valuesHidden={valuesHidden} error={mutationError} busy={busyKey === `reverse:${reversing?.id}`} onClose={() => setReversing(null)} onSubmit={async (reversalDate) => { if (!reversing) return; const result = await mutate(`reverse:${reversing.id}`, "reverse_receipt", { occurrenceId: reversing.id, reversalDate }, true); if (result) { setReversing(null); toast.success("Recebimento estornado e histórico preservado."); } }} />
    <MaterializeDialog key={materializing?.id ?? "none"} item={materializing} error={mutationError} busy={busyKey === `materialize:${materializing?.seriesId}`} onClose={() => setMaterializing(null)} onSubmit={async (throughMonth) => { if (!materializing?.seriesId) return; const result = await mutate(`materialize:${materializing.seriesId}`, "materialize_series", { seriesId: materializing.seriesId, throughMonth }); if (result) { setMaterializing(null); toast.success("Série estendida."); } }} />
  </section>;
}

function EntryDialog({ open, item, accounts, categories, valuesHidden, error, busy, onOpenChange, onSubmit }: { open: boolean; item: Occurrence | null; accounts: Account[]; categories: Category[]; valuesHidden: boolean; error: string | null; busy: boolean; onOpenChange: (open: boolean) => void; onSubmit: (action: string, payload: Record<string, unknown>) => Promise<void> }) {
  const [kind, setKind] = useState<"single" | "recurring">("single");
  const [categoryId, setCategoryId] = useState(item?.category?.id ?? "none");
  const [subcategoryId, setSubcategoryId] = useState(item?.subcategory?.id ?? "none");
  const [startsOn, setStartsOn] = useState("");
  const [configuredDay, setConfiguredDay] = useState(31);
  const incomeCategories = categories.filter((category) => category.isActive && (category.type === "income" || category.type === "both"));
  const subcategories = incomeCategories.find((category) => category.id === categoryId)?.subcategories.filter((subcategory) => subcategory.isActive !== false) ?? [];
  let preview: string[] = [];
  if (!item && kind === "recurring" && startsOn) { try { preview = recurringExpectedIncomePreview(startsOn, configuredDay); } catch { preview = []; } }
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const amount = currencyInputToCents(String(values.get("amount") ?? ""));
    if (!amount) { toast.error("Informe um valor previsto válido."); return; }
    const classification = normalizeExpectedIncomeClassification(categoryId, subcategoryId);
    const common = {
      description: String(values.get("description") ?? ""), expectedAmountCents: amount,
      plannedAccountId: normalizeExpectedIncomeSelectId(values.get("plannedAccountId")),
      ...classification,
      notes: String(values.get("notes") ?? "") || null,
    };
    if (item) return onSubmit("update_occurrence", { occurrenceId: item.id, ...common, expectedDate: String(values.get("expectedDate")) });
    if (kind === "single") return onSubmit("create_occurrence", { ...common, expectedDate: String(values.get("expectedDate")) });
    let effectiveStart: string;
    try { effectiveStart = recurringExpectedIncomeStartsOn(startsOn, configuredDay); }
    catch (parseError) { toast.error(parseError instanceof Error ? parseError.message : "Recorrência inválida."); return; }
    return onSubmit("create_recurring_series", { ...common, configuredDay, startsOn: effectiveStart, endsOn: String(values.get("endsOn") ?? "") || null });
  };
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{item ? "Editar entrada prevista" : "Nova entrada prevista"}</DialogTitle><DialogDescription>{item?.seriesId ? "Esta alteração afeta somente esta ocorrência." : "Planeje uma entrada única ou mensal. Nenhum saldo muda até o recebimento."}</DialogDescription></DialogHeader>
    <form onSubmit={submit} className="space-y-5" aria-describedby={error ? "entry-error" : undefined}>
      {!item && <fieldset><legend className="mb-2 text-sm font-medium">Tipo</legend><div className="grid grid-cols-2 gap-2"><Button type="button" variant={kind === "single" ? "default" : "outline"} onClick={() => setKind("single")}>Única</Button><Button type="button" variant={kind === "recurring" ? "default" : "outline"} onClick={() => setKind("recurring")}>Recorrente mensal</Button></div></fieldset>}
      <div className="grid gap-4 sm:grid-cols-2"><Field label="Descrição" name="description" defaultValue={item?.description} required /><div><Label htmlFor="expected-income-amount">Valor previsto</Label><Input id="expected-income-amount" name="amount" type={valuesHidden ? "password" : "text"} inputMode="decimal" autoComplete="off" defaultValue={item ? centsToCurrencyInput(item.expectedAmountCents) : ""} required aria-label={valuesHidden ? "Valor previsto oculto" : "Valor previsto"} /></div></div>
      {(!item && kind === "recurring") ? <div className="grid gap-4 sm:grid-cols-3"><div><Label htmlFor="expected-income-start">Primeiro recebimento / início</Label><Input id="expected-income-start" name="startsOn" type="date" value={startsOn} onChange={(event) => setStartsOn(event.target.value)} required /></div><div><Label htmlFor="expected-income-day">Dia configurado</Label><Input id="expected-income-day" name="configuredDay" type="number" min={1} max={31} value={configuredDay} onChange={(event) => setConfiguredDay(Number(event.target.value))} required /></div><div><Label htmlFor="expected-income-end">Data final (opcional)</Label><Input id="expected-income-end" name="endsOn" type="date" /></div></div> : <Field label="Data prevista" name="expectedDate" type="date" defaultValue={item?.expectedDate} required />}
      {!item && kind === "recurring" && preview.length > 0 && <div className="rounded-2xl bg-muted p-4"><p className="text-sm font-medium">Próximas datas pela regra 29/30/31</p><p className="mt-1 text-sm text-muted-foreground">{preview.map(formatDate).join(" · ")}</p><p className="mt-2 text-xs text-muted-foreground" aria-label={valuesHidden ? "Valor recorrente oculto" : undefined}>O valor mensal permanece {valuesHidden ? formatFinancialCents(0, { hidden: true }) : "o informado acima"}.</p></div>}
      <div className="grid gap-4 sm:grid-cols-2"><div><Label htmlFor="expected-income-account">Conta planejada</Label><Select name="plannedAccountId" defaultValue={item?.plannedAccount?.id ?? "none"}><SelectTrigger id="expected-income-account"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Definir ao receber</SelectItem>{accounts.filter((account) => account.isActive).map((account) => <SelectItem key={account.id} value={account.id}>{account.name}</SelectItem>)}</SelectContent></Select></div><div><Label htmlFor="expected-income-category">Categoria</Label><Select value={categoryId} onValueChange={(value) => { setCategoryId(value); setSubcategoryId("none"); }}><SelectTrigger id="expected-income-category"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Sem categoria</SelectItem>{incomeCategories.map((category) => <SelectItem key={category.id} value={category.id}>{category.name}</SelectItem>)}</SelectContent></Select></div></div>
      <div><Label htmlFor="expected-income-subcategory">Subcategoria</Label><Select name="subcategoryId" value={subcategoryId} onValueChange={setSubcategoryId} disabled={categoryId === "none"}><SelectTrigger id="expected-income-subcategory"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Sem subcategoria</SelectItem>{subcategories.map((subcategory) => <SelectItem key={subcategory.id} value={subcategory.id}>{subcategory.name}</SelectItem>)}</SelectContent></Select></div>
      <div><Label htmlFor="expected-income-notes">Observação</Label><Textarea id="expected-income-notes" name="notes" maxLength={500} defaultValue={item?.notes ?? ""} /></div>
      {error && <p id="entry-error" role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Voltar</Button><Button type="submit" disabled={busy} aria-busy={busy}>{busy ? "Salvando…" : item ? "Salvar ocorrência" : "Salvar entrada"}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}

function ReceiveDialog({ item, accounts, today, valuesHidden, error, busy, onClose, onSubmit }: { item: Occurrence | null; accounts: Account[]; today: string; valuesHidden: boolean; error: string | null; busy: boolean; onClose: () => void; onSubmit: (payload: Record<string, unknown>) => Promise<void> }) {
  const defaultAccount = item?.plannedAccount && accounts.some((account) => account.id === item.plannedAccount?.id && account.isActive) ? item.plannedAccount.id : "";
  const [amount, setAmount] = useState(item ? centsToCurrencyInput(item.expectedAmountCents) : "");
  const cents = currencyInputToCents(amount);
  const difference = item && cents ? expectedIncomeDifference(item.expectedAmountCents, cents) : null;
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!item || !cents) { toast.error("Informe um valor recebido válido."); return; }
    const values = new FormData(event.currentTarget);
    const receivedDate = String(values.get("receivedDate") ?? "");
    const actualAccountId = String(values.get("actualAccountId") ?? "");
    if (!actualAccountId) { toast.error("Selecione a conta efetiva."); return; }
    if (receivedDate > today) { toast.error("A data recebida não pode estar no futuro."); return; }
    void onSubmit({ receivedAmountCents: cents, receivedDate, actualAccountId });
  };
  return <Dialog open={Boolean(item)} onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>Receber entrada prevista</DialogTitle><DialogDescription>Confirme o valor real, a data civil e a conta que recebeu o dinheiro.</DialogDescription></DialogHeader>{item && <form onSubmit={submit} className="space-y-4" aria-describedby={error ? "receive-error" : undefined}>
    <div className="rounded-2xl bg-muted p-4"><p className="text-sm text-muted-foreground">Valor previsto</p><p className="text-lg font-semibold" aria-label={valuesHidden ? "Valor previsto oculto" : undefined}>{formatFinancialCents(item.expectedAmountCents, { hidden: valuesHidden })}</p></div>
    <div><Label htmlFor="received-amount">Valor recebido</Label><Input id="received-amount" name="receivedAmount" type={valuesHidden ? "password" : "text"} inputMode="decimal" autoComplete="off" value={amount} onChange={(event) => setAmount(event.target.value)} required aria-label={valuesHidden ? "Valor recebido oculto" : "Valor recebido"} /></div>
    <div className="grid gap-4 sm:grid-cols-2"><Field label="Data recebida" name="receivedDate" type="date" defaultValue={today} max={today} required /><div><Label htmlFor="actual-account">Conta efetiva</Label><Select name="actualAccountId" defaultValue={defaultAccount}><SelectTrigger id="actual-account"><SelectValue placeholder="Selecione" /></SelectTrigger><SelectContent>{accounts.filter((account) => account.isActive).map((account) => <SelectItem key={account.id} value={account.id}>{account.name}</SelectItem>)}</SelectContent></Select></div></div>
    {difference !== null && (valuesHidden || difference !== 0) && <div className="rounded-2xl border border-border p-4"><p className="text-sm text-muted-foreground">Diferença</p><p className="font-semibold" aria-label={valuesHidden ? "Diferença oculta" : undefined}>{valuesHidden ? formatFinancialCents(0, { hidden: true }) : `${difference > 0 ? "+" : "−"} ${formatFinancialCents(Math.abs(difference), { hidden: false })}`}</p></div>}
    {error && <p id="receive-error" role="alert" className="text-sm text-destructive">{error}</p>}
    <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Voltar</Button><Button type="submit" disabled={busy} aria-busy={busy}>{busy ? "Confirmando…" : "Confirmar recebimento"}</Button></DialogFooter>
  </form>}</DialogContent></Dialog>;
}

function ReverseDialog({ item, today, valuesHidden, error, busy, onClose, onSubmit }: { item: Occurrence | null; today: string; valuesHidden: boolean; error: string | null; busy: boolean; onClose: () => void; onSubmit: (reversalDate: string) => Promise<void> }) {
  const received = item?.receivedTransaction;
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!received) return;
    const reversalDate = String(new FormData(event.currentTarget).get("reversalDate") ?? "");
    if (reversalDate < received.receivedDate) { toast.error("A data do estorno não pode ser anterior ao recebimento."); return; }
    if (reversalDate > today) { toast.error("A data do estorno não pode estar no futuro."); return; }
    void onSubmit(reversalDate);
  };
  return <Dialog open={Boolean(item)} onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>Estornar recebimento?</DialogTitle><DialogDescription>O recebimento original será preservado no extrato e um estorno compensatório devolverá a entrada para A receber. O estorno nunca será tratado como despesa.</DialogDescription></DialogHeader>{item && received && <form onSubmit={submit} className="space-y-4" aria-describedby={error ? "reverse-error" : undefined}>
    <div className="rounded-2xl bg-muted p-4"><dl className="grid gap-2 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">Valor recebido</dt><dd className="font-semibold" aria-label={valuesHidden ? "Valor recebido oculto" : undefined}>{formatFinancialCents(received.amountCents, { hidden: valuesHidden })}</dd></div><div><dt className="text-muted-foreground">Recebido em</dt><dd>{formatDate(received.receivedDate)}</dd></div><div className="sm:col-span-2"><dt className="text-muted-foreground">Conta efetiva</dt><dd>{received.actualAccount?.name ?? "Conta indisponível"}</dd></div></dl></div>
    <Field label="Data do estorno" name="reversalDate" type="date" defaultValue={today} min={received.receivedDate} max={today} required />
    <p className="text-sm text-muted-foreground">O saldo será compensado na data escolhida, e a entrada voltará a ficar pendente para um novo recebimento.</p>
    {error && <p id="reverse-error" role="alert" className="text-sm text-destructive">{error}</p>}
    <DialogFooter><Button type="button" variant="outline" onClick={onClose}>Voltar</Button><Button type="submit" disabled={busy} aria-busy={busy}>{busy ? "Estornando…" : "Confirmar estorno"}</Button></DialogFooter>
  </form>}</DialogContent></Dialog>;
}

function MaterializeDialog({ item, error, busy, onClose, onSubmit }: { item: Occurrence | null; error: string | null; busy: boolean; onClose: () => void; onSubmit: (month: string) => Promise<void> }) {
  const submit = (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); void onSubmit(String(new FormData(event.currentTarget).get("throughMonth") ?? "")); };
  return <Dialog open={Boolean(item)} onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>Estender série mensal</DialogTitle><DialogDescription>Cria explicitamente as próximas ocorrências. Abrir a página nunca materializa a série automaticamente.</DialogDescription></DialogHeader>{item?.recurrence && <form onSubmit={submit} className="space-y-4"><p className="text-sm text-muted-foreground">Materializada até {item.recurrence.materializedThroughMonth}</p><Field label="Materializar até" name="throughMonth" type="month" min={item.recurrence.materializedThroughMonth} required />{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<DialogFooter><Button type="button" variant="outline" onClick={onClose}>Voltar</Button><Button type="submit" disabled={busy}>{busy ? "Estendendo…" : "Estender série"}</Button></DialogFooter></form>}</DialogContent></Dialog>;
}

function Field({ label, name, type = "text", defaultValue, required, max, min }: { label: string; name: string; type?: string; defaultValue?: string; required?: boolean; max?: string; min?: string }) {
  const id = `field-${name}`;
  return <div><Label htmlFor={id}>{label}</Label><Input id={id} name={name} type={type} defaultValue={defaultValue} required={required} max={max} min={min} /></div>;
}
