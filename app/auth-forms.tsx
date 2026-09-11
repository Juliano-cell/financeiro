"use client";

import { useState } from "react";
import Link from "next/link";
import { Check, Copy, Eye, EyeOff, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

type Mode = "login" | "register" | "reset";

export function AuthForm({ mode }: { mode: Mode }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [activationRequired, setActivationRequired] = useState(false);
  const [newRecoveryCode, setNewRecoveryCode] = useState("");
  const [copied, setCopied] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const form = new FormData(event.currentTarget);
    const body: Record<string, unknown> = { action: mode === "register" ? "register" : mode === "reset" ? "reset_password" : "login" };
    for (const [key, value] of form.entries()) body[key] = value;
    try {
      const response = await fetch("/api/auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json() as { error?: string; code?: string; recoveryCode?: string };
      if (!response.ok) {
        if (data.code === "activation_required") setActivationRequired(true);
        throw new Error(data.error ?? "Não foi possível continuar.");
      }
      if (data.recoveryCode) setNewRecoveryCode(data.recoveryCode);
      else window.location.assign("/app");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível continuar."); }
    finally { setBusy(false); }
  }

  if (newRecoveryCode) return <div><Alert className="border-[#91bb69] bg-[#f3faed]"><KeyRound className="h-4 w-4" /><AlertTitle>Guarde seu novo código de recuperação</AlertTitle><AlertDescription>Ele será exibido somente agora e será necessário caso você esqueça a senha.</AlertDescription></Alert><div className="mt-5 flex gap-2"><Input readOnly value={newRecoveryCode} className="font-mono" aria-label="Código de recuperação" /><Button type="button" variant="outline" size="icon" onClick={async () => { await navigator.clipboard.writeText(newRecoveryCode); setCopied(true); }} aria-label="Copiar código">{copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}</Button></div><Button className="mt-5 w-full" onClick={() => window.location.assign("/app")}>Continuar para o painel</Button></div>;

  return <form className="space-y-4" onSubmit={submit}>
    {mode === "register" && <Field label="Nome" name="name" autoComplete="name" required placeholder="Seu nome" />}
    <Field label="E-mail" name="email" type="email" autoComplete="email" required placeholder="voce@exemplo.com" />
    {mode === "reset" && <Field label="Código de recuperação" name="recoveryCode" autoComplete="off" required placeholder="XXXX-XXXX-XXXX-XXXX" />}
    <PasswordField label={mode === "reset" ? "Nova senha" : "Senha"} name="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={8} placeholder="Mínimo de 8 caracteres" />
    {mode !== "login" && <PasswordField label="Confirmar senha" name="passwordConfirmation" autoComplete="new-password" required minLength={8} />}
    {mode === "register" && activationRequired && <div className="rounded-2xl border border-[#e4c675] bg-[#fff9e8] p-4"><p className="text-sm leading-6 text-[#735f29]">Este e-mail já possui dados da Fase 1. Use o código de ativação fornecido pelo responsável da publicação.</p><div className="mt-3"><Field label="Código de ativação" name="legacyClaimCode" autoComplete="off" required /></div></div>}
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    <Button className="h-11 w-full" disabled={busy}>{busy ? "Verificando..." : mode === "register" ? "Criar conta" : mode === "reset" ? "Redefinir senha" : "Entrar"}</Button>
    <div className="flex flex-wrap justify-center gap-x-4 gap-y-2 text-sm text-[#657873]">{mode !== "login" && <Link className="font-medium hover:underline" href="/entrar">Entrar</Link>}{mode !== "register" && <Link className="font-medium hover:underline" href="/criar-conta">Criar conta</Link>}{mode !== "reset" && <Link className="font-medium hover:underline" href="/esqueci-senha">Esqueci minha senha</Link>}</div>
  </form>;
}

function Field({ label, name, ...props }: { label: string; name: string } & React.ComponentProps<typeof Input>) { return <div><Label htmlFor={name}>{label}</Label><Input id={name} name={name} className="mt-2 h-11" {...props} /></div>; }

function PasswordField({ label, name, ...props }: { label: string; name: string } & React.ComponentProps<typeof Input>) {
  const [visible, setVisible] = useState(false);
  return <div><Label htmlFor={name}>{label}</Label><div className="relative mt-2"><Input id={name} name={name} type={visible ? "text" : "password"} className="h-11 pr-11" {...props} /><button type="button" className="absolute inset-y-0 right-0 grid w-11 place-items-center rounded-r-md text-[#657873] hover:text-[#173c35] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#397f72]" onClick={() => setVisible((value) => !value)} aria-label={visible ? `Ocultar ${label.toLowerCase()}` : `Mostrar ${label.toLowerCase()}`} aria-pressed={visible}>{visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button></div></div>;
}
