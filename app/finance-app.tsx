"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BarChart3, Bell, CalendarClock, ChevronRight, CircleDollarSign, CreditCard, Home, Landmark, LayoutDashboard, Menu, Pencil, Plus, ReceiptText, Search, Settings2, Sparkles, Tags, Trash2, Users, Wallet, X } from "lucide-react";
import { toast, Toaster } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AdvancedFinanceView, advancedApi, type AdvancedSnapshot, type AdvancedView, MonthNavigator } from "@/app/advanced-finance";
import { FinanceDashboard } from "@/app/finance-dashboard";
import { FinanceReports } from "@/app/finance-reports";
import { SubcategoryManager } from "@/app/subcategory-manager";
import type { DashboardNavigationIntent } from "@/lib/dashboard-navigation";
import { activeSubcategories, changeTransactionCategory, changeTransactionType, transactionClassificationError } from "@/lib/finance-ui-rules.mjs";

type View = "dashboard" | "reports" | "transactions" | "accounts" | "categories" | "family" | AdvancedView;
type Account = { id: string; name: string; type: "bank" | "cash" | "savings" | "wallet" | "other"; initialBalanceCents: number; currentBalanceCents: number; isActive: boolean };
type Subcategory = { id: string; name: string; categoryId: string; isActive?: boolean; isInUse?: boolean };
type Category = { id: string; name: string; type: "income" | "expense" | "both"; color: string; isActive: boolean; subcategories: Subcategory[] };
type Transaction = { id: string; type: "income" | "expense"; amountCents: number; description: string; categoryId: string | null; subcategoryId: string | null; transactionDate: string; transactionTime: string | null; responsibleUserId: string; accountId: string; paymentMethod: string | null; status: "confirmed" | "pending" | "cancelled"; origin: "dashboard" | "telegram"; notes: string | null; accountName: string | null; categoryName: string | null; responsibleName: string | null };
type Member = { id: string; userId: string | null; invitedEmail: string | null; role: "owner" | "member"; status: "active" | "invited" | "inactive"; name: string | null; email: string | null };
type Snapshot = { setupRequired: boolean; user: { id: string; name: string; email: string }; household?: { id: string; name: string }; membership?: { role: "owner" | "member" }; members?: Member[]; accounts?: Account[]; categories?: Category[]; transactions?: Transaction[]; summary?: { availableCents: number; incomeCents: number; expenseCents: number; pendingBillsCents: number; projectedCents: number }; cashflow?: Array<{ date: string; income: number; expense: number }> };
const advancedViews: AdvancedView[] = ["cards", "installments", "bills", "simulator", "settings"];

declare global { interface Document { modelContext?: { registerTool(tool: { name: string; title?: string; description: string; inputSchema: object; annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean }; execute(input: unknown): unknown | Promise<unknown> }, options?: { signal?: AbortSignal }): void | Promise<void> } } }

const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const shortDate = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", timeZone: "UTC" });
const fullToday = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long" }).format(new Date());
const brl = (cents: number) => currency.format(cents / 100);
const accountType: Record<Account["type"], string> = { bank: "Conta bancária", cash: "Dinheiro", savings: "Caixinha", wallet: "Carteira", other: "Outra" };
const statusLabel = { confirmed: "Confirmado", pending: "Pendente", cancelled: "Cancelado" } as const;

async function api(body?: Record<string, unknown>) {
  const response = await fetch("/api/finance", body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const data = await response.json() as { error?: string } & Record<string, unknown>;
  if (!response.ok) throw new Error(data.error || "Não foi possível concluir a operação.");
  return data;
}

async function signOut() {
  const response = await fetch("/api/auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "logout" }) });
  if (!response.ok) throw new Error("Não foi possível encerrar a sessão.");
  window.location.assign("/");
}

export function FinanceApp() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>("dashboard");
  const [selectedMonth, setSelectedMonth] = useState(new Date().toISOString().slice(0, 7));
  const [advanced, setAdvanced] = useState<AdvancedSnapshot | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [transactionOpen, setTransactionOpen] = useState(false);
  const [transactionDialogSession, setTransactionDialogSession] = useState(0);
  const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [reportRevision, setReportRevision] = useState(0);
  const [dashboardNavigationIntent, setDashboardNavigationIntent] = useState<DashboardNavigationIntent | null>(null);
  const advancedRequestId = useRef(0);
  const mounted = useRef(false);
  const needsAdvanced = advancedViews.includes(view as AdvancedView) || transactionOpen;
  const setupComplete = Boolean(data && !data.setupRequired);

  const load = useCallback(async () => {
    try { setData(await api() as unknown as Snapshot); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Falha ao carregar os dados."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      advancedRequestId.current += 1;
    };
  }, []);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);
  const loadAdvanced = useCallback(async () => {
    const requestId = advancedRequestId.current + 1;
    advancedRequestId.current = requestId;
    try {
      const snapshot = await advancedApi(undefined, selectedMonth) as unknown as AdvancedSnapshot;
      if (mounted.current && requestId === advancedRequestId.current) setAdvanced(snapshot);
    } catch (error) {
      if (!mounted.current || requestId !== advancedRequestId.current) return;
      toast.error(error instanceof Error ? error.message : "Falha ao carregar o planejamento.");
    }
  }, [selectedMonth]);
  useEffect(() => { if (setupComplete && needsAdvanced) void Promise.resolve().then(loadAdvanced); }, [loadAdvanced, needsAdvanced, setupComplete]);
  const refresh = useCallback(async () => { if (needsAdvanced) await Promise.all([load(), loadAdvanced()]); else await load(); }, [load, loadAdvanced, needsAdvanced]);
  const consumeDashboardNavigationIntent = useCallback(() => setDashboardNavigationIntent(null), []);

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    try {
      void Promise.resolve(context.registerTool({
        name: "create_financial_transaction", title: "Registrar movimentação", description: "Registra uma entrada ou saída confirmada na conta financeira selecionada e atualiza o painel.",
        inputSchema: { type: "object", properties: { type: { type: "string", enum: ["income", "expense"] }, amountCents: { type: "integer", minimum: 1 }, description: { type: "string", minLength: 1 }, accountId: { type: "string" }, categoryId: { type: ["string", "null"] }, subcategoryId: { type: ["string", "null"] }, transactionDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } }, required: ["type", "amountCents", "description", "accountId", "transactionDate"], additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        async execute(input) { const value = input as Record<string, unknown>; await api({ action: "create_transaction", ...value, categoryId: value.categoryId ?? null, subcategoryId: value.subcategoryId ?? null, transactionTime: null, paymentMethod: null, status: "confirmed", notes: null }); await load(); return { status: "confirmed", description: value.description, amountCents: value.amountCents }; }
      }, { signal: lifecycle.signal })).catch(() => undefined);
    } catch { /* WebMCP is optional in unsupported browsers. */ }
    return () => lifecycle.abort();
  }, [load]);

  if (loading) return <LoadingScreen />;
  if (!data) return <ErrorScreen onRetry={load} />;
  if (data.setupRequired) return <HouseholdSetup user={data.user} onDone={load} />;
  const accounts = data.accounts ?? [], categories = data.categories ?? [], transactions = data.transactions ?? [];

  const openTransaction = (item?: Transaction) => { if (!item && !accounts.some((account) => account.isActive)) { toast.info("Cadastre uma conta antes do primeiro lançamento."); setView("accounts"); return; } setEditingTransaction(item ?? null); setTransactionDialogSession((value) => value + 1); setTransactionOpen(true); };
  const openReportTransaction = async (transactionId: string) => {
    const result = await api({ action: "get_transaction", id: transactionId }) as { transaction?: Transaction; editable?: boolean };
    if (!result.transaction) throw new Error("Movimentação não encontrada.");
    if (!result.editable) return false;
    setEditingTransaction(result.transaction);
    setTransactionDialogSession((value) => value + 1);
    setTransactionOpen(true);
    return true;
  };
  const navigate = (next: View) => { if (next !== "reports") setDashboardNavigationIntent(null); setView(next); setMobileOpen(false); };
  const navigateFromDashboard = (intent: DashboardNavigationIntent) => {
    if (intent.target === "accounts") { setDashboardNavigationIntent(null); navigate("accounts"); return; }
    setDashboardNavigationIntent(intent);
    navigate("reports");
  };
  const title = { dashboard: "Visão geral", reports: "Relatórios", transactions: "Movimentações", accounts: "Contas e carteiras", categories: "Categorias", family: "Família", cards: "Cartões", installments: "Parcelas", bills: "Contas e vencimentos", simulator: "Simulador", settings: "Configurações" }[view];

  return (
    <main className="min-h-screen bg-[#f4f6f5] text-[#132b27]">
      <Toaster richColors position="top-right" />
      <Sidebar current={view} onNavigate={navigate} user={data.user} family={data.household?.name ?? "Nossa Casa"} mobileOpen={mobileOpen} onClose={() => setMobileOpen(false)} />
      <section className="pb-20 lg:pl-[248px] lg:pb-0">
        <header className="sticky top-0 z-20 flex min-h-[72px] items-center justify-between border-b border-[#dce4e1] bg-[#f4f6f5]/92 px-4 py-3 backdrop-blur md:px-8">
          <div className="flex min-w-0 items-center gap-2"><button className="rounded-xl p-2 lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Abrir menu"><Menu className="h-5 w-5" /></button><div className="min-w-0"><p className="truncate text-xs font-semibold uppercase tracking-[0.12em] text-[#6c817c]">{fullToday}</p><h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1></div></div>
          <div className="flex items-center gap-2"><button onClick={() => view === "transactions" ? undefined : navigate("transactions")} className="hidden rounded-xl border border-[#d9e2df] bg-white p-2.5 sm:block" aria-label="Pesquisar movimentações"><Search className="h-4 w-4" /></button><button onClick={() => toast.info("Os alertas financeiros serão ativados na Fase 4.")} className="hidden rounded-xl border border-[#d9e2df] bg-white p-2.5 sm:block" aria-label="Notificações"><Bell className="h-4 w-4" /></button><Button onClick={() => openTransaction()} className="rounded-xl bg-[#0d2925] text-white hover:bg-[#173c35]"><Plus className="h-4 w-4" /><span className="hidden sm:inline">Novo lançamento</span><span className="sm:hidden">Novo</span></Button></div>
        </header>
        <div className="mx-auto max-w-[1460px] p-4 md:p-8">
          {(view === "transactions" || advancedViews.includes(view as AdvancedView)) && <div className="mb-6 flex justify-end"><MonthNavigator month={selectedMonth} onChange={setSelectedMonth} /></div>}
          {view === "dashboard" && <FinanceDashboard onNavigate={navigateFromDashboard} />}
          {view === "reports" && <FinanceReports accounts={accounts} categories={categories} members={data.members ?? []} refreshKey={reportRevision} navigationIntent={dashboardNavigationIntent} onNavigationIntentConsumed={consumeDashboardNavigationIntent} onOpenTransaction={openReportTransaction} />}
          {view === "transactions" && <TransactionsView items={transactions.filter((item) => item.transactionDate.startsWith(selectedMonth))} onNew={() => openTransaction()} onEdit={openTransaction} onDelete={async (item) => { await api({ action: "delete_transaction", id: item.id }); toast.success("Movimentação excluída e saldo recalculado."); await refresh(); }} />}
          {view === "accounts" && <AccountsView accounts={accounts} onNew={() => { setEditingAccount(null); setAccountOpen(true); }} onEdit={(item) => { setEditingAccount(item); setAccountOpen(true); }} onDelete={async (item) => { await api({ action: "delete_account", id: item.id }); toast.success("Conta excluída."); await load(); }} />}
          {view === "categories" && <CategoriesView categories={categories} onNew={() => { setEditingCategory(null); setCategoryOpen(true); }} onEdit={(item) => { setEditingCategory(item); setCategoryOpen(true); }} onDelete={async (item) => { await api({ action: "delete_category", id: item.id }); toast.success("Categoria excluída."); await load(); }} onChanged={load} />}
          {view === "family" && <FamilyView data={data} onChanged={load} />}
          {advancedViews.includes(view as AdvancedView) && <AdvancedFinanceView view={view as AdvancedView} data={advanced} accounts={accounts} categories={categories} onChanged={refresh} />}
        </div>
      </section>
      <MobileNav current={view} onNavigate={navigate} />
      <EnhancedTransactionDialog key={transactionDialogSession} open={transactionOpen} item={editingTransaction} accounts={accounts} categories={categories} cards={advanced?.cards ?? []} onOpenChange={setTransactionOpen} onSaved={async () => { setTransactionOpen(false); await refresh(); setReportRevision((value) => value + 1); }} />
      <AccountDialog open={accountOpen} item={editingAccount} onOpenChange={setAccountOpen} onSaved={async () => { setAccountOpen(false); await load(); }} />
      <CategoryDialog open={categoryOpen} item={editingCategory} onOpenChange={setCategoryOpen} onSaved={async () => { setCategoryOpen(false); await load(); }} />
    </main>
  );
}

const navItems: Array<{ id: View; label: string; icon: typeof LayoutDashboard }> = [{ id: "dashboard", label: "Visão geral", icon: LayoutDashboard }, { id: "reports", label: "Relatórios", icon: BarChart3 }, { id: "transactions", label: "Movimentações", icon: ReceiptText }, { id: "bills", label: "Vencimentos", icon: CalendarClock }, { id: "cards", label: "Cartões", icon: CreditCard }, { id: "installments", label: "Parcelas", icon: ReceiptText }, { id: "simulator", label: "Simulador", icon: Sparkles }, { id: "accounts", label: "Contas", icon: Landmark }, { id: "categories", label: "Categorias", icon: Tags }, { id: "family", label: "Família", icon: Users }, { id: "settings", label: "Configurações", icon: Settings2 }];

function Sidebar({ current, onNavigate, user, family, mobileOpen, onClose }: { current: View; onNavigate: (view: View) => void; user: Snapshot["user"]; family: string; mobileOpen: boolean; onClose: () => void }) {
  return <><div onClick={onClose} className={`fixed inset-0 z-30 bg-black/35 transition lg:hidden ${mobileOpen ? "opacity-100" : "pointer-events-none opacity-0"}`} /><aside className={`fixed inset-y-0 left-0 z-40 flex w-[248px] flex-col bg-[#0d2925] px-5 py-6 text-white transition-transform lg:translate-x-0 ${mobileOpen ? "translate-x-0" : "-translate-x-full"}`}><button className="absolute right-3 top-3 rounded-lg p-2 text-white/60 lg:hidden" onClick={onClose} aria-label="Fechar menu"><X className="h-5 w-5" /></button><div className="flex items-center gap-3 px-2"><div className="grid h-10 w-10 place-items-center rounded-2xl bg-[#b9f47a] text-[#17342d]"><Home className="h-5 w-5" /></div><div className="min-w-0"><p className="truncate text-lg font-semibold leading-none" title={family}>{family}</p><p className="mt-1 text-xs text-white/55">Finanças da família</p></div></div><nav className="mt-10 space-y-1.5">{navItems.map(({ id, label, icon: Icon }) => <button key={id} onClick={() => onNavigate(id)} className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-medium ${current === id ? "bg-white/12 text-white" : "text-white/60 hover:bg-white/6 hover:text-white"}`}><Icon className="h-[18px] w-[18px]" />{label}</button>)}</nav><div className="mt-auto rounded-2xl border border-white/10 bg-white/5 p-3"><p className="truncate text-sm font-medium" title={user.name}>{user.name}</p><p className="truncate text-xs text-white/50" title={user.email}>{user.email}</p><button type="button" onClick={() => void signOut().catch((error) => toast.error(error.message))} className="mt-3 block text-xs font-medium text-[#b9f47a]">Sair da conta</button></div></aside></>;
}

function MobileNav({ current, onNavigate }: { current: View; onNavigate: (view: View) => void }) { const items = navItems.filter((item) => ["dashboard", "reports", "transactions", "bills", "settings"].includes(item.id)); return <nav className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 border-t bg-white px-1 py-1.5 lg:hidden">{items.map(({ id, label, icon: Icon }) => <button key={id} onClick={() => onNavigate(id)} className={`flex min-w-0 flex-col items-center gap-1 rounded-xl py-1.5 text-[11px] ${current === id ? "font-semibold text-[#173c35]" : "text-[#758783]"}`}><Icon className={`h-5 w-5 ${current === id ? "text-[#639b32]" : ""}`} /><span className="max-w-full truncate">{label === "Movimentações" ? "Lançar" : label}</span></button>)}</nav>; }

function TransactionsView({ items, onNew, onEdit, onDelete }: { items: Transaction[]; onNew: () => void; onEdit: (item: Transaction) => void; onDelete: (item: Transaction) => Promise<void> }) { const [query, setQuery] = useState(""); const [type, setType] = useState("all"); const filtered = items.filter((item) => (type === "all" || item.type === type) && `${item.description} ${item.categoryName ?? ""} ${item.accountName ?? ""}`.toLowerCase().includes(query.toLowerCase())); return <section><PageHeading title="Movimentações" text="Crie, encontre, corrija ou exclua qualquer lançamento." action={<Button onClick={onNew}><Plus className="h-4 w-4" /> Novo lançamento</Button>} /><div className="mt-6 rounded-[24px] border bg-white"><div className="flex flex-col gap-3 border-b p-4 sm:flex-row"><div className="relative flex-1"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#81918e]"/><Input value={query} onChange={(event) => setQuery(event.target.value)} className="pl-9" placeholder="Buscar por descrição, categoria ou conta" /></div><Select value={type} onValueChange={setType}><SelectTrigger className="w-full sm:w-44"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Todos os tipos</SelectItem><SelectItem value="income">Entradas</SelectItem><SelectItem value="expense">Saídas</SelectItem></SelectContent></Select></div>{filtered.length ? <Table><TableHeader><TableRow><TableHead className="pl-5">Descrição</TableHead><TableHead>Data</TableHead><TableHead>Conta</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Valor</TableHead><TableHead className="w-24" /></TableRow></TableHeader><TableBody>{filtered.map((item) => <TableRow key={item.id}><TableCell className="pl-5"><p className="font-medium">{item.description}</p><p className="text-xs text-[#81918e]">{item.categoryName ?? "Sem categoria"} · {item.responsibleName ?? "Usuário"}</p></TableCell><TableCell>{shortDate.format(new Date(`${item.transactionDate}T00:00:00Z`))}</TableCell><TableCell>{item.accountName}</TableCell><TableCell><StatusBadge status={item.status} /></TableCell><TableCell className={`text-right font-semibold ${item.type === "income" ? "text-[#39742c]" : "text-[#a7641d]"}`}>{item.type === "income" ? "+" : "−"} {brl(item.amountCents)}</TableCell><TableCell><div className="flex justify-end gap-1"><Button variant="ghost" size="icon" onClick={() => onEdit(item)} aria-label={`Editar ${item.description}`}><Pencil className="h-4 w-4" /></Button><DeleteButton title="Excluir movimentação?" description={`${item.description} · ${brl(item.amountCents)}. O saldo será recalculado automaticamente.`} onConfirm={() => onDelete(item)} /></div></TableCell></TableRow>)}</TableBody></Table> : <div className="h-64"><EmptyState icon={Search} title="Nenhum resultado" text="Ajuste a busca ou registre uma nova movimentação." /></div>}</div></section>; }

function AccountsView({ accounts, onNew, onEdit, onDelete }: { accounts: Account[]; onNew: () => void; onEdit: (item: Account) => void; onDelete: (item: Account) => Promise<void> }) { return <section><PageHeading title="Contas e carteiras" text="O saldo de cada conta é calculado pelo saldo inicial e pelas movimentações confirmadas." action={<Button onClick={onNew}><Plus className="h-4 w-4" /> Nova conta</Button>} />{accounts.length ? <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">{accounts.map((account) => <article key={account.id} className={`rounded-[24px] border bg-white p-6 ${!account.isActive ? "opacity-60" : ""}`}><div className="flex items-start justify-between"><div className="grid h-11 w-11 place-items-center rounded-2xl bg-[#eaf3f0] text-[#32665c]">{account.type === "cash" ? <Wallet className="h-5 w-5" /> : <CreditCard className="h-5 w-5" />}</div><Badge variant={account.isActive ? "secondary" : "outline"}>{account.isActive ? "Ativa" : "Inativa"}</Badge></div><p className="mt-5 text-sm text-[#758783]">{accountType[account.type]}</p><h3 className="mt-1 text-lg font-semibold">{account.name}</h3><p className="mt-5 text-3xl font-semibold tracking-[-0.04em]">{brl(account.currentBalanceCents)}</p><p className="mt-1 text-xs text-[#899895]">Inicial: {brl(account.initialBalanceCents)}</p><div className="mt-5 flex gap-2 border-t pt-4"><Button variant="outline" className="flex-1" onClick={() => onEdit(account)}><Pencil className="h-4 w-4" /> Editar</Button><DeleteButton title="Excluir conta?" description="Só é possível excluir contas sem movimentações. Contas com histórico podem ser desativadas." onConfirm={() => onDelete(account)} /></div></article>)}</div> : <div className="mt-6 h-80 rounded-[24px] border bg-white"><EmptyState icon={Landmark} title="Cadastre onde o dinheiro está" text="Crie a primeira conta bancária, carteira, caixinha ou saldo em dinheiro." action={<Button onClick={onNew}><Plus className="h-4 w-4" /> Criar primeira conta</Button>} /></div>}</section>; }

function CategoriesView({ categories, onNew, onEdit, onDelete, onChanged }: { categories: Category[]; onNew: () => void; onEdit: (item: Category) => void; onDelete: (item: Category) => Promise<void>; onChanged: () => Promise<void> }) { return <section><PageHeading title="Categorias" text="Organize as despesas e receitas da família com categorias editáveis." action={<Button onClick={onNew}><Plus className="h-4 w-4" /> Nova categoria</Button>} /><div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">{categories.map((category) => <article key={category.id} className={`rounded-[24px] border bg-white p-5 ${!category.isActive ? "opacity-60" : ""}`}><div className="flex items-center justify-between"><div className="flex items-center gap-3"><span className="h-3 w-3 rounded-full" style={{ background: category.color }} /><h3 className="font-semibold">{category.name}</h3></div><Badge variant="outline">{category.type === "income" ? "Entrada" : category.type === "expense" ? "Saída" : "Ambos"}</Badge></div><div className="mt-4 flex min-h-16 flex-wrap content-start gap-2">{category.subcategories.filter((sub) => sub.isActive !== false).map((sub) => <span key={sub.id} className="rounded-lg bg-[#f0f4f2] px-2.5 py-1.5 text-xs text-[#60746f]">{sub.name}</span>)}</div><div className="mt-4 flex gap-2 border-t pt-4"><Button variant="ghost" className="flex-1" onClick={() => onEdit(category)}><Pencil className="h-4 w-4" /> Editar</Button><DeleteButton title="Excluir categoria?" description="Categorias em uso não podem ser excluídas; nesse caso, desative-a." onConfirm={() => onDelete(category)} /></div></article>)}</div><SubcategoryManager categories={categories} onAction={api} onChanged={onChanged} /></section>; }

function FamilyView({ data, onChanged }: { data: Snapshot; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [inviteCode, setInviteCode] = useState("");
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get("email") ?? "");
    setBusy(true);
    try {
      const result = await api({ action: "invite_member", email }) as { inviteCode?: string };
      setInviteCode(result.inviteCode ?? "");
      toast.success("Convite criado. Compartilhe o código com segurança.");
      event.currentTarget.reset();
      await onChanged();
    } catch (error) { toast.error(error instanceof Error ? error.message : "Falha ao adicionar membro."); }
    finally { setBusy(false); }
  };
  return <section><PageHeading title={data.household?.name ?? "Família"} text="As pessoas desta família enxergam os mesmos dados; cada ação continua identificada por usuário." /><div className="mt-6 grid gap-5 xl:grid-cols-[1.2fr_.8fr]"><div className="rounded-[24px] border bg-white p-6"><h3 className="font-semibold">Pessoas</h3><div className="mt-4 divide-y">{data.members?.map((member) => <div key={member.id} className="flex items-center gap-3 py-4"><div className="grid h-11 w-11 place-items-center rounded-full bg-[#e7f4db] font-semibold text-[#426b2b]">{(member.name ?? member.invitedEmail ?? "?").slice(0, 1).toUpperCase()}</div><div className="min-w-0 flex-1"><p className="truncate font-medium">{member.name ?? "Convite pendente"}</p><p className="truncate text-sm text-[#798a86]">{member.email ?? member.invitedEmail}</p></div><div className="text-right"><Badge variant={member.status === "active" ? "secondary" : "outline"}>{member.status === "active" ? "Ativo" : "Convidado"}</Badge><p className="mt-1 text-xs text-[#8a9996]">{member.role === "owner" ? "Responsável" : "Membro"}</p></div></div>)}</div></div><div className="rounded-[24px] border bg-white p-6"><h3 className="font-semibold">Adicionar pessoa</h3><p className="mt-2 text-sm leading-6 text-[#71837e]">Informe o e-mail da pessoa. Ela cria a própria conta e usa o código para entrar nesta família.</p><form onSubmit={submit} className="mt-5 space-y-3"><Label htmlFor="member-email">E-mail</Label><Input id="member-email" name="email" type="email" required placeholder="pessoa@exemplo.com" /><Button className="w-full" disabled={busy || data.membership?.role !== "owner"}>{busy ? "Criando convite..." : "Gerar convite"}</Button>{data.membership?.role !== "owner" && <p className="text-xs text-[#8a9996]">Apenas o responsável pode adicionar membros.</p>}</form>{inviteCode && <div className="mt-5 rounded-2xl border border-[#9bc37a] bg-[#f3faed] p-4"><p className="text-sm font-semibold">Código do convite</p><p className="mt-1 text-xs leading-5 text-[#667a61]">Envie este código apenas para a pessoa convidada. Ele expira em 7 dias.</p><div className="mt-3 flex gap-2"><Input readOnly value={inviteCode} className="font-mono" /><Button type="button" variant="outline" onClick={() => void navigator.clipboard.writeText(inviteCode)}>Copiar</Button></div></div>}</div></div></section>;
}

function EnhancedTransactionDialog({ open, item, accounts, categories, cards, onOpenChange, onSaved }: { open: boolean; item: Transaction | null; accounts: Account[]; categories: Category[]; cards: Array<{ id: string; name: string; isActive: boolean }>; onOpenChange: (open: boolean) => void; onSaved: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [type, setType] = useState<"income" | "expense">("expense");
  const [payment, setPayment] = useState("pix");
  const [classification, setClassification] = useState({ categoryId: null as string | null, subcategoryId: null as string | null });
  if (item) return <TransactionDialog key={`${item.id}-${open ? "open" : "closed"}`} open={open} item={item} accounts={accounts} categories={categories} onOpenChange={onOpenChange} onSaved={onSaved} />;
  const isCardPurchase = type === "expense" && payment === "credit_card";
  const selectType = (nextType: "income" | "expense") => {
    const next = changeTransactionType({ type, ...classification }, nextType, categories);
    setType(nextType);
    setClassification({ categoryId: next.categoryId, subcategoryId: next.subcategoryId });
    if (nextType === "income") setPayment("pix");
  };
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const classificationError = transactionClassificationError({ type, ...classification }, categories);
    if (classificationError) { toast.error(classificationError); return; }
    const amountCents = Math.round(Number(String(form.get("amount") ?? "0").replace(/\./g, "").replace(",", ".")) * 100);
    setBusy(true);
    try {
      if (isCardPurchase) await advancedApi({ action: "create_card_purchase", cardId: form.get("cardId"), description: form.get("description"), totalCents: amountCents, purchaseDate: form.get("transactionDate"), installmentCount: Number(form.get("installmentCount")), categoryId: classification.categoryId, subcategoryId: classification.subcategoryId, notes: form.get("notes") || null, origin: "web" });
      else await api({ action: "create_transaction", type, amountCents, description: form.get("description"), categoryId: classification.categoryId, subcategoryId: classification.subcategoryId, transactionDate: form.get("transactionDate"), transactionTime: null, accountId: form.get("accountId"), paymentMethod: payment, status: "confirmed", notes: form.get("notes") || null });
      toast.success(isCardPurchase ? "Compra e parcelas registradas." : "Lançamento registrado.");
      await onSaved();
    } catch (error) { toast.error(error instanceof Error ? error.message : "Não foi possível salvar."); }
    finally { setBusy(false); }
  };
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-xl"><DialogHeader><DialogTitle>Novo lançamento</DialogTitle><DialogDescription>Compras no cartão geram parcelas; PIX, débito e dinheiro alteram a conta escolhida.</DialogDescription></DialogHeader><form onSubmit={submit} className="grid gap-4 sm:grid-cols-2"><div className="sm:col-span-2"><Label>Tipo</Label><div className="mt-2 grid grid-cols-2 rounded-xl bg-[#edf2f0] p-1"><button type="button" onClick={() => selectType("expense")} className={`rounded-lg py-2.5 text-sm font-semibold ${type === "expense" ? "bg-white shadow-sm" : "text-[#758783]"}`}>Despesa</button><button type="button" onClick={() => selectType("income")} className={`rounded-lg py-2.5 text-sm font-semibold ${type === "income" ? "bg-white shadow-sm" : "text-[#758783]"}`}>Receita</button></div></div><Field label="Valor (R$)" name="amount" inputMode="decimal" required /><Field label="Data" name="transactionDate" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required /><div className="sm:col-span-2"><Field label="Descrição" name="description" required /></div>{type === "expense" && <div><Label>Forma de pagamento</Label><Select value={payment} onValueChange={setPayment}><SelectTrigger className="mt-2 w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="cash">Dinheiro</SelectItem><SelectItem value="pix">PIX</SelectItem><SelectItem value="debit">Débito</SelectItem><SelectItem value="credit_card">Cartão de crédito</SelectItem></SelectContent></Select></div>}{isCardPurchase ? <><SelectField label="Cartão" name="cardId" items={cards.filter((card) => card.isActive).map((card) => ({ value: card.id, label: card.name }))} /><Field label="Número de parcelas" name="installmentCount" type="number" min={1} max={120} defaultValue={1} required /></> : <SelectField label="Conta" name="accountId" items={accounts.filter((account) => account.isActive).map((account) => ({ value: account.id, label: `${account.name} · ${brl(account.currentBalanceCents)}` }))} />}<TransactionClassificationFields type={type} categories={categories} classification={classification} onChange={setClassification} requireExpense allowSubcategory /><div className="sm:col-span-2"><Field label="Observação" name="notes" /></div><DialogFooter className="sm:col-span-2"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button><Button type="submit" disabled={busy || (isCardPurchase && !cards.some((card) => card.isActive))}>{busy ? "Salvando..." : "Registrar"}</Button></DialogFooter></form></DialogContent></Dialog>;
}

function TransactionDialog({ open, item, accounts, categories, onOpenChange, onSaved }: { open: boolean; item: Transaction | null; accounts: Account[]; categories: Category[]; onOpenChange: (open: boolean) => void; onSaved: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [type, setType] = useState<"income" | "expense">(item?.type ?? "expense");
  const [classification, setClassification] = useState({ categoryId: item?.categoryId ?? null, subcategoryId: item?.subcategoryId ?? null });
  const selectType = (nextType: "income" | "expense") => {
    const next = changeTransactionType({ type, ...classification }, nextType, categories);
    setType(nextType);
    setClassification({ categoryId: next.categoryId, subcategoryId: next.subcategoryId });
  };
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const classificationError = transactionClassificationError({ type, ...classification }, categories);
    if (classificationError) { toast.error(classificationError); return; }
    const form = new FormData(event.currentTarget);
    const amount = Number(String(form.get("amount") ?? "0").replace(".", "").replace(",", "."));
    setBusy(true);
    try {
      await api({ action: item ? "update_transaction" : "create_transaction", ...(item ? { id: item.id } : {}), type, amountCents: Math.round(amount * 100), description: form.get("description"), categoryId: classification.categoryId, subcategoryId: classification.subcategoryId, transactionDate: form.get("transactionDate"), transactionTime: form.get("transactionTime") || null, accountId: form.get("accountId"), paymentMethod: form.get("paymentMethod") || null, status: form.get("status"), notes: form.get("notes") || null });
      toast.success(item ? "Movimentação atualizada e saldo recalculado." : "Lançamento registrado com sucesso.");
      await onSaved();
    } catch (error) { toast.error(error instanceof Error ? error.message : "Não foi possível salvar."); }
    finally { setBusy(false); }
  };
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-xl"><DialogHeader><DialogTitle>{item ? "Editar movimentação" : "Novo lançamento"}</DialogTitle><DialogDescription>Entradas aumentam o saldo; saídas confirmadas reduzem o saldo.</DialogDescription></DialogHeader><form onSubmit={submit} className="grid gap-4 sm:grid-cols-2"><div className="sm:col-span-2"><Label>Tipo</Label><div className="mt-2 grid grid-cols-2 rounded-xl bg-[#edf2f0] p-1"><button type="button" onClick={() => selectType("expense")} className={`rounded-lg py-2.5 text-sm font-semibold ${type === "expense" ? "bg-white text-[#9b5b17] shadow-sm" : "text-[#758783]"}`}>Saída</button><button type="button" onClick={() => selectType("income")} className={`rounded-lg py-2.5 text-sm font-semibold ${type === "income" ? "bg-white text-[#39742c] shadow-sm" : "text-[#758783]"}`}>Entrada</button></div></div><Field label="Valor (R$)" name="amount" inputMode="decimal" required defaultValue={item ? (item.amountCents / 100).toFixed(2).replace(".", ",") : ""} placeholder="0,00" /><Field label="Data" name="transactionDate" type="date" required defaultValue={item?.transactionDate ?? new Date().toISOString().slice(0, 10)} /><div className="sm:col-span-2"><Field label="Descrição" name="description" required defaultValue={item?.description ?? ""} placeholder="Ex.: Mercado da semana" /></div><SelectField label="Conta" name="accountId" defaultValue={item?.accountId ?? accounts.find((account) => account.isActive)?.id} items={accounts.filter((account) => account.isActive || account.id === item?.accountId).map((account) => ({ value: account.id, label: `${account.name} · ${brl(account.currentBalanceCents)}` }))} /><TransactionClassificationFields type={type} categories={categories} classification={classification} onChange={setClassification} requireExpense allowSubcategory /><SelectField label="Status" name="status" defaultValue={item?.status ?? "confirmed"} items={[{ value: "confirmed", label: "Confirmado" }, { value: "pending", label: "Pendente" }, { value: "cancelled", label: "Cancelado" }]} /><Field label="Hora" name="transactionTime" type="time" defaultValue={item?.transactionTime ?? ""} /><Field label="Forma de pagamento" name="paymentMethod" defaultValue={item?.paymentMethod ?? ""} placeholder="Pix, débito, dinheiro..." /><div className="sm:col-span-2"><Field label="Observação" name="notes" defaultValue={item?.notes ?? ""} placeholder="Opcional" /></div><DialogFooter className="sm:col-span-2"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button><Button type="submit" disabled={busy}>{busy ? "Salvando..." : item ? "Salvar alterações" : "Registrar lançamento"}</Button></DialogFooter></form></DialogContent></Dialog>;
}

function TransactionClassificationFields({ type, categories, classification, onChange, requireExpense, allowSubcategory }: { type: "income" | "expense"; categories: Category[]; classification: { categoryId: string | null; subcategoryId: string | null }; onChange: (value: { categoryId: string | null; subcategoryId: string | null }) => void; requireExpense: boolean; allowSubcategory: boolean }) {
  const categoryItems = categories.filter((category) => (category.isActive || category.id === classification.categoryId) && (category.type === type || category.type === "both"));
  const subcategoryItems: Subcategory[] = activeSubcategories(categories, classification.categoryId);
  const categoryRequired = requireExpense && type === "expense";
  const subcategoryRequired = categoryRequired && subcategoryItems.length > 0;
  return <><ControlledSelectField label="Categoria" name="categoryId" value={classification.categoryId} required={categoryRequired} optionalLabel="Sem categoria" items={categoryItems.map((category) => ({ value: category.id, label: category.name }))} onChange={(categoryId) => { const next = changeTransactionCategory(classification, categoryId); onChange({ categoryId: next.categoryId, subcategoryId: next.subcategoryId }); }} />{allowSubcategory && classification.categoryId && subcategoryItems.length > 0 && <ControlledSelectField label="Subcategoria" name="subcategoryId" value={classification.subcategoryId} required={subcategoryRequired} optionalLabel="Sem subcategoria" items={subcategoryItems.map((subcategory) => ({ value: subcategory.id, label: subcategory.name }))} onChange={(subcategoryId) => onChange({ ...classification, subcategoryId })} />}{allowSubcategory && classification.categoryId && subcategoryItems.length === 0 && <div className="self-end rounded-xl bg-[#f4f7f5] px-3 py-3 text-sm text-[#71837e]">Esta categoria não possui subcategorias ativas.</div>}</>;
}

function ControlledSelectField({ label, name, value, items, onChange, required, optionalLabel }: { label: string; name: string; value: string | null; items: Array<{ value: string; label: string }>; onChange: (value: string | null) => void; required: boolean; optionalLabel: string }) {
  return <div><Label>{label}{required ? " *" : ""}</Label><Select name={name} value={value ?? "none"} onValueChange={(next) => onChange(next === "none" ? null : next)}><SelectTrigger className="mt-2 w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none" disabled={required}>{required ? `Selecione ${label.toLocaleLowerCase("pt-BR")}` : optionalLabel}</SelectItem>{items.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></div>;
}

function AccountDialog({ open, item, onOpenChange, onSaved }: { open: boolean; item: Account | null; onOpenChange: (open: boolean) => void; onSaved: () => Promise<void> }) { const [busy, setBusy] = useState(false); const submit = async (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); const initial = Number(String(form.get("initialBalance") ?? "0").replace(".", "").replace(",", ".")); setBusy(true); try { await api({ action: item ? "update_account" : "create_account", ...(item ? { id: item.id } : {}), name: form.get("name"), type: form.get("type"), initialBalanceCents: Math.round(initial * 100), isActive: form.get("isActive") === "true" }); toast.success(item ? "Conta atualizada." : "Conta criada. O saldo já está disponível."); await onSaved(); } catch (error) { toast.error(error instanceof Error ? error.message : "Não foi possível salvar."); } finally { setBusy(false); } }; return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>{item ? "Editar conta" : "Nova conta"}</DialogTitle><DialogDescription>Cadastre onde o dinheiro da família está guardado.</DialogDescription></DialogHeader><form onSubmit={submit} className="space-y-4"><Field label="Nome da conta" name="name" required defaultValue={item?.name ?? ""} placeholder="Ex.: Conta principal" /><SelectField label="Tipo" name="type" defaultValue={item?.type ?? "bank"} items={Object.entries(accountType).map(([value, label]) => ({ value, label }))} /><Field label="Saldo inicial (R$)" name="initialBalance" inputMode="decimal" required defaultValue={item ? (item.initialBalanceCents / 100).toFixed(2).replace(".", ",") : "0,00"} /><SelectField label="Status" name="isActive" defaultValue={item?.isActive === false ? "false" : "true"} items={[{ value: "true", label: "Ativa" }, { value: "false", label: "Inativa" }]} /><DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button><Button type="submit" disabled={busy}>{busy ? "Salvando..." : "Salvar conta"}</Button></DialogFooter></form></DialogContent></Dialog>; }

function CategoryDialog({ open, item, onOpenChange, onSaved }: { open: boolean; item: Category | null; onOpenChange: (open: boolean) => void; onSaved: () => Promise<void> }) { const [busy, setBusy] = useState(false); const submit = async (event: React.FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); setBusy(true); try { await api({ action: item ? "update_category" : "create_category", ...(item ? { id: item.id, isActive: form.get("isActive") === "true" } : { subcategories: String(form.get("subcategories") ?? "").split(",").map((value) => value.trim()).filter(Boolean) }), name: form.get("name"), type: form.get("type"), color: form.get("color") }); toast.success(item ? "Categoria atualizada." : "Categoria criada."); await onSaved(); } catch (error) { toast.error(error instanceof Error ? error.message : "Não foi possível salvar."); } finally { setBusy(false); } }; return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>{item ? "Editar categoria" : "Nova categoria"}</DialogTitle><DialogDescription>Use categorias para entender onde a família ganha e gasta.</DialogDescription></DialogHeader><form onSubmit={submit} className="space-y-4"><Field label="Nome" name="name" required defaultValue={item?.name ?? ""} /><SelectField label="Tipo" name="type" defaultValue={item?.type ?? "expense"} items={[{ value: "expense", label: "Saída" }, { value: "income", label: "Entrada" }, { value: "both", label: "Entrada e saída" }]} /><div><Label htmlFor="category-color">Cor</Label><Input id="category-color" name="color" type="color" className="mt-2 h-11 p-1" defaultValue={item?.color ?? "#397f72"} /></div>{item ? <SelectField label="Status" name="isActive" defaultValue={item.isActive ? "true" : "false"} items={[{ value: "true", label: "Ativa" }, { value: "false", label: "Inativa" }]} /> : <Field label="Subcategorias" name="subcategories" placeholder="Mercado, Restaurante, Delivery" />}<DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button><Button type="submit" disabled={busy}>{busy ? "Salvando..." : "Salvar categoria"}</Button></DialogFooter></form></DialogContent></Dialog>; }

function HouseholdSetup({ user, onDone }: { user: Snapshot["user"]; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState<"create" | "accept" | null>(null);
  const createFamily = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy("create");
    try { const name = String(new FormData(event.currentTarget).get("name") ?? ""); await api({ action: "create_household", name }); toast.success("Família criada. As categorias iniciais já estão prontas."); await onDone(); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Não foi possível criar a família."); }
    finally { setBusy(null); }
  };
  const acceptInvite = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy("accept");
    try { const inviteCode = String(new FormData(event.currentTarget).get("inviteCode") ?? ""); await api({ action: "accept_invite", inviteCode }); toast.success("Convite aceito. Bem-vindo à família."); await onDone(); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Não foi possível aceitar o convite."); }
    finally { setBusy(null); }
  };
  return <main className="grid min-h-screen place-items-center bg-[#0d2925] p-5"><Toaster richColors /><section className="w-full max-w-2xl rounded-[28px] bg-white p-7 shadow-2xl sm:p-10"><div className="grid h-12 w-12 place-items-center rounded-2xl bg-[#b9f47a] text-[#17342d]"><Home className="h-6 w-6" /></div><p className="mt-7 text-sm font-semibold uppercase tracking-[.14em] text-[#6f817c]">Bem-vindo, {user.name.split(" ")[0]}</p><h1 className="mt-2 text-3xl font-semibold tracking-[-.04em]">Escolha como começar.</h1><p className="mt-3 leading-7 text-[#687b76]">Crie uma nova família ou use o código recebido para acessar uma família existente.</p><div className="mt-7 grid gap-5 md:grid-cols-2"><form className="rounded-2xl border p-5" onSubmit={createFamily}><h2 className="font-semibold">Criar uma família</h2><p className="mt-1 text-sm text-[#71837e]">Você será o responsável e poderá convidar outras pessoas.</p><div className="mt-4"><Field label="Nome da família" name="name" defaultValue={`Família de ${user.name.split(" ")[0]}`} required /></div><Button className="mt-4 h-11 w-full" disabled={busy !== null}>{busy === "create" ? "Preparando..." : "Criar família"}<ChevronRight className="h-4 w-4" /></Button></form><form className="rounded-2xl border p-5" onSubmit={acceptInvite}><h2 className="font-semibold">Aceitar convite</h2><p className="mt-1 text-sm text-[#71837e]">O e-mail da sua conta deve ser o mesmo informado no convite.</p><div className="mt-4"><Field label="Código do convite" name="inviteCode" autoComplete="off" required placeholder="XXXX-XXXX-XXXX-XXXX" /></div><Button className="mt-4 h-11 w-full" variant="outline" disabled={busy !== null}>{busy === "accept" ? "Validando..." : "Entrar na família"}</Button></form></div></section></main>;
}

function Field({ label, name, ...props }: { label: string; name: string } & React.ComponentProps<typeof Input>) { return <div><Label htmlFor={name}>{label}</Label><Input id={name} name={name} className="mt-2" {...props} /></div>; }
function SelectField({ label, name, defaultValue, items, optional }: { label: string; name: string; defaultValue?: string; items: Array<{ value: string; label: string }>; optional?: boolean }) { return <div><Label>{label}</Label><Select name={name} defaultValue={defaultValue ?? (optional ? "none" : items[0]?.value)}><SelectTrigger className="mt-2 w-full"><SelectValue /></SelectTrigger><SelectContent>{optional && <SelectItem value="none">Sem categoria</SelectItem>}{items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select></div>; }
function PageHeading({ title, text, action }: { title: string; text: string; action?: React.ReactNode }) { return <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><h2 className="text-3xl font-semibold tracking-[-.04em]">{title}</h2><p className="mt-2 max-w-2xl text-[#71837e]">{text}</p></div>{action}</div>; }
function EmptyState({ icon: Icon, title, text, action }: { icon: typeof ReceiptText; title: string; text: string; action?: React.ReactNode }) { return <div className="flex h-full flex-col items-center justify-center p-6 text-center"><div className="grid h-12 w-12 place-items-center rounded-2xl bg-[#edf3f1]"><Icon className="h-5 w-5 text-[#628079]" /></div><p className="mt-4 font-medium">{title}</p><p className="mt-1 max-w-sm text-sm text-[#738681]">{text}</p>{action && <div className="mt-5">{action}</div>}</div>; }
function StatusBadge({ status }: { status: Transaction["status"] }) { return <Badge variant={status === "confirmed" ? "secondary" : "outline"} className={status === "cancelled" ? "text-[#b24b54]" : ""}>{statusLabel[status]}</Badge>; }
function DeleteButton({ title, description, onConfirm }: { title: string; description: string; onConfirm: () => Promise<void> }) { const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false); const confirm = async () => { setBusy(true); try { await onConfirm(); setOpen(false); } catch (error) { toast.error(error instanceof Error ? error.message : "Não foi possível excluir."); } finally { setBusy(false); } }; return <><Button variant="ghost" size="icon" className="text-[#b44b54]" onClick={() => setOpen(true)} aria-label="Excluir"><Trash2 className="h-4 w-4" /></Button><AlertDialog open={open} onOpenChange={setOpen}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{title}</AlertDialogTitle><AlertDialogDescription>{description}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancelar</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={(event) => { event.preventDefault(); void confirm(); }} disabled={busy}>{busy ? "Excluindo..." : "Excluir"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></>; }
function LoadingScreen() { return <main className="grid min-h-screen place-items-center bg-[#f4f6f5]"><div className="text-center"><div className="mx-auto grid h-12 w-12 animate-pulse place-items-center rounded-2xl bg-[#b9f47a]"><CircleDollarSign className="h-6 w-6" /></div><p className="mt-4 text-sm text-[#6f817c]">Carregando as finanças da família…</p></div></main>; }
function ErrorScreen({ onRetry }: { onRetry: () => Promise<void> }) { return <main className="grid min-h-screen place-items-center bg-[#f4f6f5] p-5"><div className="max-w-md rounded-[24px] border bg-white p-8 text-center"><h1 className="text-xl font-semibold">Não foi possível abrir o painel</h1><p className="mt-2 text-sm text-[#71837e]">Tente novamente. Nenhum dado foi alterado.</p><Button className="mt-5" onClick={() => void onRetry()}>Tentar novamente</Button></div></main>; }
