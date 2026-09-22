import type { Metadata } from "next";
import "./globals.css";
import { UiPreferencesProvider } from "./ui-preferences";

export const metadata: Metadata = { title: "Nossa Casa | Finanças da família", description: "Controle financeiro familiar com acesso individual e dados separados por família.", icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" } };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="pt-BR" suppressHydrationWarning><body className="antialiased"><UiPreferencesProvider>{children}</UiPreferencesProvider></body></html>; }
