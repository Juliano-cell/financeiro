import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const failures = [];

function requireFile(relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!existsSync(absolutePath)) failures.push(`Arquivo obrigatório ausente: ${relativePath}`);
  return absolutePath;
}

function sourceFiles(relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!existsSync(absolutePath)) return [];
  if (statSync(absolutePath).isFile()) return [absolutePath];
  return readdirSync(absolutePath, { withFileTypes: true }).flatMap((entry) => sourceFiles(path.join(relativePath, entry.name)));
}

for (const file of [
  "package.json",
  "package-lock.json",
  "vite.config.ts",
  "wrangler.production.jsonc.example",
  "db/schema.ts",
  "db/index.ts",
  "drizzle/0000_family_finance.sql",
  "drizzle/0001_sharp_barracuda.sql",
  "app/api/auth/route.ts",
  "app/api/migration-export/route.ts",
]) requireFile(file);

const applicationFiles = ["app", "db", "lib", "vite.config.ts"].flatMap(sourceFiles).filter((file) => /\.(?:ts|tsx|js|mjs)$/u.test(file));
for (const file of applicationFiles) {
  const contents = readFileSync(file, "utf8");
  if (/chatgpt|oai-authenticated-user|chatgpt\.site/iu.test(contents)) failures.push(`Dependência ChatGPT encontrada em ${path.relative(root, file)}`);
}

const viteConfig = readFileSync(path.join(root, "vite.config.ts"), "utf8");
if (/\.openai\/|hosting\.json|sites-vite-plugin/u.test(viteConfig)) failures.push("O build padrão ainda depende da configuração do Sites.");
const packageAndInstall = ["package.json", "scripts/install-ci.mjs"].map((file) => readFileSync(path.join(root, file), "utf8")).join("\n");
if (/sites-env|sites-vite-plugin|hosting\.json/u.test(packageAndInstall)) failures.push("Um comando padrão ainda depende de um auxiliar do Sites.");
const deploymentExample = readFileSync(path.join(root, "wrangler.production.jsonc.example"), "utf8");
if (!/"binding"\s*:\s*"DB"/u.test(deploymentExample)) failures.push("A configuração independente não declara o binding D1 DB.");

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Projeto pronto para build e implantação sem login ou hospedagem ChatGPT.");
  console.log("O manifesto .openai/hosting.json permanece apenas como referência temporária para a futura migração do banco atual.");
}
