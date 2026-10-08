"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, ClipboardCopy, LockKeyhole, MessageSquareText, RefreshCw, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import type { ChatGptFinancialSummaryResponse } from "@/lib/chatgpt-financial-summary-types";
import {
  currentSummaryMonthInSaoPaulo,
  parseSummaryResponse,
  summaryDateLabel,
  summaryMonthLabel,
  summaryMonthOptions,
  summaryTimestampLabel,
} from "@/lib/chatgpt-financial-summary-ui.mjs";

type CopyStatus = "idle" | "copying" | "success" | "error";

class SummaryRequestError extends Error {
  constructor(message: string, readonly sessionExpired = false) {
    super(message);
  }
}

async function fetchFinancialSummary(month: string, signal: AbortSignal): Promise<ChatGptFinancialSummaryResponse> {
  const response = await fetch(`/api/finance/chatgpt-summary?month=${encodeURIComponent(month)}`, {
    method: "GET",
    headers: { accept: "application/json" },
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    if (response.status === 401) throw new SummaryRequestError("Sua sessão expirou. Entre novamente para gerar o resumo.", true);
    throw new SummaryRequestError("Não foi possível gerar o resumo financeiro.");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new SummaryRequestError("Não foi possível gerar o resumo financeiro.");
  }
  return parseSummaryResponse(body, month) as ChatGptFinancialSummaryResponse;
}

export function FinanceChatGptSummary({ valuesHidden }: { valuesHidden: boolean }) {
  const options = useMemo(() => summaryMonthOptions(), []);
  const [selectedMonth, setSelectedMonth] = useState(() => currentSummaryMonthInSaoPaulo());
  const [summary, setSummary] = useState<ChatGptFinancialSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; sessionExpired: boolean } | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [copyStatus, setCopyStatus] = useState<CopyStatus>("idle");
  const requestSequence = useRef(0);

  useEffect(() => {
    const requestId = requestSequence.current + 1;
    requestSequence.current = requestId;
    const controller = new AbortController();
    void fetchFinancialSummary(selectedMonth, controller.signal)
      .then((next) => {
        if (controller.signal.aborted || requestSequence.current !== requestId || next.month !== selectedMonth) return;
        setSummary(next);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || requestSequence.current !== requestId) return;
        const requestError = cause instanceof SummaryRequestError ? cause : new SummaryRequestError("Não foi possível gerar o resumo financeiro.");
        setError({ message: requestError.message, sessionExpired: requestError.sessionExpired });
        setLoading(false);
      });
    return () => controller.abort();
  }, [selectedMonth, retryKey]);

  const validSummary = summary?.month === selectedMonth ? summary : null;
  const hasText = Boolean(validSummary?.summaryText.trim());
  const canCopy = !valuesHidden && !loading && hasText;

  const changeMonth = (month: string) => {
    if (month === selectedMonth) return;
    setSummary(null);
    setError(null);
    setCopyStatus("idle");
    setSelectedMonth(month);
    setLoading(true);
  };

  const retry = () => {
    setSummary(null);
    setError(null);
    setCopyStatus("idle");
    setLoading(true);
    setRetryKey((value) => value + 1);
  };

  const copySummary = async () => {
    if (!canCopy || !validSummary) return;
    setCopyStatus("copying");
    try {
      await navigator.clipboard.writeText(validSummary.summaryText);
      setCopyStatus("success");
      toast.success("Resumo copiado.");
    } catch {
      setCopyStatus("error");
      toast.error("Não foi possível copiar o resumo.");
    }
  };

  return <section className="min-w-0 space-y-6" aria-labelledby="chatgpt-summary-title">
    <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div className="min-w-0">
        <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary" aria-hidden="true"><MessageSquareText /></div>
        <h2 id="chatgpt-summary-title" className="text-3xl font-semibold tracking-[-.04em]">Resumo para o ChatGPT</h2>
        <p className="mt-2 max-w-2xl text-muted-foreground">Gere um retrato financeiro completo para copiar e usar no seu planejamento.</p>
      </div>
      <div className="w-full space-y-2 sm:w-72">
        <Label htmlFor="chatgpt-summary-month">Competência</Label>
        <NativeSelect id="chatgpt-summary-month" value={selectedMonth} onChange={(event) => changeMonth(event.target.value)} className="w-full capitalize" aria-label="Competência do resumo">
          {options.map((option) => <NativeSelectOption key={option.value} value={option.value}>{option.label}</NativeSelectOption>)}
        </NativeSelect>
      </div>
    </header>

    <Alert className="border-primary/30">
      <ShieldAlert />
      <AlertTitle>Dados financeiros privados</AlertTitle>
      <AlertDescription>Revise o conteúdo antes de compartilhar. O sistema não envia este resumo ao ChatGPT automaticamente.</AlertDescription>
    </Alert>

    {loading && <SummarySkeleton month={selectedMonth} />}
    {!loading && error && <SummaryError error={error} onRetry={retry} />}
    {!loading && !error && validSummary && <div className="space-y-4">
      <div className="grid gap-3 rounded-2xl border border-border bg-card p-4 text-sm text-card-foreground sm:grid-cols-3">
        <Metadata label="Competência" value={summaryMonthLabel(validSummary.month)} />
        <Metadata label="Dados considerados até" value={summaryDateLabel(validSummary.asOfDate)} />
        <Metadata label="Gerado em" value={summaryTimestampLabel(validSummary.generatedAt)} />
      </div>

      {valuesHidden ? <PrivacyShield /> : hasText ? <SummaryPreview summary={validSummary} /> : <SummaryEmpty />}

      <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-h-5 text-sm" aria-live="polite">
          {valuesHidden && <span className="text-muted-foreground">Revele os valores financeiros para habilitar a cópia.</span>}
          {!valuesHidden && copyStatus === "success" && <span className="flex items-center gap-1.5 text-primary"><Check className="h-4 w-4" aria-hidden="true" />Resumo copiado com sucesso.</span>}
          {!valuesHidden && copyStatus === "error" && <span className="text-destructive">Falha ao copiar. Tente novamente.</span>}
        </div>
        <Button type="button" onClick={() => void copySummary()} disabled={!canCopy || copyStatus === "copying"} aria-label={valuesHidden ? "Copiar resumo indisponível enquanto os valores estão ocultos" : "Copiar resumo financeiro"}>
          <ClipboardCopy />{copyStatus === "copying" ? "Copiando…" : "Copiar resumo"}
        </Button>
      </div>
    </div>}
  </section>;
}

function Metadata({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-[.08em] text-muted-foreground">{label}</p><p className="mt-1 break-words font-medium capitalize">{value}</p></div>;
}

function SummaryPreview({ summary }: { summary: ChatGptFinancialSummaryResponse }) {
  return <div className="space-y-4">
    {summary.warnings.length > 0 && <div className="space-y-2" aria-label="Avisos do resumo">
      {summary.warnings.map((warning) => <Alert key={`${warning.code}:${warning.message}`}>
        <AlertTriangle />
        <AlertTitle>Aviso</AlertTitle>
        <AlertDescription>{warning.message}</AlertDescription>
      </Alert>)}
    </div>}
    <article className="min-w-0 rounded-3xl border border-border bg-card p-4 text-card-foreground sm:p-6" aria-label="Prévia completa do resumo financeiro">
      <pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap break-words font-sans text-sm leading-6">{summary.summaryText}</pre>
    </article>
  </div>;
}

function PrivacyShield() {
  return <div className="rounded-3xl border border-dashed border-border bg-card p-6 text-card-foreground" role="status">
    <LockKeyhole className="h-6 w-6 text-primary" aria-hidden="true" />
    <h3 className="mt-3 font-semibold">Valores financeiros ocultos</h3>
    <p className="mt-1 max-w-xl text-sm leading-6 text-muted-foreground">O conteúdo do resumo não é exibido nem disponibilizado para cópia enquanto a privacidade estiver ativa. Use o controle de olho no cabeçalho para revelar os valores.</p>
  </div>;
}

function SummaryEmpty() {
  return <div className="rounded-3xl border border-dashed border-border bg-card p-6 text-card-foreground" role="status">
    <MessageSquareText className="h-6 w-6 text-primary" aria-hidden="true" />
    <h3 className="mt-3 font-semibold">Resumo vazio</h3>
    <p className="mt-1 text-sm text-muted-foreground">Não há conteúdo financeiro disponível para esta competência.</p>
  </div>;
}

function SummarySkeleton({ month }: { month: string }) {
  return <div className="space-y-4" aria-busy="true" aria-label={`Carregando resumo de ${summaryMonthLabel(month)}`}>
    <div className="grid gap-3 sm:grid-cols-3">{Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="h-20 rounded-2xl" />)}</div>
    <Skeleton className="h-80 rounded-3xl" />
  </div>;
}

function SummaryError({ error, onRetry }: { error: { message: string; sessionExpired: boolean }; onRetry: () => void }) {
  return <div className="rounded-3xl border border-destructive/40 bg-card p-6 text-card-foreground" role="alert">
    <AlertTriangle className="h-6 w-6 text-destructive" aria-hidden="true" />
    <h3 className="mt-3 font-semibold">{error.sessionExpired ? "Sessão expirada" : "Não foi possível carregar o resumo"}</h3>
    <p className="mt-1 text-sm text-muted-foreground">{error.message}</p>
    <Button type="button" variant="outline" className="mt-4" onClick={onRetry}><RefreshCw />Tentar novamente</Button>
  </div>;
}
