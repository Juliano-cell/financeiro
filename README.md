# Nossa Casa Finanças

Sistema de controle financeiro familiar construído com Vinext, React, TypeScript e Cloudflare D1.

A aplicação tem autenticação própria e não usa a conta ChatGPT do visitante. O código de execução e o build padrão também não dependem de login ChatGPT nem do domínio `chatgpt.site`. O arquivo `.openai/hosting.json` foi mantido somente como referência temporária do ambiente antigo, necessária para uma futura migração controlada; ele não é lido pelo build padrão.

## Execução local

Requisitos: Node.js 22.13 ou mais recente.

```powershell
npm run install:ci
npm run build
node --import ./scripts/runtime-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_family_finance.sql
node --import ./scripts/runtime-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0001_sharp_barracuda.sql
npm run dev
```

Abra `http://localhost:5173`. Não repita migrações já aplicadas no mesmo banco local.

## Autenticação e isolamento familiar

- Senhas são armazenadas como PBKDF2-SHA-256 com salt individual e 310.000 iterações.
- Cookies de sessão são `HttpOnly`, `SameSite=Lax` e `Secure` em HTTPS; o banco guarda somente o hash do token.
- Redefinições de senha revogam as sessões anteriores e trocam o código de recuperação.
- Contas antigas exigem `LEGACY_ACCOUNT_CLAIM_SECRET` somente no primeiro vínculo de senha.
- A família é resolvida no servidor pela sessão e pela associação ativa em `household_members`; consultas e alterações financeiras filtram por `household_id`.
- Convites usam códigos aleatórios, armazenados somente como hash, e expiram em sete dias.

O código de recuperação é mostrado uma única vez após cadastro ou redefinição e deve ser guardado em local seguro. No ambiente local, o código de ativação de desenvolvimento é `DESENVOLVIMENTO-LOCAL`.

## Hospedagem independente

Os arquivos abaixo preparam uma implantação em uma conta Cloudflare própria:

- `wrangler.production.jsonc`: configuração do Worker e do D1 pessoal selecionado;
- `wrangler.production.jsonc.example`: modelo para uma futura troca de conta ou banco;
- `.env.example`: variáveis da aplicação, sem valores secretos;
- `docs/DEPLOYMENT-INDEPENDENT.md`: serviços, credenciais e procedimento de implantação;
- `docs/DATA-MIGRATION.md`: exportação e migração dos dados sem sobrescrever a origem.

Comandos de validação e implantação:

```powershell
npm run check:independent
npm run typecheck
npm test
npm run build
npm run db:migrate:independent
npm run deploy:independent
```

Os dois últimos comandos só devem ser executados depois de criar `wrangler.production.jsonc` com o banco D1 da conta própria.

## Conteúdo do GitHub

O repositório contém o código-fonte, lockfile, esquema e migrações necessários para reconstruir a aplicação. Por segurança, banco de dados, backups, credenciais, configuração real de produção, dependências instaladas e artefatos de build não são versionados.
