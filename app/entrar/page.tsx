import { AuthForm } from "../auth-forms";
import { AuthShell } from "../auth-shell";

export default function LoginPage() { return <AuthShell title="Entrar" description="Acesse os dados da sua família com seu e-mail e senha."><AuthForm mode="login" /></AuthShell>; }
