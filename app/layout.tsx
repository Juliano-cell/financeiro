import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Nossa Casa | Finanças da família", description: "Controle financeiro compartilhado de Juliano e Maiara.", icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" } };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="pt-BR"><body className="antialiased">{children}</body></html>; }
