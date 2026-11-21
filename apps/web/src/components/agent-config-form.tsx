'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { apiRequest } from '@/lib/api-browser';
import type { AgentConfig, AgentConfigOptions } from '@/lib/agent-config';

/**
 * Formulário do agente: nome, tom, apresentação, ferramentas e regras.
 *
 * Cada "Salvar" cria uma VERSÃO nova na API (nada é sobrescrito), então o botão não precisa de
 * confirmação: dá para voltar atrás pelo histórico, logo abaixo na mesma tela.
 */
export function AgentConfigFormPanel(props: { config: AgentConfig; options: AgentConfigOptions }) {
  const router = useRouter();
  return <AgentConfigForm {...props} onSaved={() => router.refresh()} />;
}

/**
 * O formulário em si. Não usa o router (quem usa é o painel acima), então é renderizável e
 * testável fora do Next.
 */
export function AgentConfigForm({
  config,
  options,
  onSaved,
}: {
  config: AgentConfig;
  options: AgentConfigOptions;
  /** Chamado depois de salvar, para a tela recarregar com o que a API gravou. */
  onSaved?: () => void;
}) {
  const [name, setName] = useState(config.name);
  // O tipo gerado do contrato restringe o tom às quatro opções; o catálogo vem da API como
  // string, então a conversão acontece num lugar só, aqui.
  type Tone = AgentConfig['tone'];
  const [tone, setTone] = useState<Tone>(config.tone);
  const [greeting, setGreeting] = useState(config.greeting);
  const [tools, setTools] = useState<string[]>(config.tools);
  // Uma linha vazia no fim deixa a pessoa começar a digitar sem clicar em "Adicionar regra".
  const [rules, setRules] = useState<string[]>(config.rules.length > 0 ? config.rules : ['']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  /**
   * Quando a versão no ar muda por FORA deste formulário — é o caso do rollback, feito no
   * histórico logo abaixo —, o servidor renderiza de novo, mas o estado do React continua com o
   * que estava na tela. Sem isto, restaurar a versão 1 deixava o formulário mostrando o texto da
   * versão antiga: a tela mentia sobre o que o atendimento estava usando.
   *
   * É o padrão de "ajustar estado quando a prop muda", durante a renderização (e não num efeito):
   * reage na hora, e preserva a mensagem de sucesso do último salvamento.
   */
  const [sincronizada, setSincronizada] = useState(config.version);
  // MAIOR, não "diferente": ao salvar, o formulário já sabe o número da versão nova antes de a
  // tela recarregar, e por um instante a prop ainda traz a versão ANTIGA. Comparar por diferença
  // fazia o formulário voltar para o conteúdo velho nesse intervalo.
  if (config.version > sincronizada) {
    setSincronizada(config.version);
    setName(config.name);
    setTone(config.tone);
    setGreeting(config.greeting);
    setTools(config.tools);
    setRules(config.rules.length > 0 ? config.rules : ['']);
    setError(null);
    // A mensagem de sucesso é do ÚLTIMO salvamento feito aqui. Se a versão mudou por fora (um
    // rollback no histórico), ela ficaria mentindo — "salvo como versão 2" ao lado de "no ar:
    // versão 3". Some. Quando a mudança é deste formulário, o save() abaixo já sincronizou o
    // número antes, então este bloco não roda e a mensagem fica.
    setSuccess(null);
  }

  const toggleTool = (key: string) =>
    setTools((atual) => (atual.includes(key) ? atual.filter((k) => k !== key) : [...atual, key]));

  const changeRule = (index: number, value: string) =>
    setRules((atual) => atual.map((rule, i) => (i === index ? value : rule)));

  const removeRule = (index: number) =>
    setRules((atual) => {
      const resto = atual.filter((_, i) => i !== index);
      return resto.length > 0 ? resto : [''];
    });

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSuccess(null);

    const result = await apiRequest<AgentConfig>('/agent-config', {
      method: 'PUT',
      json: { name, tone, greeting, tools, rules },
    });

    setBusy(false);
    if (!result.ok || !result.data) {
      return setError(result.error ?? 'Não foi possível salvar.');
    }
    // Sincroniza ANTES de avisar a tela: o recarregamento vai trazer esta mesma versão, e assim o
    // bloco de sincronização não apaga a mensagem de sucesso que acabou de ser posta.
    setSincronizada(result.data.version);
    setSuccess(`Salvo como versão ${result.data.version}. Já está valendo no atendimento.`);
    // Recarrega a tela (histórico incluído) com o que a API gravou.
    onSaved?.();
  }

  const regrasPreenchidas = rules.filter((rule) => rule.trim()).length;

  return (
    <form onSubmit={save} className="card">
      <label htmlFor="agent-name">Nome do assistente</label>
      <input
        id="agent-name"
        name="name"
        value={name}
        maxLength={options.maxNameLength}
        required
        onChange={(event) => setName(event.target.value)}
      />
      <p className="muted">É assim que ele se identifica na conversa.</p>

      <fieldset>
        <legend>Tom da conversa</legend>
        {options.tones.map((option) => (
          <label key={option.key} className="option">
            <input
              type="radio"
              name="tone"
              value={option.key}
              checked={tone === option.key}
              onChange={() => setTone(option.key as Tone)}
            />
            <span>
              {option.label}
              <span className="muted">{option.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <label htmlFor="agent-greeting">Apresentação</label>
      <textarea
        id="agent-greeting"
        name="greeting"
        value={greeting}
        rows={3}
        maxLength={options.maxGreetingLength}
        required
        onChange={(event) => setGreeting(event.target.value)}
      />
      <p className="muted">
        Primeira mensagem da conversa. {greeting.length}/{options.maxGreetingLength} caracteres.
      </p>

      <fieldset>
        <legend>Ferramentas</legend>
        {options.tools.map((tool) => {
          const indisponivel = tool.status !== 'disponivel';
          return (
            <label key={tool.key} className="option">
              <input
                type="checkbox"
                name="tools"
                value={tool.key}
                checked={tools.includes(tool.key)}
                disabled={indisponivel}
                onChange={() => toggleTool(tool.key)}
              />
              <span>
                {tool.label} {indisponivel ? <span className="badge">em breve</span> : null}
                <span className="muted">{tool.description}</span>
              </span>
            </label>
          );
        })}
        <p className="muted">
          As marcadas como “em breve” ainda não existem no produto, então não dá para ligá-las — a
          configuração não promete ao cliente o que o bot não sabe fazer.
        </p>
      </fieldset>

      <fieldset>
        <legend>Regras de atendimento</legend>
        {rules.map((rule, index) => (
          // A chave é o índice de propósito: a lista é ordenada e editável por posição.
          <div key={`regra-${index}`} className="rule-row">
            <input
              aria-label={`Regra ${index + 1}`}
              value={rule}
              maxLength={options.maxRuleLength}
              placeholder="Ex.: nunca ofereça desconto por conta própria."
              onChange={(event) => changeRule(index, event.target.value)}
            />
            <button
              type="button"
              className="link-button"
              onClick={() => removeRule(index)}
              aria-label={`Remover regra ${index + 1}`}
            >
              Remover
            </button>
          </div>
        ))}
        <button
          type="button"
          className="link-button"
          disabled={rules.length >= options.maxRules}
          onClick={() => setRules((atual) => [...atual, ''])}
        >
          Adicionar regra
        </button>
        <p className="muted">
          {regrasPreenchidas} de no máximo {options.maxRules}. Linhas em branco são descartadas.
        </p>
      </fieldset>

      {error ? <p className="error">{error}</p> : null}
      {success ? <p className="success">{success}</p> : null}

      <div className="actions">
        <button type="submit" disabled={busy}>
          {busy ? 'Salvando…' : 'Salvar'}
        </button>
        <span className="muted">
          {config.version === 0
            ? 'Nada salvo ainda: estes são os valores padrão.'
            : `No ar: versão ${config.version}.`}
        </span>
      </div>
    </form>
  );
}
