# API da configuração do agente (T2.4)

Rotas do **tenant logado** (cookie de sessão). O `tenantId` nunca vem do corpo nem da URL: sai da sessão, então
ninguém consegue ler ou mexer na configuração de outra empresa. Contrato completo no OpenAPI (`/docs`, tag
`agent-config`).

A tabela é **append-only**: salvar cria a versão seguinte e restaurar também. **A versão que o agente usa é
sempre a de maior número** — não existe flag de "ativa" para ficar inconsistente, e nenhuma versão é
sobrescrita ou apagada.

| Rota                                            | O que faz                                                                               |
| ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| `GET /agent-config/options`                     | Tons, catálogo de ferramentas e limites dos campos (a tela monta o formulário com isto) |
| `GET /agent-config`                             | A configuração no ar (ou os padrões, com `version: 0`)                                  |
| `PUT /agent-config`                             | Salva — **cria uma versão nova**                                                        |
| `GET /agent-config/versions`                    | Histórico, da mais nova para a mais antiga                                              |
| `GET /agent-config/versions/{version}`          | O conteúdo de uma versão                                                                |
| `POST /agent-config/versions/{version}/restore` | Rollback: copia a versão para uma versão nova                                           |

## `GET /agent-config`

```json
{
  "version": 3,
  "name": "Bia",
  "tone": "amigavel",
  "greeting": "Oi! Eu sou a Bia, da Loja Modelo. Como posso ajudar?",
  "tools": ["base_conhecimento"],
  "rules": ["Nunca prometa prazo que não está na base."],
  "createdByName": "Dona A",
  "restoredFromVersion": 1,
  "createdAt": "2026-11-21T12:00:00.000Z",
  "active": true
}
```

Empresa que **nunca salvou** recebe os valores padrão com `version: 0` e `createdAt: null` — a tela já abre o
formulário preenchido com algo razoável, em vez de vazio. `restoredFromVersion` só vem preenchido quando a
versão nasceu de um rollback.

## `PUT /agent-config`

```json
{
  "name": "Bia",
  "tone": "amigavel",
  "greeting": "Oi! Eu sou a Bia, da Loja Modelo.",
  "tools": ["base_conhecimento"],
  "rules": ["Nunca prometa prazo que não está na base.", ""]
}
```

| Status | Quando                                                                        |
| ------ | ----------------------------------------------------------------------------- |
| 200    | Salvo; o corpo é a versão nova (já ativa)                                     |
| 400    | Campo inválido, tom inexistente, ferramenta inexistente ou ainda indisponível |
| 401    | Sem sessão                                                                    |
| 403    | Conta sem empresa associada                                                   |
| 409    | Outra pessoa salvou no mesmo instante (recarregue e tente de novo)            |

Regras em branco são **descartadas** (a tela deixa abrir uma linha e digitar depois); espaços sobrando saem de
`name`, `greeting` e de cada regra; ferramenta repetida entra uma vez só.

Limites: `name` 80 caracteres, `greeting` 1000, até 30 regras de 500 caracteres cada. Os números vêm de
`GET /agent-config/options`, para a tela não ter a sua própria cópia deles.

## `GET /agent-config/versions?limit=20&offset=0`

```json
{ "total": 3, "activeVersion": 3, "items": [{ "version": 3, "active": true }] }
```

`total` é também o número da última versão: a numeração é sequencial e sem buracos.

## `POST /agent-config/versions/{version}/restore`

Copia o conteúdo da versão informada para uma versão **nova**, que entra no ar. O histórico não é reescrito: o
rollback aparece nele com `restoredFromVersion` apontando para a origem.

| Status | Quando                                     |
| ------ | ------------------------------------------ |
| 201    | Versão nova criada; o corpo é ela          |
| 400    | Versão fora do formato (não é inteiro ≥ 1) |
| 404    | A versão não existe nesta empresa          |
| 409    | Essa versão **já é** a que está no ar      |

## Ferramentas

`GET /agent-config/options` devolve o catálogo:

```json
{
  "key": "base_conhecimento",
  "label": "Consultar a base de conhecimento",
  "description": "Busca nos conteúdos que a empresa cadastrou...",
  "status": "disponivel"
}
```

`status: "em_breve"` é ferramenta que está no mapa mas **ainda não existe no produto** — e por isso o `PUT`
recusa habilitá-la (400). A configuração não promete ao cliente um comportamento que o bot não tem. Quando a
ferramenta passar a existir, basta trocar o `status` no catálogo
(`packages/database/src/agent-config.ts`): nem migration, nem mudança de contrato.

## Logs e métricas

- `agent_config.saved` (com `version`, `tone`, e as **contagens** de ferramentas e regras) e
  `agent_config.restored` (com `version` e `restored_from_version`).
- Métricas: `agent_config_saves_total{outcome,version}` e `agent_config_restores_total{outcome,version}`,
  com `outcome` em `saved | rejected | conflict`.
- Todos com `tenant_id`. **Nunca** sai conteúdo da configuração no log: nome, apresentação e regras são texto
  do cliente, e um teste falha se qualquer um deles aparecer.
