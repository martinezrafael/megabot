# 🚀 MegaBot — Setup do Ambiente Local

Este repositório contém o ecossistema do **MegaBot** (`api`, `worker`, `web`). Siga o passo a passo abaixo para configurar e executar todo o ambiente de desenvolvimento local do zero em menos de 10 minutos.

---

## 📋 Pré-requisitos

Certifique-se de ter as seguintes ferramentas instaladas em seu ambiente:

- **Node.js**: v20 ou superior
- **pnpm**: v9 ou superior (`npm i -g pnpm`)
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

Crie o arquivo `.env` a partir do modelo de exemplo:

```bash
cp .env.example .env

```

> 💡 **Nota:** Abra o arquivo `.env` gerado e insira suas chaves de API locais / desenvolvimento conforme necessário.

### 3. Subir os serviços locais (PostgreSQL com `pgvector`)

Suba o container do banco de dados utilizando o Docker Compose:

```bash
pnpm db:up

```

O container `megabot_postgres` estará rodando e acessível na porta `5432` com a extensão `pgvector` pré-instalada e pronta para uso.

### 4. Executar as migrações do banco (se houver)

```bash
pnpm db:migrate

```

### 5. Rodar a aplicação em modo desenvolvimento

Execute o comando global orquestrado pelo Turborepo para iniciar todos os apps (`api`, `worker`, `web`):

```bash
pnpm dev

```

---

## 🔗 Configuração de Webhooks Locais (Túnel HTTP)

Para receber webhooks de serviços externos (WhatsApp API, Meta, Stripe, etc.) diretamente na sua máquina local:

1. **Inicie o túnel apontando para a porta da API (`3000`):**

```bash
pnpm tunnel

```

2. **Copie a URL HTTPS pública gerada** (exemplo: `https://abcd-123.ngrok-free.app`).
3. **Atualize a variável no seu `.env`:**

```env
WEBHOOK_BASE_URL=[https://abcd-123.ngrok-free.app](https://abcd-123.ngrok-free.app)

```

4. Use essa URL nos painéis de desenvolvedor/webhooks das plataformas externas apontando para o seu endpoint local (ex: `https://abcd-123.ngrok-free.app/webhooks/whatsapp`).

---

## 🛠️ Comandos Úteis

| Comando          | Descrição                                                    |
| ---------------- | ------------------------------------------------------------ |
| `pnpm dev`       | Inicia todos os serviços do monorepo em modo dev             |
| `pnpm build`     | Gera o build de produção de todos os apps e packages         |
| `pnpm lint`      | Executa a verificação do ESLint em todo o workspace          |
| `pnpm typecheck` | Executa a checagem de tipos do TypeScript                    |
| `pnpm format`    | Formata todo o código do repositório via Prettier            |
| `pnpm db:up`     | Sobe o container do banco de dados PostgreSQL (`pgvector`)   |
| `pnpm db:down`   | Encerra o container do banco de dados                        |
| `pnpm db:logs`   | Exibe os logs do container do banco de dados em tempo real   |
| `pnpm db:reset`  | Destrói o banco, limpa os volumes e sobe uma instância limpa |
| `pnpm tunnel`    | Abre o túnel do Ngrok na porta `3000` para testes de webhook |
