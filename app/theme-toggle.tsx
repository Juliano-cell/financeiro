"use client";

import { Moon, Sun } from "lucide-react";
import { useUiPreferences } from "@/app/ui-preferences";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, themeReady, toggleTheme } = useUiPreferences();
  const controlClassName = `grid h-10 w-10 place-items-center rounded-xl border bg-background ${className}`;
  if (!themeReady) return <span className={controlClassName} aria-hidden="true"><span className="h-4 w-4 rounded-full border border-current opacity-40" /></span>;
  const dark = theme === "dark";
  return <TooltipProvider><Tooltip><TooltipTrigger asChild><button type="button" onClick={toggleTheme} className={controlClassName} aria-label={dark ? "Ativar tema claro" : "Ativar tema escuro"} aria-pressed={dark}>{dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}</button></TooltipTrigger><TooltipContent>{dark ? "Tema claro" : "Tema escuro"}</TooltipContent></Tooltip></TooltipProvider>;
}
