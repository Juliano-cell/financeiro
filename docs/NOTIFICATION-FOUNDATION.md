# Fundação segura de notificações

## Escopo desta etapa

A infraestrutura nova é paralela ao sistema legado e não envia mensagens. Ela
é composta por preferências individuais (`user_notification_preferences`), uma
outbox idempotente (`notification_outbox`) e o serviço independente em
`lib/notification-foundation.ts`, pelo planner local e pelo dispatcher seguro com
transport injetável.

O fluxo futuro previsto é:

`Cron -> planner -> outbox -> dispatcher`

Nenhuma dessas peças depende da rota HTTP legada para planejar ou persistir os
eventos. O dispatcher novo também permanece sem rota pública, Cron ou transport
real; integrações externas de entrega não fazem parte desta etapa.

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

## Transição do legado

As estruturas `notification_preferences` e `notification_log` permanecem
intactas para auditoria, mas não são fonte canônica da nova fundação e nenhum
opt-in é migrado automaticamente. A rota `/api/notifications/run` permanece
temporariamente por compatibilidade, respondendo explicitamente que o motor
legado foi desativado, sem consultar finanças, gravar estado ou enviar Telegram.

O plano operacional e as travas do primeiro deploy estão documentados em
`docs/NOTIFICATION-DEPLOYMENT-TRANSITION.md`.

## Planner local de contas a pagar

`lib/notification-planner.ts` implementa o planner independente da Etapa 3A.
Ele não possui rota HTTP nem agendamento: recebe um D1 e um relógio injetável,
seleciona somente preferências `telegram` habilitadas com membership e vínculo
Telegram ativos e cria itens na outbox pelo repositório idempotente da fundação.
O vínculo é apenas validado por existência; `chat_id`, token e conteúdo de
mensagem não são lidos nem copiados.

Somente contas a pagar com status `pending` são consideradas. Para cada
destinatário, o planner examina o intervalo civil ontem/hoje/amanhã no timezone
da preferência. Faturas de cartão e `upcoming_digest` ficam fora desta etapa.
As datas de referência têm a seguinte semântica:

- `bill_due_tomorrow`: dia local em que a conta se torna elegível ao aviso;
- `bill_due_today`: dia local do vencimento e do aviso;
- `bill_overdue`: primeiro dia local após o vencimento.

Por isso, uma conta atrasada há dois ou mais dias não gera novo evento. A
identidade persistida continua sendo a composição determinística da fundação,
e não o timestamp da execução.

O resumo do planner contém apenas contadores: destinatários e contas avaliados,
eventos elegíveis, inseridos, deduplicados e ignorados. `billsEvaluated` conta a
avaliação por destinatário; nenhum valor, descrição, identificador ou dado do
Telegram é retornado.

Planejamento não garante entrega. Antes de qualquer envio, o futuro dispatcher
deverá revalidar que a conta continua `pending`, a membership continua ativa, o
vínculo Telegram continua ativo e a preferência/evento continuam habilitados.

## Dispatcher seguro com transport simulado

`lib/notification-dispatcher.ts` implementa a Etapa 3B como serviço independente
e recebe obrigatoriamente um transport injetável. Ele não importa o cliente
Telegram existente, não lê token, não expõe endpoint e não possui agendamento.
Os testes usam somente transports em memória.

O claim é um único `UPDATE ... RETURNING`, que move atomicamente o primeiro item
elegível de `pending` para `processing`. Um item `processing` só pode ser retomado
depois do vencimento de `lease_until`; a duração padrão do lease é de cinco
minutos. A atualização e todas as transições seguintes conferem o valor exato do
lease, impedindo que um worker antigo prossiga depois de perder a posse.

Antes do transport, o dispatcher relê a outbox, a conta, a membership, a
preferência e o vínculo Telegram. A conta deve continuar `pending` e no mesmo
household; canal, opt-in e flag do evento devem continuar habilitados. O evento
é recalculado com o timezone atual da preferência e deve conservar `event_type`
e `reference_date`. Qualquer divergência cancela o item com um motivo técnico,
sem chamar o transport. O `chat_id` é resolvido internamente somente depois
dessa revalidação e nunca entra no resumo ou na outbox.

### Fronteira externa e resultado incerto

Imediatamente antes de chamar o transport, o dispatcher faz uma transição
durável de `processing` para `uncertain`, remove o lease e incrementa `attempts`.
Esse estado funciona como fence da fronteira externa:

- `processing` com lease expirado significa que a chamada externa ainda não foi
  armada e pode ser retomada;
- `uncertain` significa que a chamada pode ter ocorrido e nunca é retomada
  automaticamente.

Um crash entre gravar o fence e iniciar a chamada pode produzir um falso
positivo de incerteza, mas não uma mensagem duplicada. Essa escolha é
intencional. O schema da migration `0007` já suporta a estratégia e não precisa
ser alterado nesta etapa.

### Sucesso, falhas e retries

Sucesso move o item para `sent`, registra `sent_at` e, quando fornecido, apenas
o identificador da mensagem do provedor. Falha permanente move para `failed`.
Erros persistidos são códigos técnicos controlados; respostas externas, token,
URL, `chat_id` e o texto financeiro não são armazenados.

Uma resposta conhecida de rate limit retorna o item a `pending` e agenda
`next_attempt_at` pelo `retry_after`. Falhas transitórias conhecidas usam
backoff exponencial de 60, 120 e 240 segundos. São permitidas no máximo quatro
chamadas externas; a quarta falha encerra o item como `failed`. Exceções,
timeouts e qualquer resultado potencialmente ambíguo permanecem `uncertain`,
sem retry automático.

As mensagens são construídas somente após a revalidação, com descrição, valor
em reais e data civil atuais da conta. O resumo do dispatcher contém apenas os
contadores `claimed`, `sent`, `failed`, `retried`, `uncertain`, `cancelled` e
`skipped`.

## Configurações individuais e opt-in

A Etapa 3C adiciona `GET` e `POST` autenticados em
`/api/notifications/preferences` e uma seção de Notificações na tela de
Configurações. Household e usuário são sempre derivados da sessão e de uma
membership ativa; o cliente não envia nem escolhe essas identidades. Escritas
exigem same-origin, usam payload estrito e as respostas são privadas e sem
cache.

Quando ainda não existe preferência, o GET retorna defaults de interface sem
gravar: `enabled = false`, os três avisos de contas habilitados, horário `09:00`
e fuso de São Paulo. Portanto abrir a tela não cria opt-in. Somente o botão
Salvar persiste uma escolha explícita do próprio usuário.

Nesta versão, o único canal aceito é `telegram`, o fuso permanece fixo em
`America/Sao_Paulo` e `upcoming_digest` é sempre gravado como falso. A interface
expõe apenas aviso um dia antes, no vencimento e no primeiro dia de atraso. Não
há configuração de Push nem de faturas de cartão.

O estado do vínculo Telegram continua vindo da infraestrutura existente. A
tela informa apenas conectado ou não conectado e reutiliza o mesmo código de
conexão; nenhum identificador do Telegram é exposto. Salvar preferências não
executa planner ou dispatcher, não cria outbox e não envia mensagem. A mesma
transação sincroniza a elegibilidade do cursor. As tabelas legadas permanecem
preservadas, enquanto `/api/notifications/run` fica inerte.

## Transport Telegram do novo dispatcher

A Etapa 3D adiciona `TelegramNotificationTransport`, uma implementação do
contrato injetável do dispatcher. O transport recebe somente o `chat_id` já
revalidado e o texto já construído, chama `sendMessage` e converte a resposta
externa para resultados internos sanitizados: `sent`, `permanent_failure`,
`rate_limited`, `transient_failure` ou `uncertain`. Ele verifica tanto o status
HTTP quanto o campo `ok` da Bot API e persiste, via dispatcher, somente o
`message_id` quando disponível.

Respostas 429 respeitam `parameters.retry_after` quando ele é numérico,
positivo e limitado a 24 horas; na ausência de um valor válido, o dispatcher
usa seu backoff seguro. Respostas 4xx definitivas são permanentes e respostas
5xx são transitórias. Descrições externas não atravessam o contrato: códigos
internos nunca incluem token, destino, texto da mensagem ou valores da conta.

O request tem timeout explícito de 10 segundos. Esse limite evita manter um
worker indefinidamente preso sem ser agressivo com uma chamada normal à Bot
API. Como um abort ou erro de rede pode acontecer depois de o Telegram ter
recebido a requisição, ambos são classificados como `uncertain`; o fence
durável do dispatcher impede retry automático e possível envio duplicado.

`createTelegramNotificationDispatcherContext` compõe o D1 com um transport que
usa exclusivamente `TELEGRAM_BOT_TOKEN`. A factory não executa o dispatcher e
não está conectada a rota, startup, Cron, webhook ou salvamento. Uma futura
execução manual controlada poderá criar esse contexto e passá-lo explicitamente
a `runNotificationDispatcher`; essa chamada não existe nesta etapa. Os testes
exigem `fetch` injetado e usam somente respostas locais falsas. O envio legado,
o webhook e o fluxo `/conectar` permanecem intactos.
