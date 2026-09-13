"use client";

import { useRef, useState } from "react";
import { Pencil, Plus, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type ManagedSubcategory = { id: string; name: string; categoryId: string; isActive?: boolean; isInUse?: boolean };
export type ManagedCategory = { id: string; name: string; type: "income" | "expense" | "both"; isActive: boolean; subcategories: ManagedSubcategory[] };

type Props = {
  categories: ManagedCategory[];
  onAction: (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  onChanged: () => Promise<void>;
};

export function SubcategoryManager({ categories, onAction, onChanged }: Props) {
  const [filter, setFilter] = useState<"all" | "active" | "inactive">("all");
  const [editor, setEditor] = useState<{ item: ManagedSubcategory | null; session: number } | null>(null);
  const [deactivating, setDeactivating] = useState<ManagedSubcategory | null>(null);
  const [statusBusy, setStatusBusy] = useState<string | null>(null);
  const session = useRef(0);
  const activeCategories = categories.filter((category) => category.isActive);
  const visibleGroups = categories.map((category) => ({
    category,
    subcategories: category.subcategories.filter((subcategory) => filter === "all" || (filter === "active" ? subcategory.isActive !== false : subcategory.isActive === false)),
  })).filter((group) => group.subcategories.length > 0);
  const openEditor = (item: ManagedSubcategory | null) => { session.current += 1; setEditor({ item, session: session.current }); };
  const reactivate = async (subcategory: ManagedSubcategory) => {
    if (statusBusy) return;
    setStatusBusy(subcategory.id);
    try {
      await onAction({ action: "set_subcategory_active", id: subcategory.id, isActive: true });
      toast.success("Subcategoria reativada.");
      await onChanged();
    } catch (error) { toast.error(error instanceof Error ? error.message : "Não foi possível reativar a subcategoria."); }
    finally { setStatusBusy(null); }
  };

  return <section className="mt-10 rounded-[24px] border bg-white p-5 sm:p-6">
    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><h3 className="text-xl font-semibold">Subcategorias</h3><p className="mt-1 text-sm text-[#71837e]">Organize os detalhes de cada categoria sem alterar o histórico financeiro.</p></div><div className="flex flex-col gap-2 sm:flex-row"><Select value={filter} onValueChange={(value) => setFilter(value as typeof filter)}><SelectTrigger className="w-full sm:w-36"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Todas</SelectItem><SelectItem value="active">Ativas</SelectItem><SelectItem value="inactive">Inativas</SelectItem></SelectContent></Select><Button disabled={!activeCategories.length} onClick={() => openEditor(null)}><Plus className="h-4 w-4" /> Nova subcategoria</Button></div></div>
    <div className="mt-6 grid gap-5">{visibleGroups.length ? visibleGroups.map(({ category, subcategories }) => <article key={category.id} className="rounded-2xl border bg-[#fbfcfb] p-4"><div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{category.name}</span><Badge variant={category.isActive ? "outline" : "secondary"}>{category.isActive ? "Categoria ativa" : "Categoria inativa"}</Badge></div><div className="mt-3 grid gap-2">{subcategories.map((subcategory) => <div key={subcategory.id} className="flex flex-col gap-3 rounded-xl bg-white p-3 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="truncate font-medium" title={subcategory.name}>{subcategory.name}</span><Badge variant={subcategory.isActive === false ? "outline" : "secondary"}>{subcategory.isActive === false ? "Inativa" : "Ativa"}</Badge>{subcategory.isInUse && <span className="text-xs text-[#71837e]">Em uso no histórico</span>}</div>{subcategory.isActive === false && !category.isActive && <p className="mt-1 text-xs text-[#9b5b17]">Ative a categoria {category.name} antes de reativar esta subcategoria.</p>}</div><div className="flex flex-wrap gap-2"><Button size="sm" variant="ghost" onClick={() => openEditor(subcategory)}><Pencil className="h-4 w-4" /> Editar</Button>{subcategory.isActive === false ? <Button size="sm" variant="outline" disabled={statusBusy === subcategory.id || !category.isActive} onClick={() => void reactivate(subcategory)}><RotateCcw className="h-4 w-4" /> {statusBusy === subcategory.id ? "Reativando..." : "Reativar"}</Button> : <Button size="sm" variant="outline" disabled={statusBusy !== null} onClick={() => setDeactivating(subcategory)}>Desativar</Button>}</div></div>)}</div></article>) : <div className="rounded-2xl border border-dashed p-8 text-center text-sm text-[#71837e]">Nenhuma subcategoria encontrada neste filtro.</div>}</div>
    {editor && <SubcategoryEditor key={editor.session} open item={editor.item} categories={categories} onAction={onAction} onChanged={onChanged} onOpenChange={(open) => { if (!open) setEditor(null); }} />}
    {deactivating && <DeactivateSubcategoryDialog open item={deactivating} onAction={onAction} onChanged={onChanged} onOpenChange={(open) => { if (!open) setDeactivating(null); }} />}
  </section>;
}

function SubcategoryEditor({ open, item, categories, onAction, onChanged, onOpenChange }: Props & { open: boolean; item: ManagedSubcategory | null; onOpenChange: (open: boolean) => void }) {
  const activeCategories = categories.filter((category) => category.isActive);
  const initialCategoryId = item?.categoryId ?? activeCategories[0]?.id ?? "";
  const [categoryId, setCategoryId] = useState(initialCategoryId);
  const [busy, setBusy] = useState(false);
  const categoryLocked = Boolean(item?.isInUse);
  const categoryOptions = categories.filter((category) => category.isActive || category.id === item?.categoryId);
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!categoryId || busy) return;
    const name = String(new FormData(event.currentTarget).get("name") ?? "");
    setBusy(true);
    let completed = false;
    try {
      await onAction({ action: item ? "update_subcategory" : "create_subcategory", ...(item ? { id: item.id } : {}), name, categoryId });
      toast.success(item ? "Subcategoria atualizada." : "Subcategoria criada.");
      await onChanged();
      completed = true;
    } catch (error) { toast.error(error instanceof Error ? error.message : "Não foi possível salvar a subcategoria."); }
    finally { setBusy(false); if (completed) onOpenChange(false); }
  };
  return <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}><DialogContent><DialogHeader><DialogTitle>{item ? "Editar subcategoria" : "Nova subcategoria"}</DialogTitle><DialogDescription>{item ? "Renomeie a subcategoria sem perder nenhum lançamento histórico." : "Escolha a categoria pai e dê um nome claro à subcategoria."}</DialogDescription></DialogHeader><form onSubmit={submit} className="space-y-4"><div><Label>Categoria</Label><Select value={categoryId} disabled={categoryLocked} onValueChange={setCategoryId}><SelectTrigger className="mt-2 w-full"><SelectValue /></SelectTrigger><SelectContent>{categoryOptions.map((category) => <SelectItem key={category.id} value={category.id} disabled={!category.isActive}>{category.name}{category.isActive ? "" : " (inativa)"}</SelectItem>)}</SelectContent></Select>{categoryLocked && <p className="mt-2 text-xs leading-5 text-[#71837e]">Esta subcategoria já possui lançamentos e não pode ser movida para outra categoria. Você pode renomeá-la ou criar uma nova subcategoria.</p>}</div><div><Label htmlFor="subcategory-name">Subcategoria</Label><Input id="subcategory-name" name="name" className="mt-2" defaultValue={item?.name ?? ""} maxLength={120} required autoFocus /></div><DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancelar</Button><Button type="submit" disabled={busy || !categoryId}>{busy ? "Salvando..." : item ? "Salvar alterações" : "Criar subcategoria"}</Button></DialogFooter></form></DialogContent></Dialog>;
}

function DeactivateSubcategoryDialog({ open, item, onAction, onChanged, onOpenChange }: Pick<Props, "onAction" | "onChanged"> & { open: boolean; item: ManagedSubcategory; onOpenChange: (open: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    let completed = false;
    try {
      await onAction({ action: "set_subcategory_active", id: item.id, isActive: false });
      toast.success("Subcategoria desativada. O histórico foi preservado.");
      await onChanged();
      completed = true;
    } catch (error) { toast.error(error instanceof Error ? error.message : "Não foi possível desativar a subcategoria."); }
    finally { setBusy(false); if (completed) onOpenChange(false); }
  };
  return <AlertDialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Desativar {item.name}?</AlertDialogTitle><AlertDialogDescription>Esta subcategoria deixará de aparecer em novos lançamentos, mas continuará sendo exibida no histórico.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={busy}>Voltar</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={busy} onClick={(event) => { event.preventDefault(); void confirm(); }}>{busy ? "Desativando..." : "Desativar"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>;
}
