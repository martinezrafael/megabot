# 🚀 MegaBot: Setup do Ambiente Local

Este repositório contém o ecossistema do **MegaBot** (`api`, `worker`, `web`). Siga o passo a passo abaixo para configurar e executar o ambiente de desenvolvimento local do zero.

---

## 📋 Pré-requisitos

- **Node.js**: v20.12 ou superior
- **pnpm**: v10 (`npm i -g pnpm@10`)
- **Docker** e **Docker Compose**
- **ngrok** (opcional, para receber webhooks locais)

---

## ⚡ Passo a Passo de Setup Local

### 1. Clonar o repositório e instalar dependências

```bash
git clone <URL_DO_REPOSITORIO>
cd megabot
pnpm install
```

### 2. Configurar variáveis de ambiente

```bash
cp .env.example .env
```

> 💡 Abra o `.env` e insira suas chaves de API de desenvolvimento. O `DATABASE_URL` deve usar o usuário `megabot_app` (sem privilégios de superuser). Veja o motivo em [packages/database/README.md](packages/database/README.md).

### 3. Subir o PostgreSQL com `pgvector`

```bash
pnpm db:up
```

O container `megabot_postgres` fica acessível na porta `5432`. Na **primeira** inicialização, o script `scripts/init-db.sql` cria o usuário `megabot_app`.

> ⚠️ O Postgres só executa esse script quando o volume está vazio. Se o container já existia antes do script, rode `pnpm db:reset`.

### 4. Gerar o Prisma Client e aplicar as migrations

```bash
pnpm db:generate
pnpm db:migrate
```

### 5. Rodar a aplicação em modo desenvolvimento

```bash
pnpm dev
```

---

## 🗄️ Banco de dados e multitenancy

O isolamento entre empresas (tenants) é garantido pelo próprio PostgreSQL, com **Row Level Security (RLS)**. Todo acesso a dados de tenant passa pelo helper `withTenant`. Funcionamento, regras, testes e procedimento de rollback estão em [packages/database/README.md](packages/database/README.md).

Os testes de integração usam o banco local. Antes de `pnpm test`, o container deve estar no ar e as migrations aplicadas.

---

## 🔗 Configuração de Webhooks Locais (Túnel HTTP)

1. **Inicie o túnel apontando para a porta da API (`3000`):**

```bash
pnpm tunnel
```

2. **Copie a URL HTTPS pública gerada** (exemplo: `https://abcd-123.ngrok-free.app`).
3. **Atualize a variável no seu `.env`:**

```env
WEBHOOK_BASE_URL=https://abcd-123.ngrok-free.app
```

4. Use essa URL nos painéis de webhooks das plataformas externas, apontando para o seu endpoint local (ex: `https://abcd-123.ngrok-free.app/webhooks/whatsapp`).

---

## 🛠️ Comandos Úteis

| Comando            | Descrição                                                      |
| ------------------ | -------------------------------------------------------------- |
| `pnpm dev`         | Inicia todos os serviços do monorepo em modo dev               |
| `pnpm build`       | Gera o build de produção de todos os apps e packages           |
| `pnpm test`        | Executa os testes (inclui o teste de isolamento entre tenants) |
| `pnpm lint`        | Executa a verificação do ESLint em todo o workspace            |
| `pnpm typecheck`   | Executa a checagem de tipos do TypeScript                      |
| `pnpm format`      | Formata todo o código do repositório via Prettier              |
| `pnpm db:up`       | Sobe o container do PostgreSQL (`pgvector`)                    |
| `pnpm db:down`     | Encerra o container do banco de dados                          |
| `pnpm db:logs`     | Exibe os logs do container do banco em tempo real              |
| `pnpm db:reset`    | Destrói o banco, limpa os volumes e sobe uma instância limpa   |
| `pnpm db:generate` | Gera o Prisma Client                                           |
| `pnpm db:migrate`  | Aplica as migrations pendentes                                 |
| `pnpm tunnel`      | Abre o túnel do ngrok na porta `3000` para testes de webhook   |
