# Transição e primeiro deploy seguro de notificações

## Estado de segurança

O endpoint `POST /api/notifications/run` permanece publicado apenas como
compatibilidade e responde `410 LEGACY_NOTIFICATION_ENGINE_DISABLED`. Ele não
lê o banco, não executa o planner antigo, não chama Telegram e não grava
`notification_log` ou `notification_outbox`.

As tabelas `notification_preferences` e `notification_log` permanecem intactas
durante a janela de auditoria. Seus dados não são copiados para
`user_notification_preferences`; o novo sistema continua exigindo opt-in
individual explícito. `NOTIFICATION_CRON_SECRET` pode permanecer configurado
remotamente e só deverá ser removido depois de confirmação operacional.

O Worker reconhece os horários do planner e do dispatcher, mas ambos falham
fechados. Somente o valor textual `true` em `NOTIFICATION_PLANNER_ENABLED` ou
`NOTIFICATION_DISPATCHER_ENABLED` habilita a automação correspondente. A
configuração de produção declara `triggers.crons: []` e as duas flags como
`false`.

## Sincronização e bootstrap

Salvar uma preferência e sincronizar seu cursor ocorre no mesmo `D1.batch`, que
é transacional no D1. Desabilitar limpa imediatamente slot e lease; criar,
habilitar ou alterar horário/fuso calcula o próximo slot. Uma reabilitação
nunca reutiliza `last_completed_local_date`.

`bootstrapNotificationScheduleStates` é uma função administrativa idempotente
para a futura preparação controlada. Ela considera apenas opt-ins novos
habilitados, membership ativa, canais suportados e cursores ausentes. Não há
rota, script de deploy, startup ou Cron que a execute automaticamente.

## Checklist futuro do primeiro deploy

Este checklist é um plano; nenhuma etapa remota foi executada nesta fase.

1. Fazer backup/export do D1.
2. Aplicar `0007_notification_foundation.sql`, se ainda pendente.
3. Aplicar `0008_notification_schedule_state.sql`.
4. Aplicar `0009_notification_transport_state.sql`.
5. Verificar schema, constraints, índices e migrations aplicadas.
6. Executar verificações de integridade e foreign keys.
7. Fazer deploy com `triggers.crons: []`.
8. Confirmar as duas flags automáticas desligadas.
9. Fazer smoke test de `fetch`, assets e APIs autenticadas.
10. Fazer smoke test do webhook Telegram sem envio automático.
11. Executar o bootstrap controlado somente para uma conta de teste.
12. Inspecionar cursor e outbox da conta de teste.
13. Somente depois considerar ativar o planner.
14. Validar o resultado e somente depois considerar ativar o dispatcher.
15. Somente posteriormente planejar liberação para usuários reais.
