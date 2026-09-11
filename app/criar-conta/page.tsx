import { AuthForm } from "../auth-forms";
import { AuthShell } from "../auth-shell";

export default function RegisterPage() { return <AuthShell title="Criar conta" description="Crie seu acesso pessoal. Depois, crie uma família ou aceite um convite."><AuthForm mode="register" /></AuthShell>; }
