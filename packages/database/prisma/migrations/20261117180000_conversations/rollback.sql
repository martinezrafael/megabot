-- Reversão manual (Rollback script). Ordem: filhas antes das pais. As policies, índices e
-- chaves estrangeiras saem junto com as tabelas.
DROP TABLE IF EXISTS "messages";
DROP TABLE IF EXISTS "conversations";
DROP TABLE IF EXISTS "contacts";
