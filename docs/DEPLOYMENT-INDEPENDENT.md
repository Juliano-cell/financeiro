# Implantação independente

## Arquitetura recomendada

A opção de menor mudança é usar uma conta Cloudflare própria com:

- Cloudflare Workers para executar a aplicação;
- Cloudflare Static Assets para os arquivos do navegador;
- Cloudflare D1 para o banco relacional;
- GitHub para versionar o código;
- domínio próprio, opcional, configurado nessa conta.

Essa arquitetura não exige conta, login, chave ou cabeçalho do ChatGPT/OpenAI. A recuperação de senha atual usa um código de recuperação entregue ao usuário; portanto, não exige provedor de e-mail. Um serviço de e-mail poderá ser acrescentado posteriormente sem mudar o banco financeiro.

## O que ainda pertence ao ambiente antigo

- A URL `chatgpt.site`, sua política de acesso e a publicação corrente pertencem ao Sites da conta usada no desenvolvimento.
- O D1 corrente foi criado e é administrado por esse projeto Sites.
- `.openai/hosting.json` registra os identificadores desse ambiente para referência durante a futura extração dos dados. O build padrão não lê esse arquivo.
- O remote Git local chamado `codex-sites`, quando presente, aponta para o repositório de implantação da hospedagem antiga. Ele não faz parte de um clone normal do GitHub e não é necessário para a nova infraestrutura.

## Configuração da conta própria

1. Crie uma conta Cloudflare sob seu controle e clone o repositório do GitHub em uma máquina confiável.
2. Execute `npm ci` (ou `npm run install:ci` neste projeto).
3. Autentique o Wrangler com `npx wrangler login`. Em CI, use um token de API limitado à conta e ao projeto.
4. Crie o banco: `npx wrangler d1 create nossa-casa-financas`.
5. Copie `wrangler.production.jsonc.example` para `wrangler.production.jsonc` e substitua `SUBSTITUA_PELO_ID_DO_SEU_D1` pelo identificador retornado. O arquivo real é ignorado pelo Git.
6. Execute `npm run check:independent`, `npm run typecheck`, `npm test` e `npm run build`.
7. Aplique somente no banco novo: `npm run db:migrate:independent`.
8. Antes de importar usuários antigos, configure um segredo temporário com `npx wrangler secret put LEGACY_ACCOUNT_CLAIM_SECRET --config wrangler.production.jsonc`.
9. Importe e valide os dados conforme `DATA-MIGRATION.md`.
10. Publique com `npm run deploy:independent` e configure o domínio próprio, se houver.
11. Depois que as contas antigas forem vinculadas e verificadas, remova o segredo temporário da nova infraestrutura.

Nenhum desses comandos deve apontar para o banco antigo. Confirme sempre o `database_id` antes de executar migrações ou importações.

## Variáveis e credenciais

| Item | Onde é usado | Obrigatório |
| --- | --- | --- |
| `LEGACY_ACCOUNT_CLAIM_SECRET` | Segredo de runtime para o primeiro vínculo de contas importadas | Temporário durante a migração |
| `CLOUDFLARE_API_TOKEN` | Automação/CI de build, migração e deploy | Somente em CI |
| `CLOUDFLARE_ACCOUNT_ID` | Seleção da conta em automações que não consigam inferi-la | Conforme o ambiente |
| `database_id` | Binding `DB` em `wrangler.production.jsonc` | Sim |

Nunca salve valores reais no GitHub. O arquivo `.env.example` documenta apenas o nome do segredo da aplicação.

## Reconstrução a partir de `C:\projeto`

O projeto pode ser compilado, testado e executado integralmente a partir dessa pasta. Para publicação, a única informação externa necessária é a credencial da conta Cloudflare própria e o identificador do novo D1. O banco e os segredos não são parte do código e precisam ser provisionados/restaurados separadamente.
