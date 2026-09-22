"use client";

import { useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { buildExistingInstallmentPayload, createOnboardingAttemptRegistry, friendlyOnboardingError, nextOriginalInstallments, parseExistingInstallmentSuccessResponse, referenceMonthOptions } from "@/lib/card-onboarding-ui-rules.mjs";

type Category = { id: string; name: string; type: "income" | "expense" | "both"; isActive: boolean; subcategories: { id: string; name: string; categoryId: string; isActive?: boolean }[] };
type Card = { id: string; name: string };
type Draft = { description: string; installmentAmount: string; originalInstallmentCount: string; firstOriginalInstallmentNumber: string; firstReferenceMonth: string; categoryId: string; subcategoryId: string; originalTotal: string; originalPurchaseDate: string; notes: string };

const attempts = createOnboardingAttemptRegistry();
const money = (cents: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
const emptyDraft = (referenceMonth: string): Draft => ({ description: "", installmentAmount: "", originalInstallmentCount: "", firstOriginalInstallmentNumber: "", firstReferenceMonth: referenceMonth, categoryId: "", subcategoryId: "", originalTotal: "", originalPurchaseDate: "", notes: "" });

async function request(payload: Record<string, unknown>) {
  const response = await fetch("/api/finance/card-existing-installments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  let body: Record<string, unknown> = {};
  try { body = await response.json() as Record<string, unknown>; } catch { /* handled below */ }
  if (!response.ok) throw Object.assign(new Error(typeof body.error === "string" ? body.error : ""), { status: response.status });
  return body;
}

export function CardExistingInstallmentAction({ card, categories, onChanged }: { card: Card; categories: Category[]; onChanged: () => Promise<void> }) {
  const months = useMemo(() => referenceMonthOptions(), []);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"form" | "review" | "success">("form");
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(months[0]?.value ?? ""));
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [createdCount, setCreatedCount] = useState(0);
  const submittingRef = useRef(false);
  const attempt = attempts.forCard(card.id);
  const expenseCategories = categories.filter((item) => item.isActive && (item.type === "expense" || item.type === "both"));
  const subcategories = expenseCategories.find((item) => item.id === draft.categoryId)?.subcategories.filter((item) => item.isActive !== false) ?? [];
  const parsed = buildExistingInstallmentPayload({ cardId: card.id, ...draft });

  const update = (changes: Partial<Draft>) => setDraft((current) => ({ ...current, ...changes }));
  const reset = () => {
    setStep("form"); setDraft(emptyDraft(months[0]?.value ?? "")); setError(""); setSubmitting(false); setCreatedCount(0); submittingRef.current = false; attempt.clearPrepared();
  };
  const close = () => { setOpen(false); reset(); };
  const review = () => {
    if (!parsed.valid) { setError(parsed.error ?? "Revise os dados informados."); return; }
    setError(""); setStep("review");
  };
  const confirm = async () => {
    if (submittingRef.current || !parsed.valid || !parsed.payload) return;
    const prepared = attempt.prepare(parsed.payload);
    if (prepared.kind === "requires_revalidation") {
      setError("Existe uma tentativa anterior com resultado indefinido. Para evitar duplicidade, repita os mesmos dados enviados anteriormente.");
      return;
    }
    submittingRef.current = true; setSubmitting(true); setError("");
    try {
      const body = await request({ ...parsed.payload, idempotencyKey: prepared.key });
      const result = parseExistingInstallmentSuccessResponse(body, card.id);
      if (!result) throw Object.assign(new Error("Resposta financeira inválida."), { status: 502 });
      attempt.resolve(); setCreatedCount(result.importedInstallmentCount); setStep("success");
      try { await onChanged(); } catch { setError("O parcelamento foi criado, mas a tela não pôde ser atualizada. Recarregue a página."); }
    } catch (caught) {
      const status = typeof caught === "object" && caught && "status" in caught ? Number(caught.status) : 500;
      setError(friendlyOnboardingError(status, caught instanceof Error ? caught.message : ""));
      if (status >= 500) attempt.markAmbiguous(parsed.payload, prepared.key);
      else attempt.resolve();
    } finally { submittingRef.current = false; setSubmitting(false); }
  };

  return <>
    <Button type="button" variant="outline" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Adicionar parcelamento existente</Button>
    <Dialog open={open} onOpenChange={(value) => { if (!value && !submitting) close(); else if (value) setOpen(true); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" aria-describedby="existing-installment-description">
        <DialogHeader><DialogTitle>Adicionar parcelamento existente · {card.name}</DialogTitle><DialogDescription id="existing-installment-description">Cadastre somente as parcelas que ainda precisam ser acompanhadas.</DialogDescription></DialogHeader>

        {step === "form" && <div className="grid gap-4 sm:grid-cols-2">
          <TextField id="existing-description" label="Descrição" value={draft.description} onChange={(value) => update({ description: value })} />
          <TextField id="existing-installment-amount" label="Valor da parcela (R$)" value={draft.installmentAmount} onChange={(value) => update({ installmentAmount: value })} inputMode="decimal" />
          <TextField id="existing-total-count" label="Quantidade original de parcelas" value={draft.originalInstallmentCount} onChange={(value) => update({ originalInstallmentCount: value })} type="number" min="1" max="120" />
          <TextField id="existing-first-number" label="Primeira parcela ainda acompanhada" value={draft.firstOriginalInstallmentNumber} onChange={(value) => update({ firstOriginalInstallmentNumber: value })} type="number" min="1" max="120" />
          <div className="grid gap-2"><Label htmlFor="existing-reference-month">Competência da primeira parcela</Label><select id="existing-reference-month" className="min-h-11 rounded-md border px-3 capitalize" value={draft.firstReferenceMonth} onChange={(event) => update({ firstReferenceMonth: event.target.value })}>{months.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></div>
          <TextField id="existing-original-total" label="Total original (R$) · opcional" value={draft.originalTotal} onChange={(value) => update({ originalTotal: value })} inputMode="decimal" />
          <TextField id="existing-original-date" label="Data original · opcional" value={draft.originalPurchaseDate} onChange={(value) => update({ originalPurchaseDate: value })} type="date" />
          <div className="grid gap-2"><Label htmlFor="existing-category">Categoria · opcional</Label><select id="existing-category" className="min-h-11 rounded-md border px-3" value={draft.categoryId} onChange={(event) => update({ categoryId: event.target.value, subcategoryId: "" })}><option value="">Sem categoria</option>{expenseCategories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
          {subcategories.length > 0 && <div className="grid gap-2"><Label htmlFor="existing-subcategory">Subcategoria</Label><select id="existing-subcategory" className="min-h-11 rounded-md border px-3" value={draft.subcategoryId} onChange={(event) => update({ subcategoryId: event.target.value })}><option value="">Sem subcategoria</option>{subcategories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>}
          <div className="sm:col-span-2"><TextField id="existing-notes" label="Observação · opcional" value={draft.notes} onChange={(value) => update({ notes: value })} /></div>
          <p className="sm:col-span-2 text-sm text-[#52645f]">Nenhuma parcela anterior à informada será criada. Esta operação não movimenta conta nem registra pagamento.</p>
          <DialogFooter className="sm:col-span-2"><Button variant="outline" onClick={close}>Cancelar</Button><Button onClick={review}>Revisar</Button></DialogFooter>
        </div>}

        {step === "review" && parsed.valid && parsed.payload && parsed.preview && <div className="grid gap-5">
          <div className="rounded-xl border bg-[#f7faf9] p-4"><p className="font-semibold">{parsed.payload.description}</p><p className="mt-1 text-sm">Parcela {parsed.payload.firstOriginalInstallmentNumber}/{parsed.payload.originalInstallmentCount} · {money(Number(parsed.payload.installmentAmountCents))}</p><p className="mt-1 text-sm">Serão criadas {parsed.preview.remainingInstallmentCount} parcelas, totalizando {money(parsed.preview.remainingTotalCents)}.</p>{nextOriginalInstallments(parsed.payload.firstOriginalInstallmentNumber, parsed.payload.originalInstallmentCount).length > 0 && <p className="mt-1 text-xs text-[#71837e]">Próximas: {nextOriginalInstallments(parsed.payload.firstOriginalInstallmentNumber, parsed.payload.originalInstallmentCount).map((value) => `${value}/${parsed.payload.originalInstallmentCount}`).join(", ")}</p>}</div>
          <p className="text-sm text-[#52645f]">A primeira parcela entrará em {parsed.payload.firstReferenceMonth.split("-").reverse().join("/")}. Faturas existentes serão reutilizadas; as demais serão criadas somente quando necessárias.</p>
          <DialogFooter><Button variant="outline" disabled={submitting} onClick={() => setStep("form")}>Alterar</Button><Button disabled={submitting} onClick={confirm}>{submitting ? "Adicionando…" : "Confirmar parcelamento"}</Button></DialogFooter>
        </div>}

        {step === "success" && <div className="grid gap-5"><div className="rounded-xl border border-emerald-300 bg-emerald-50 p-4" role="status"><p className="font-semibold text-emerald-900">Parcelamento existente adicionado.</p><p className="mt-1 text-sm text-emerald-800">{createdCount} parcelas remanescentes foram registradas.</p></div><DialogFooter><Button onClick={close}>Concluir</Button></DialogFooter></div>}
        {error && <p className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</p>}
      </DialogContent>
    </Dialog>
  </>;
}

function TextField({ id, label, value, onChange, ...props }: { id: string; label: string; value: string; onChange: (value: string) => void; type?: string; inputMode?: "decimal" | "numeric"; min?: string; max?: string }) {
  return <div className="grid gap-2"><Label htmlFor={id}>{label}</Label><Input id={id} value={value} onChange={(event) => onChange(event.target.value)} {...props} /></div>;
}
