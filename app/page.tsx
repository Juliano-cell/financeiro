import Link from "next/link";
import { CircleDollarSign, LockKeyhole, UsersRound, WalletCards } from "lucide-react";
import { getCurrentUser } from "./auth";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/app/theme-toggle";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getCurrentUser();
  return (
    <main className="min-h-screen bg-[#f4f6f5] text-[#132b27]">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-6">
        <div className="flex items-center gap-3"><span className="grid h-11 w-11 place-items-center rounded-2xl bg-[#123a33] text-[#b9f47a]"><CircleDollarSign className="h-6 w-6" /></span><div><p className="font-semibold">Nossa Casa</p><p className="text-sm text-[#6e817d]">Finanças da família</p></div></div>
        <div className="flex items-center gap-2"><ThemeToggle />{user ? <Button asChild><Link href="/app">Abrir painel</Link></Button> : <><Button variant="ghost" asChild><Link href="/entrar">Entrar</Link></Button><Button asChild><Link href="/criar-conta">Criar conta</Link></Button></>}</div>
      </header>
      <section className="mx-auto grid max-w-6xl items-center gap-10 px-5 pb-16 pt-8 lg:grid-cols-[1.08fr_.92fr] lg:pt-20">
        <div><p className="text-sm font-semibold uppercase tracking-[.16em] text-[#568237]">Organização compartilhada</p><h1 className="mt-4 max-w-3xl text-5xl font-semibold tracking-[-.055em] sm:text-6xl">A vida financeira da família, clara para todos.</h1><p className="mt-6 max-w-xl text-lg leading-8 text-[#617570]">Contas, lançamentos e saldos em um só lugar. Cada família mantém seus dados separados e cada pessoa acessa com sua própria conta.</p><div className="mt-8 flex flex-wrap gap-3">{user ? <Button size="lg" asChild><Link href="/app">Continuar como {user.name.split(" ")[0]}</Link></Button> : <><Button size="lg" asChild><Link href="/criar-conta">Criar minha conta</Link></Button><Button size="lg" variant="outline" asChild><Link href="/entrar">Já tenho conta</Link></Button></>}<Button size="lg" variant="ghost" asChild><Link href="/esqueci-senha">Esqueci minha senha</Link></Button></div></div>
        <div className="relative overflow-hidden rounded-[32px] bg-[#123a33] p-7 text-white shadow-[0_28px_80px_rgba(17,56,49,.22)] sm:p-9"><div className="absolute -right-14 -top-14 h-52 w-52 rounded-full border-[38px] border-[#b9f47a]/10" /><p className="text-sm font-medium text-white/60">Tudo o que importa</p><div className="mt-7 space-y-4"><Feature icon={WalletCards} title="Visão completa" text="Contas, categorias e movimentações organizadas por família." /><Feature icon={UsersRound} title="Acesso individual" text="Cada pessoa entra com seu próprio e-mail e senha." /><Feature icon={LockKeyhole} title="Dados protegidos" text="Sessões seguras e isolamento aplicado no servidor." /></div></div>
      </section>
    </main>
  );
}

function Feature({ icon: Icon, title, text }: { icon: typeof WalletCards; title: string; text: string }) {
  return <div className="flex gap-4 rounded-2xl border border-white/10 bg-white/5 p-4"><span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[#b9f47a] text-[#17342d]"><Icon className="h-5 w-5" /></span><div><h2 className="font-semibold">{title}</h2><p className="mt-1 text-sm leading-6 text-white/60">{text}</p></div></div>;
}
