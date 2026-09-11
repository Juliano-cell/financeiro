import { redirect } from "next/navigation";
import { getCurrentUser } from "../auth";
import { FinanceApp } from "../finance-app";

export const dynamic = "force-dynamic";

export default async function FinancePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/entrar");
  return <FinanceApp />;
}
