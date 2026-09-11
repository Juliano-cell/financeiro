# Migração de dados sem perda

## Situação atual

O banco remoto atual é um D1 gerenciado pelo projeto Sites da hospedagem antiga. O repositório contém o esquema e as migrações, mas não contém uma cópia dos dados, a credencial da conta antiga nem um banco remoto que possa ser administrado pela conta Cloudflare nova. A extração precisa ser feita enquanto ainda existir acesso autorizado ao ambiente antigo.

Não é possível acessar esse D1 antigo apenas autenticando o Wrangler na conta Cloudflare nova. O procedimento seguro é exportar uma cópia lógica, criar outro banco e importar a cópia no destino, mantendo a origem intacta.

## Exportação preparada

O endpoint autenticado `GET /api/migration-export` gera um JSON da família ativa. Ele:

- exige sessão da própria aplicação;
- permite exportação apenas ao responsável (`owner`) da família;
- inclui usuários relacionados, família, membros, contas, categorias, subcategorias, transações e auditoria;
- não inclui hashes de senha, códigos de recuperação, sessões ou limites de tentativa.

A ausência desses dados de autenticação é proposital: tokens e credenciais não devem ser transportados entre ambientes. Os usuários importados vinculam uma nova senha usando o mesmo e-mail e o segredo temporário de ativação, preservando o identificador e a associação familiar.

Para extrair o banco atual no futuro, será necessário fazer uma publicação privada e completa deste código no ambiente antigo, ativar a conta do responsável e acessar `/api/migration-export`. Esta preparação não publicou nem alterou a versão atualmente hospedada.

## Procedimento futuro

1. Mantenha o site antigo privado e exporte um arquivo para cada família enquanto ainda há acesso autorizado.
2. Pause novas alterações financeiras durante a janela final de migração.
3. Guarde os JSONs criptografados fora do GitHub e preserve uma cópia imutável.
4. Crie o D1 novo na conta própria e aplique `0000_family_finance.sql` e `0001_sharp_barracuda.sql` por meio de `npm run db:migrate:independent`.
5. Converta cada backup em SQL sem sobrescrever arquivos existentes:

   ```powershell
   node scripts/backup-to-sql.mjs C:\caminho\backup.json C:\projeto\migration-import.sql
   ```

6. Importe no banco novo:

   ```powershell
   npx wrangler d1 execute DB --remote --config wrangler.production.jsonc --file C:\projeto\migration-import.sql
   ```

7. Compare, por família, a quantidade de membros, contas, categorias e transações, além dos totais financeiros da origem e do destino.
8. Configure `LEGACY_ACCOUNT_CLAIM_SECRET` no destino. Cada usuário antigo cria a senha própria usando o mesmo e-mail importado e esse código temporário.
9. Teste cadastro, entrada, saída, recuperação de senha e acesso com pelo menos duas famílias para confirmar o isolamento.
10. Só depois da conferência, direcione o domínio próprio ao novo Worker. Mantenha o ambiente antigo privado e sem escrita por um período de segurança.
11. Remova o segredo de ativação do destino quando todos os usuários antigos tiverem concluído o vínculo.

O conversor recusa formato desconhecido, escapa valores SQL e exclui tabelas de credenciais/sessões. Ele cria o arquivo de saída apenas se ele ainda não existir. O arquivo gerado fica ignorado pelo Git.

## Alternativa com dump administrativo

Se o ambiente antigo disponibilizar posteriormente um dump oficial do D1, ele pode substituir a exportação lógica. Ainda assim, conserve uma cópia original, restaure somente em um banco novo vazio e valide contagens e totais antes da troca. Nunca restaure sobre o banco de origem.
