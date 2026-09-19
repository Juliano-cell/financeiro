"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { buildOnboardingPayload, createOnboardingAttemptManager, friendlyOnboardingError, nextOriginalInstallments, referenceMonthOptions, validateInstallmentDraft } from "@/lib/card-onboarding-ui-rules.mjs";

type Category = { id: string; name: string; type: "income" | "expense" | "both"; isActive: boolean; subcategories: { id: string; name: string; categoryId: string; isActive?: boolean }[] };
type Card = { id: string; name: string };
type InstallmentDraft = { id: string; description: string; originalTotal: string; originalInstallmentCount: string; currentInstallmentNumber: string; installmentAmount: string; originalPurchaseDate: string; categoryId: string; subcategoryId: string; notes: string };
type Eligibility = "loading" | "eligible" | "ineligible" | "error";
type Success = { declaredCurrentInvoiceTotalCents: number; openingBalanceCents: number; importedPurchaseCount: number; importedInstallmentCount: number };

const money = (cents: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
const newInstallment = (): InstallmentDraft => ({ id: crypto.randomUUID(), description: "", originalTotal: "", originalInstallmentCount: "", currentInstallmentNumber: "", installmentAmount: "", originalPurchaseDate: "", categoryId: "", subcategoryId: "", notes: "" });

async function onboardingRequest(url: string, init?: RequestInit) {
  const response = await fetch(url, { cache: "no-store", ...init });
  let body: Record<string, unknown> = {};
  try { body = await response.json() as Record<string, unknown>; } catch { /* resposta inválida é tratada abaixo */ }
  if (!response.ok) throw Object.assign(new Error(typeof body.error === "string" ? body.error : ""), { status: response.status });
  return body;
}

export function CardOnboardingAction({ card, categories, onChanged }: { card: Card; categories: Category[]; onChanged: () => Promise<void> }) {
  const months = useMemo(() => referenceMonthOptions(), []);
  const [eligibility, setEligibility] = useState<Eligibility>("loading");
  const [eligibilityVersion, setEligibilityVersion] = useState(0);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"invoice" | "installments" | "review" | "success">("invoice");
  const [referenceMonth, setReferenceMonth] = useState(months[0]?.value ?? "");
  const [invoiceTotal, setInvoiceTotal] = useState("");
  const [hasInstallments, setHasInstallments] = useState<boolean | null>(null);
  const [installments, setInstallments] = useState<InstallmentDraft[]>([]);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<Success | null>(null);
  const submittingRef = useRef(false);
  const attempt = useRef(createOnboardingAttemptManager());
  const expenseCategories = categories.filter((item) => item.isActive && (item.type === "expense" || item.type === "both"));

  useEffect(() => {
    const controller = new AbortController();
    onboardingRequest(`/api/finance/card-onboarding?cardId=${encodeURIComponent(card.id)}`, { signal: controller.signal })
      .then((body) => setEligibility(body.eligible === true ? "eligible" : "ineligible"))
      .catch((caught) => { if (caught?.name !== "AbortError") setEligibility("error"); });
    return () => controller.abort();
  }, [card.id, eligibilityVersion]);

  const reset = () => {
    setStep("invoice"); setReferenceMonth(months[0]?.value ?? ""); setInvoiceTotal(""); setHasInstallments(null); setInstallments([]); setError(""); setSuccess(null); setSubmitting(false); submittingRef.current = false; attempt.current.clear();
  };
  const close = () => { setOpen(false); reset(); };
  const updateInstallment = (id: string, changes: Partial<InstallmentDraft>) => setInstallments((current) => current.map((item) => item.id === id ? { ...item, ...changes } : item));
  const draft = { cardId: card.id, referenceMonth, invoiceTotal, hasInstallments: hasInstallments === true, installments };
  const parsed = buildOnboardingPayload(draft);

  const continueFromInvoice = () => {
    if (!referenceMonth || !months.some((item) => item.value === referenceMonth)) { setError("Selecione uma competência disponível."); return; }
    if (!buildOnboardingPayload({ ...draft, hasInstallments: false, installments: [] }).valid) { setError("Informe um total de fatura válido."); return; }
    if (hasInstallments === null) { setError("Informe se existem compras parceladas em andamento."); return; }
    setError("");
    if (hasInstallments) { if (!installments.length) setInstallments([newInstallment()]); setStep("installments"); } else setStep("review");
  };
  const continueFromInstallments = () => {
    const result = buildOnboardingPayload(draft);
    if (!result.valid) { setError(result.error ?? "Revise os dados dos parcelamentos."); return; }
    setError(""); setStep("review");
  };
  const confirm = async () => {
    if (submittingRef.current) return;
    const result = buildOnboardingPayload(draft);
    if (!result.valid || !result.payload) { setError(result.error ?? "Revise os dados informados."); return; }
    submittingRef.current = true; setSubmitting(true); setError("");
    const idempotencyKey = attempt.current.keyFor(result.payload);
    try {
      const body = await onboardingRequest("/api/finance/card-onboarding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...result.payload, idempotencyKey }) });
      const outcome = { declaredCurrentInvoiceTotalCents: Number(body.declaredCurrentInvoiceTotalCents), openingBalanceCents: Number(body.openingBalanceCents), importedPurchaseCount: Number(body.importedPurchaseCount), importedInstallmentCount: Number(body.importedInstallmentCount) };
      if (Object.values(outcome).some((value) => !Number.isSafeInteger(value) || value < 0)) throw Object.assign(new Error("Resposta financeira inválida."), { status: 500 });
      attempt.current.clear(); setSuccess(outcome); setStep("success"); setEligibility("ineligible");
      try { await onChanged(); } catch { setError("A configuração foi concluída, mas a tela não pôde ser atualizada. Recarregue a página."); }
    } catch (caught) {
      const status = typeof caught === "object" && caught && "status" in caught ? Number(caught.status) : 500;
      setError(friendlyOnboardingError(status, caught instanceof Error ? caught.message : ""));
      if (status === 409 || status === 404) { setEligibility("loading"); setEligibilityVersion((value) => value + 1); }
    } finally { submittingRef.current = false; setSubmitting(false); }
  };

  if (eligibility === "loading" && !open) return <span className="text-xs text-[#71837e]" role="status">Verificando configuração inicial…</span>;
  if (eligibility === "error" && !open) return <Button variant="outline" size="sm" onClick={() => { setEligibility("loading"); setEligibilityVersion((value) => value + 1); }}>Tentar verificar configuração</Button>;
  if (eligibility !== "eligible" && !open) return null;

  return <>
    <div className="basis-full rounded-xl border border-[#d8e1de] bg-[#f7faf9] p-3 text-sm sm:basis-auto sm:max-w-md">
      <p className="text-[#52645f]">Use esta opção se este cartão já possuía fatura ou compras parceladas antes de você começar a usar o sistema.</p>
      <Button className="mt-3 w-full sm:w-auto" size="sm" onClick={() => { reset(); setOpen(true); }}>Configurar situação atual</Button>
    </div>
    <Dialog open={open} onOpenChange={(value) => { if (!value && !submitting) close(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" aria-describedby="card-onboarding-description">
        <DialogHeader><DialogTitle>Configurar situação atual · {card.name}</DialogTitle><DialogDescription id="card-onboarding-description">Configuração inicial para trazer a fatura e os parcelamentos que já existiam.</DialogDescription></DialogHeader>

        {step === "invoice" && <div className="grid gap-5">
          <div className="grid gap-2"><Label htmlFor="onboarding-month">Competência da fatura</Label><select id="onboarding-month" className="min-h-11 rounded-md border px-3 capitalize" value={referenceMonth} onChange={(event) => setReferenceMonth(event.target.value)}>{months.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></div>
          <div className="grid gap-2"><Label htmlFor="onboarding-total">Valor total atual da fatura</Label><Input id="onboarding-total" inputMode="decimal" placeholder="1.400,00" value={invoiceTotal} onChange={(event) => setInvoiceTotal(event.target.value)} aria-describedby="onboarding-total-help" /><p id="onboarding-total-help" className="text-xs text-[#71837e]">Digite o total em reais, incluindo compras anteriores ao sistema.</p></div>
          <fieldset className="grid gap-2"><legend className="font-medium">Essa fatura possui compras parceladas que continuarão nos próximos meses?</legend><label className="flex min-h-11 items-center gap-2 rounded-md border px-3"><input type="radio" name="has-installments" checked={hasInstallments === true} onChange={() => setHasInstallments(true)} /> Sim</label><label className="flex min-h-11 items-center gap-2 rounded-md border px-3"><input type="radio" name="has-installments" checked={hasInstallments === false} onChange={() => setHasInstallments(false)} /> Não</label></fieldset>
          <DialogFooter><Button variant="outline" onClick={close}>Cancelar</Button><Button onClick={continueFromInvoice}>Continuar</Button></DialogFooter>
        </div>}

        {step === "installments" && <div className="grid gap-4">
          <p className="text-sm text-[#52645f]">Informe apenas os parcelamentos que já existem e continuam a partir desta fatura.</p>
          {installments.map((installment, index) => {
            const validation = validateInstallmentDraft(installment);
            const subcategories = expenseCategories.find((item) => item.id === installment.categoryId)?.subcategories.filter((item) => item.isActive !== false) ?? [];
            return <fieldset key={installment.id} className="grid gap-4 rounded-xl border p-4 sm:grid-cols-2"><legend className="px-2 font-semibold">Parcelamento {index + 1}</legend>
              <div className="sm:col-span-2"><TextField id={`${installment.id}-description`} label="Descrição" value={installment.description} onChange={(value) => updateInstallment(installment.id, { description: value })} error={validation.errors.description} /></div>
              <TextField id={`${installment.id}-original-total`} label="Valor original da compra" value={installment.originalTotal} onChange={(value) => updateInstallment(installment.id, { originalTotal: value })} inputMode="decimal" placeholder="600,00" error={validation.errors.originalTotal} />
              <TextField id={`${installment.id}-amount`} label="Valor da parcela" value={installment.installmentAmount} onChange={(value) => updateInstallment(installment.id, { installmentAmount: value })} inputMode="decimal" placeholder="60,00" error={validation.errors.installmentAmount} />
              <TextField id={`${installment.id}-count`} label="Total original de parcelas" value={installment.originalInstallmentCount} onChange={(value) => updateInstallment(installment.id, { originalInstallmentCount: value })} inputMode="numeric" error={validation.errors.originalInstallmentCount} />
              <TextField id={`${installment.id}-current`} label="Parcela atual" value={installment.currentInstallmentNumber} onChange={(value) => updateInstallment(installment.id, { currentInstallmentNumber: value })} inputMode="numeric" error={validation.errors.currentInstallmentNumber} />
              <TextField id={`${installment.id}-date`} label="Data original da compra (opcional)" value={installment.originalPurchaseDate} onChange={(value) => updateInstallment(installment.id, { originalPurchaseDate: value })} type="date" error={validation.errors.originalPurchaseDate} />
              <div className="grid gap-2"><Label htmlFor={`${installment.id}-category`}>Categoria (opcional)</Label><select id={`${installment.id}-category`} className="min-h-11 rounded-md border px-3" value={installment.categoryId} onChange={(event) => updateInstallment(installment.id, { categoryId: event.target.value, subcategoryId: "" })}><option value="">Sem categoria</option>{expenseCategories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
              {subcategories.length > 0 && <div className="grid gap-2"><Label htmlFor={`${installment.id}-subcategory`}>Subcategoria (opcional)</Label><select id={`${installment.id}-subcategory`} className="min-h-11 rounded-md border px-3" value={installment.subcategoryId} onChange={(event) => updateInstallment(installment.id, { subcategoryId: event.target.value })}><option value="">Sem subcategoria</option>{subcategories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>}
              <div className="sm:col-span-2"><TextField id={`${installment.id}-notes`} label="Observação (opcional)" value={installment.notes} onChange={(value) => updateInstallment(installment.id, { notes: value })} error={validation.errors.notes} /></div>
              {validation.valid && <p className="text-sm text-[#52645f] sm:col-span-2">Parcela {validation.currentInstallmentNumber} de {validation.originalInstallmentCount}</p>}
              <Button className="sm:col-span-2 sm:justify-self-start" type="button" variant="outline" onClick={() => setInstallments((current) => current.filter((item) => item.id !== installment.id))}><Trash2 className="h-4 w-4" /> Remover parcelamento</Button>
            </fieldset>;
          })}
          <Button type="button" variant="outline" onClick={() => setInstallments((current) => [...current, newInstallment()])}><Plus className="h-4 w-4" /> Adicionar parcelamento</Button>
          <DialogFooter><Button variant="outline" onClick={() => setStep("invoice")}>Voltar</Button><Button onClick={continueFromInstallments}>Revisar</Button></DialogFooter>
        </div>}

        {step === "review" && parsed.valid && parsed.preview && parsed.payload && <div className="grid gap-5">
          <div className="grid gap-2 rounded-xl border bg-[#f7faf9] p-4"><ReviewLine label="Fatura atual" value={money(parsed.preview.declaredCurrentInvoiceTotalCents)} /><ReviewLine label="Parcelamentos informados nesta fatura" value={money(parsed.preview.currentInstallmentsCents)} /><ReviewLine label="Saldo anterior à implantação" value={money(parsed.preview.openingBalanceCents)} /></div>
          {parsed.preview.openingBalanceCents < 0 && <p className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800" role="alert">As parcelas atuais superam o total informado da fatura.</p>}
          {parsed.payload.existingInstallments.length > 0 && <div className="grid gap-3"><h3 className="font-semibold">Parcelamentos</h3>{parsed.payload.existingInstallments.map((item, index) => <div key={`${item.description}-${index}`} className="rounded-xl border p-4"><p className="font-medium">{item.description}</p><p className="text-sm">Parcela {item.currentInstallmentNumber} de {item.originalInstallmentCount} · {money(Number(item.installmentAmountCents))} por parcela</p>{nextOriginalInstallments(Number(item.currentInstallmentNumber), Number(item.originalInstallmentCount)).length > 0 && <p className="mt-1 text-xs text-[#71837e]">Próximas: {nextOriginalInstallments(Number(item.currentInstallmentNumber), Number(item.originalInstallmentCount)).map((value) => `${value}/${item.originalInstallmentCount}`).join(", ")}</p>}</div>)}</div>}
          <p className="text-sm text-[#52645f]">Saldo anterior à implantação é a parte da fatura atual que já existia antes do sistema e não foi detalhada como compra parcelada. Ele compõe a fatura, mas não vira compra fictícia, renda ou nova despesa categorizada. Esta é somente uma prévia; o backend continua sendo a autoridade financeira final.</p>
          <DialogFooter><Button variant="outline" disabled={submitting} onClick={() => setStep(hasInstallments ? "installments" : "invoice")}>Alterar</Button><Button disabled={submitting || parsed.preview.openingBalanceCents < 0} onClick={confirm}>{submitting ? "Configurando…" : "Confirmar situação atual"}</Button></DialogFooter>
        </div>}

        {step === "success" && success && <div className="grid gap-5"><div className="rounded-xl border border-emerald-300 bg-emerald-50 p-4" role="status"><p className="font-semibold text-emerald-900">Situação atual configurada com sucesso.</p></div><div className="grid gap-2"><ReviewLine label="Total da fatura" value={money(success.declaredCurrentInvoiceTotalCents)} /><ReviewLine label="Saldo anterior" value={money(success.openingBalanceCents)} /><ReviewLine label="Compras importadas" value={String(success.importedPurchaseCount)} /><ReviewLine label="Parcelas importadas" value={String(success.importedInstallmentCount)} /></div><DialogFooter><Button onClick={close}>Concluir</Button></DialogFooter></div>}
        {error && <p className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</p>}
      </DialogContent>
    </Dialog>
  </>;
}

function TextField({ id, label, value, onChange, error, ...props }: { id: string; label: string; value: string; onChange: (value: string) => void; error?: string; type?: string; inputMode?: "decimal" | "numeric"; placeholder?: string }) {
  const errorId = `${id}-error`;
  return <div className="grid gap-2"><Label htmlFor={id}>{label}</Label><Input id={id} value={value} onChange={(event) => onChange(event.target.value)} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} {...props} />{error && <p id={errorId} className="text-xs text-red-700">{error}</p>}</div>;
}

function ReviewLine({ label, value }: { label: string; value: string }) { return <div className="flex flex-wrap justify-between gap-2 text-sm"><span className="text-[#52645f]">{label}</span><strong>{value}</strong></div>; }
