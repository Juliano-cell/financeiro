import { requireChatGPTUser } from "./chatgpt-auth";
import { FinanceApp } from "./finance-app";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await requireChatGPTUser("/");
  return <FinanceApp user={{ name: user.displayName, email: user.email }} />;
}
