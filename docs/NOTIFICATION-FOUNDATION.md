# Fundação segura de notificações

## Escopo desta etapa

A infraestrutura nova é paralela ao sistema legado e não envia mensagens. Ela
é composta por preferências individuais (`user_notification_preferences`), uma
outbox idempotente (`notification_outbox`) e o serviço independente em
`lib/notification-foundation.ts`.

O fluxo futuro previsto é:

`Cron -> planner -> outbox -> dispatcher`

Nenhuma dessas peças depende da rota HTTP legada para planejar ou persistir os
eventos. O dispatcher, retries externos e integrações de entrega não fazem
parte desta etapa.

## Opt-in e isolamento

- Não há backfill das preferências antigas.
- Uma preferência nova nasce com `enabled = 0`.
- A identidade da preferência é `(household_id, user_id, channel)`.
- Preferência e outbox exigem a membership correspondente; o serviço também
  exige que ela esteja ativa no momento da leitura ou escrita.
- Telegram e Push são canais válidos no modelo, mas nenhum deles é acionado.
- Tokens e `chat_id` não são copiados para a outbox. Um dispatcher futuro deve
  resolver o vínculo interno em `telegram_links` somente no momento da entrega.

## Idempotência

A identidade lógica de um item é:

`household_id + recipient_user_id + channel + entity_type + entity_id + event_type + reference_date`

Ela possui índice UNIQUE próprio. A `dedupe_key`, construída deterministicamente
com esses mesmos campos, também é única. O repositório usa `INSERT ... ON
CONFLICT DO NOTHING`, de modo que execuções concorrentes convergem para um
único item.

O evento `bill_overdue` usa como `reference_date` o primeiro dia de atraso
(`due_date + 1`), mesmo quando o planner detecta a conta depois. Assim não surge
um lembrete diário de atraso.

## Timezone

Datas civis são calculadas pelo timezone da preferência usando relógio
injetável. O padrão inicial é `America/Sao_Paulo`; UTC não é usado como atalho
para definir hoje, amanhã ou atraso.

## Coexistência temporária

As estruturas `notification_preferences`, `notification_log` e a rota
`/api/notifications/run` permanecem inalteradas. Elas continuam sendo o sistema
legado e não são fonte canônica da nova fundação.

Uma etapa posterior deverá, de forma controlada:

1. expor opt-in individual;
2. implementar o planner sem faturas de cartão;
3. implementar leasing e dispatcher;
4. validar Telegram em ambiente seguro;
5. só então desativar a rota legada e avaliar migração de preferências.

Até essa decisão, não deve haver execução simultânea dos dois caminhos de
envio para o mesmo evento.
