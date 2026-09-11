import { AuthForm } from "../auth-forms";
import { AuthShell } from "../auth-shell";

export default function ResetPasswordPage() { return <AuthShell title="Recuperar senha" description="Use o código de recuperação que você guardou ao criar a conta."><AuthForm mode="reset" /></AuthShell>; }
