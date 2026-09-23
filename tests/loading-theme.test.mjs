import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Skeleton compartilhado usa token neutro compatível com os dois temas", () => {
  const skeleton = read("../components/ui/skeleton.tsx");
  const styles = read("../app/globals.css");

  assert.match(skeleton, /animate-pulse rounded-md bg-muted/u);
  assert.doesNotMatch(skeleton, /bg-accent/u);
  assert.match(styles, /\.dark \{[^}]*--muted:#142d29/u);
});

test("Dashboard usa Skeleton compartilhado sem blocos claros fixos", () => {
  const dashboard = read("../app/finance-dashboard.tsx");

  assert.match(dashboard, /import \{ Skeleton \} from "@\/components\/ui\/skeleton"/u);
  assert.match(dashboard, /function DashboardSkeleton/u);
  assert.match(dashboard, /<Skeleton key=\{index\} className="h-44 rounded-\[22px\]"/u);
  assert.match(dashboard, /<Skeleton key=\{index\} className="h-20 rounded-2xl"/u);
  assert.doesNotMatch(dashboard, /bg-\[#dfe7e4\]|bg-\[#edf2f0\]/u);
});

test("Relatórios usa Skeleton compartilhado sem cards claros fixos", () => {
  const reports = read("../app/finance-reports.tsx");

  assert.match(reports, /import \{ Skeleton \} from "@\/components\/ui\/skeleton"/u);
  assert.match(reports, /function ReportsSkeleton/u);
  assert.match(reports, /<Skeleton className="h-48 rounded-\[24px\]"/u);
  assert.match(reports, /<Skeleton className="h-96 rounded-\[24px\]"/u);
  assert.doesNotMatch(reports, /bg-\[#dfe7e4\]/u);
});

test("tela inicial de carregamento usa tokens de fundo e texto", () => {
  const financeApp = read("../app/finance-app.tsx");

  assert.match(financeApp, /function LoadingScreen\(\).*bg-background/u);
  assert.match(financeApp, /text-muted-foreground/u);
  assert.doesNotMatch(financeApp, /LoadingScreen\(\).*bg-\[#f4f6f5\]/u);
});
