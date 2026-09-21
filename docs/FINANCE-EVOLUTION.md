# Evolução financeira, Telegram e publicação segura

## Regra contábil

Uma compra no cartão é despesa nas parcelas/faturas correspondentes. O pagamento da fatura é uma liquidação em `invoice_payments`: reduz o saldo da conta bancária, mas não cria outra despesa. Uma conta a pagar só cria uma movimentação de despesa ao ser paga, guardando `payment_transaction_id`; repetir a ação é rejeitado.

O fechamento usa a data da compra. Compra feita até o dia de fechamento (inclusive) entra no ciclo atual; feita depois entra no próximo ciclo. Quando o vencimento é numericamente anterior ou igual ao fechamento, ele ocorre no mês seguinte. Dias inexistentes, como 31 em fevereiro, são ajustados para o último dia do mês.

Parcelas são sempre calculadas em centavos. A divisão usa o valor inteiro base e põe o restante nas últimas parcelas. Assim, R$ 100,00 em 3x resulta em R$ 33,33, R$ 33,33 e R$ 33,34.

## Telegram

Crie o bot no BotFather com `/newbot`, guarde o token e configure os secrets, sem colocá-los em arquivo versionado:

```text
npx wrangler secret put TELEGRAM_BOT_TOKEN --config wrangler.production.jsonc
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET --config wrangler.production.jsonc
npx wrangler secret put TELEGRAM_LINK_CODE_SECRET --config wrangler.production.jsonc
npx wrangler secret put NOTIFICATION_CRON_SECRET --config wrangler.production.jsonc
```

Depois do deploy autorizado, configure o webhook oficial para `https://SEU_DOMINIO/api/telegram/webhook` e envie `secret_token` igual a `TELEGRAM_WEBHOOK_SECRET`. O endpoint valida o cabeçalho `X-Telegram-Bot-Api-Secret-Token`, aceita somente JSON limitado e restringe operações financeiras a chats privados vinculados.

No site, cada usuário abre Configurações, gera um código de seis dígitos e envia `/conectar 123456` ou `/start 123456`. O banco guarda HMAC-SHA-256 do código, autenticado por `TELEGRAM_LINK_CODE_SECRET`; um vazamento isolado do banco não permite enumerar os seis dígitos sem o segredo. O código expira em dez minutos, aceita um único uso e vínculo e consumo são condicionados no mesmo batch. Códigos usados ou expirados são removidos durante a próxima geração. Há no máximo cinco gerações por usuário a cada hora. Os comandos de conexão permitem cinco tentativas por usuário Telegram em dez minutos e, ao exceder o limite, bloqueiam novas tentativas por quinze minutos.

Use um valor aleatório longo e independente para `TELEGRAM_LINK_CODE_SECRET`, diferente do token do bot e do segredo do webhook. A limpeza sob demanda na geração é suficiente para o volume doméstico; se o volume crescer, um Cron poderá excluir periodicamente códigos expirados ou usados sem alterar o protocolo.

O fluxo está separado em transporte, handler, parser determinístico, intenção financeira e serviço financeiro compartilhado. O parser reconhece valores brasileiros, entradas, despesas, hoje/ontem/anteontem, contas, cartões, categorias, subcategorias e parcelas apenas a partir dos registros da família. Quando faltam dados, salva contexto por dez minutos e pergunta somente o necessário. Um lançamento completo ainda exige confirmação e pode ser alterado ou cancelado.

Na confirmação, a inserção de `telegram_processed_updates`, a criação financeira, o `audit_log` e a remoção do estado conversacional são executados no mesmo batch D1. Assim, uma reentrega do update falha na chave primária e reverte a sequência inteira, sem criar duplicidade. A auditoria registra o update de confirmação, o update original e uma cópia limitada do texto recebido. O token do bot nunca é necessário para build ou testes.

## Contas recorrentes

Cada recorrência mensal possui uma linha própria em `recurring_bill_series`; as ocorrências em `bills` apontam para ela por foreign key composta com `household_id`. Editar ou cancelar uma ocorrência afeta somente aquela linha. Editar a série altera apenas ocorrências futuras ainda pendentes, preservando histórico, pagas e vencidas; reduzir a data final cancela as futuras que ficaram fora do período. Cancelar a série marca a série como inativa e cancela somente ocorrências futuras pendentes. A foreign key impede apagar a série enquanto houver ocorrências, evitando registros órfãos.

## Notificações e Cron

O antigo `POST /api/notifications/run` foi mantido apenas para compatibilidade e
responde que o mecanismo está desativado. Ele não consulta contas ou faturas,
não envia Telegram e não grava logs ou outbox.

Esta versão declara `triggers.crons: []`. A arquitetura nova usa entrypoint
agendado próprio e duas flags fail-closed, hoje desligadas; não se deve conectar
um agendador externo à rota legada. `NOTIFICATION_CRON_SECRET` permanece apenas
durante a janela de transição e poderá ser removido após confirmação operacional.

## Ordem exata para publicação posterior

1. Fazer backup/exportação do D1 atual.
2. Revisar a migration `0002_finance_evolution.sql` e executar primeiro em D1 local.
3. Fazer commit e push somente após autorização.
4. Aplicar as migrations no D1 remoto com `wrangler d1 migrations apply DB --remote --config wrangler.production.jsonc`.
5. Criar o bot no BotFather e configurar os quatro secrets.
6. Executar o deploy de produção.
7. Configurar o webhook com URL e secret corretos.
8. Testar vínculo e uma consulta com uma conta da família.
9. Ativar o Cron Trigger e fazer uma execução manual controlada.
10. Conferir `notification_log`, faturas, saldo e isolamento antes do uso cotidiano.
