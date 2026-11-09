-- Criar o usuário da aplicação com permissão de criação de shadow database para o Prisma
CREATE USER megabot_app WITH PASSWORD 'megabot_pass' CREATEDB;

-- Conceder privilégios totais ao usuário no banco megabot
GRANT ALL PRIVILEGES ON DATABASE megabot TO megabot_app;

-- Conectar ao banco e ajustar privilégios no schema public
\c megabot;
GRANT ALL ON SCHEMA public TO megabot_app;
ALTER SCHEMA public OWNER TO megabot_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO megabot_app;