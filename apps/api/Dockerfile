# Step 1: Base com pnpm habilitado via Corepack e PATH configurado
FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PNPM_HOME/bin:$PATH"
RUN corepack enable

# Step 2: Prune para isolar as dependências e pacotes da api
FROM base AS pruner
WORKDIR /app
RUN pnpm setup && pnpm add -g turbo
COPY . .
RUN turbo prune @megabot/api --docker

# Step 3: Instalação de dependências e Build do app
FROM base AS builder
WORKDIR /app

# Copia os manifests de dependência isolados pelo Turbo
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile

# Copia todo o código-fonte extraído e executa o build
COPY --from=pruner /app/out/full/ .
RUN pnpm turbo run build --filter=@megabot/api...

# Step 4: Imagem final de execução (Runner leve e seguro)
FROM base AS runner
WORKDIR /app

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nestjs

COPY --from=builder /app ./

USER nestjs
EXPOSE 3000

ENV NODE_ENV=production

CMD ["pnpm", "--filter", "@megabot/api", "start"]