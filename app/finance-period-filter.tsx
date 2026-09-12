"use client";

import { useState } from "react";
import { CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { AnalyticsPeriodPreset } from "@/lib/finance-analytics-types";

export type FinancePeriodSelection = {
  period: AnalyticsPeriodPreset;
  from?: string;
  to?: string;
};

const periodOptions: Array<{ value: AnalyticsPeriodPreset; label: string }> = [
  { value: "this_month", label: "Este mês" },
  { value: "previous_month", label: "Mês passado" },
  { value: "last_3_months", label: "Últimos 3 meses" },
  { value: "last_6_months", label: "Últimos 6 meses" },
  { value: "last_12_months", label: "Últimos 12 meses" },
  { value: "custom", label: "Personalizado" },
];

export function FinancePeriodFilter({ value, onChange, disabled = false }: { value: FinancePeriodSelection; onChange: (value: FinancePeriodSelection) => void; disabled?: boolean }) {
  const [draftPeriod, setDraftPeriod] = useState(value.period);
  const [from, setFrom] = useState(value.from ?? "");
  const [to, setTo] = useState(value.to ?? "");
  const [error, setError] = useState("");

  const selectPeriod = (period: AnalyticsPeriodPreset) => {
    setDraftPeriod(period);
    setError("");
    if (period !== "custom") onChange({ period });
  };

  const applyCustomPeriod = () => {
    if (!from || !to) {
      setError("Informe as duas datas.");
      return;
    }
    if (from > to) {
      setError("A data inicial deve ser anterior à final.");
      return;
    }
    setError("");
    onChange({ period: "custom", from, to });
  };

  return (
    <div className="rounded-2xl border border-[#d9e3df] bg-white p-3 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1 sm:min-w-52">
          <Label htmlFor="dashboard-period" className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.1em] text-[#6f827d]">
            <CalendarDays className="h-4 w-4" /> Período
          </Label>
          <Select value={draftPeriod} onValueChange={(next) => selectPeriod(next as AnalyticsPeriodPreset)} disabled={disabled}>
            <SelectTrigger id="dashboard-period" className="h-11 w-full rounded-xl bg-[#f8faf9]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {periodOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        {draftPeriod === "custom" && (
          <div className="grid min-w-0 flex-[2] gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <div>
              <Label htmlFor="dashboard-period-from" className="text-xs text-[#6f827d]">Data inicial</Label>
              <Input id="dashboard-period-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} disabled={disabled} className="mt-2 h-11 rounded-xl" />
            </div>
            <div>
              <Label htmlFor="dashboard-period-to" className="text-xs text-[#6f827d]">Data final</Label>
              <Input id="dashboard-period-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} disabled={disabled} className="mt-2 h-11 rounded-xl" />
            </div>
            <Button type="button" onClick={applyCustomPeriod} disabled={disabled} className="h-11 rounded-xl">Aplicar</Button>
          </div>
        )}
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-[#a43d32]">{error}</p>}
    </div>
  );
}
