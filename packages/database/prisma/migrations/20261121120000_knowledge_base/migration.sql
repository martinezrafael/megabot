-- T2.2 — Base de conhecimento (ingestão)
--
-- Duas tabelas novas, com RLS + FORCE como todas as outras:
--   knowledge_sources: UMA fonte (arquivo enviado, URL importada ou texto colado), com status e progresso.
--   knowledge_chunks:  os trechos extraídos dessa fonte, cada um com seu embedding (pgvector).
--
-- O embedding é um vetor de 1536 dimensões (ADR 0020). Trocar de modelo de embedding para um de
-- outra dimensão exige uma migration nova (ALTER do tipo) e reindexar tudo: é por isso que o
-- tamanho está fixo aqui e a dimensão esperada é exportada pelo pacote database.

-- A extensão vector vem na imagem pgvector/pgvector:pg16 e é habilitada por scripts/init-db.sql,
-- que roda como SUPERUSUÁRIO (docker-entrypoint e CI). As migrations rodam como megabot_app, que
-- não pode criar extensões: por isso aqui a gente só tenta, e se não puder, explica o que fazer.
DO $$
BEGIN
  EXECUTE 'CREATE EXTENSION IF NOT EXISTS vector';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE EXCEPTION USING
      MESSAGE = 'A extensão pgvector ainda não está habilitada neste banco.',
      HINT = 'Rode uma vez como superusuário: docker exec megabot_postgres psql -U postgres -d megabot -c ''CREATE EXTENSION IF NOT EXISTS vector''';
END
$$;

-- CreateTable
CREATE TABLE "knowledge_sources" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    -- 0 a 100: o que a tela mostra na barra de progresso.
    "progress" SMALLINT NOT NULL DEFAULT 0,
    -- Origem (exatamente uma das três, ver knowledge_sources_origin_check).
    "source_url" TEXT,
    "storage_key" TEXT,
    "raw_text" TEXT,
    "file_name" TEXT,
    "mime_type" TEXT,
    "byte_size" INTEGER,
    -- Resultado da última ingestão.
    "checksum" TEXT,
    "char_count" INTEGER,
    "chunk_count" INTEGER NOT NULL DEFAULT 0,
    "embedding_model" TEXT,
    "embedding_dimensions" SMALLINT,
    "last_ingested_at" TIMESTAMPTZ(6),
    -- Erro legível para quem usa a tela (nunca um stack trace).
    "error_code" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "knowledge_sources_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "knowledge_sources_kind_check" CHECK ("kind" IN ('upload', 'url', 'text')),
    CONSTRAINT "knowledge_sources_status_check" CHECK ("status" IN ('pending', 'processing', 'ready', 'failed')),
    CONSTRAINT "knowledge_sources_progress_check" CHECK ("progress" BETWEEN 0 AND 100),
    CONSTRAINT "knowledge_sources_title_check" CHECK (length(btrim("title")) > 0),
    -- Cada tipo de fonte tem UMA origem; as outras duas ficam nulas.
    CONSTRAINT "knowledge_sources_origin_check" CHECK (
      ("kind" = 'upload' AND "storage_key" IS NOT NULL AND "source_url" IS NULL AND "raw_text" IS NULL)
      OR ("kind" = 'url' AND "source_url" IS NOT NULL AND "storage_key" IS NULL AND "raw_text" IS NULL)
      OR ("kind" = 'text' AND "raw_text" IS NOT NULL AND "storage_key" IS NULL AND "source_url" IS NULL)
    ),
    -- Falhou <=> tem código de erro (e o contrário também: quem está pronto não carrega erro antigo).
    CONSTRAINT "knowledge_sources_error_check" CHECK (("status" = 'failed') = ("error_code" IS NOT NULL))
);

-- CreateTable
CREATE TABLE "knowledge_chunks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    -- Ordem do trecho dentro da fonte (0, 1, 2...): é como a tela e o agente os apresentam.
    "position" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "char_count" INTEGER NOT NULL,
    -- Título/seção de onde o trecho saiu (ex.: o <h2> do site, o nome da aba da planilha).
    "heading" TEXT,
    "embedding" vector(1536),
    "embedding_model" TEXT,
    -- true = o conteúdo mudou (edição manual) e o embedding ainda é o antigo.
    "embedding_stale" BOOLEAN NOT NULL DEFAULT false,
    -- true = alguém editou este trecho à mão; uma reingestão completa o sobrescreve.
    "edited" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "knowledge_chunks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "knowledge_chunks_position_check" CHECK ("position" >= 0),
    CONSTRAINT "knowledge_chunks_content_check" CHECK (length(btrim("content")) > 0),
    CONSTRAINT "knowledge_chunks_char_count_check" CHECK ("char_count" > 0)
);

-- CreateIndex
-- Necessário para a chave estrangeira composta (tenant_id, source_id) dos trechos.
CREATE UNIQUE INDEX "knowledge_sources_tenant_id_id_key" ON "knowledge_sources"("tenant_id", "id");

-- CreateIndex
-- Lista da tela: fontes do tenant, da mais recente para a mais antiga.
CREATE INDEX "knowledge_sources_tenant_id_created_at_idx" ON "knowledge_sources"("tenant_id", "created_at");

-- CreateIndex
-- "o que está processando/falhou?" (tela e métricas).
CREATE INDEX "knowledge_sources_tenant_id_status_idx" ON "knowledge_sources"("tenant_id", "status");

-- CreateIndex
-- Uma fonte não repete posição: é o que torna a regravação dos trechos idempotente.
CREATE UNIQUE INDEX "knowledge_chunks_tenant_id_source_id_position_key" ON "knowledge_chunks"("tenant_id", "source_id", "position");

-- CreateIndex
-- Trechos pendentes de reembedding depois de uma edição manual.
CREATE INDEX "knowledge_chunks_tenant_id_embedding_stale_idx" ON "knowledge_chunks"("tenant_id", "embedding_stale") WHERE "embedding_stale";

-- CreateIndex
-- Busca por similaridade (distância de cosseno). HNSW: rápido para buscar, barato para manter.
-- Linhas com embedding NULL (ainda não processadas) simplesmente não entram no índice.
CREATE INDEX "knowledge_chunks_embedding_idx" ON "knowledge_chunks" USING hnsw ("embedding" vector_cosine_ops);

-- AddForeignKey
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Composta: é impossível ligar um trecho do tenant A a uma fonte do tenant B.
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_tenant_id_source_id_fkey" FOREIGN KEY ("tenant_id", "source_id") REFERENCES "knowledge_sources"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- RLS (usa current_tenant_id(), criada na migration enable_rls)
-- ---------------------------------------------------------------------------

ALTER TABLE "knowledge_sources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_sources" FORCE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_chunks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_chunks" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_policy ON "knowledge_sources";
CREATE POLICY tenant_isolation_policy ON "knowledge_sources"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

DROP POLICY IF EXISTS tenant_isolation_policy ON "knowledge_chunks";
CREATE POLICY tenant_isolation_policy ON "knowledge_chunks"
  FOR ALL
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
