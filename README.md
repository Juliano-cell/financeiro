# Nossa Casa Finanças

Sistema de controle financeiro familiar construído com Vinext, React, TypeScript e Cloudflare D1.

## Execução local

Requisitos: Node.js 22.13 ou mais recente.

```powershell
npm run install:ci
npm run build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_family_finance.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0001_sharp_barracuda.sql
npm run dev
```

Abra `http://localhost:5173`. Não repita migrações já aplicadas no mesmo banco local.

## Autenticação

A aplicação possui autenticação própria e não usa a conta ChatGPT do visitante:

- senhas são armazenadas como PBKDF2-SHA-256 com salt individual e 310.000 iterações;
- cookies de sessão são `HttpOnly`, `SameSite=Lax` e `Secure` em HTTPS;
- somente o hash do token de sessão é armazenado no banco;
- redefinições revogam todas as sessões anteriores e trocam o código de recuperação;
- tentativas de autenticação são limitadas por janela de tempo;
- contas antigas exigem `LEGACY_ACCOUNT_CLAIM_SECRET` para o primeiro vínculo de senha;
- em ambiente local, o código de ativação de desenvolvimento é `DESENVOLVIMENTO-LOCAL`.

O código de recuperação é exibido uma única vez após cadastro ou redefinição. Ele deve ser guardado em local seguro.

## Isolamento familiar

O servidor resolve a família a partir da sessão e da associação ativa em `household_members`. Todas as consultas e alterações financeiras incluem o `household_id` dessa associação. Convites utilizam códigos aleatórios, armazenados apenas como hash, e expiram em sete dias.

## Comandos

- `npm run dev`: servidor local na porta 5173;
- `npm run build`: compilação de produção;
- `npx tsc --noEmit`: verificação de tipos;
- `node --test tests/*.test.mjs`: testes de banco e autenticação;
- `npm run db:generate`: cria uma nova migração após alterações de esquema.
