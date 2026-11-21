-- Desfaz 20261121120000_knowledge_base.
-- ATENÇÃO: apaga as fontes e todos os trechos/embeddings da base de conhecimento.
-- A extensão "vector" NÃO é removida de propósito: outra coisa pode estar usando, e
-- DROP EXTENSION apagaria qualquer coluna vector que exista no banco.
DROP TABLE IF EXISTS "knowledge_chunks";
DROP TABLE IF EXISTS "knowledge_sources";
