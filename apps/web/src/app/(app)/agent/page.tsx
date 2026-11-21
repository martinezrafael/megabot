import { redirect } from 'next/navigation';
import { AgentConfigFormPanel } from '@/components/agent-config-form';
import { AgentVersionHistoryPanel } from '@/components/agent-version-history';
import { apiOptions } from '@/lib/api-options';
import {
  fetchAgentConfig,
  fetchAgentConfigOptions,
  fetchAgentConfigVersions,
} from '@/lib/agent-config';
import { getMe } from '@/lib/server-session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Agente · Megabot' };

/**
 * Configuração do agente (T2.4): como ele se chama, como fala, o que pode fazer e o que não pode.
 * Cada salvamento cria uma versão; o histórico embaixo permite voltar para qualquer uma delas.
 */
export default async function AgentPage() {
  const me = await getMe();
  if (!me) redirect('/sign-in');

  const options = await apiOptions();
  const [config, catalog, history] = await Promise.all([
    fetchAgentConfig(options),
    fetchAgentConfigOptions(options),
    fetchAgentConfigVersions(options, { limit: 20 }),
  ]);

  if (config.status !== 'ok' || catalog.status !== 'ok' || history.status !== 'ok') {
    return (
      <section>
        <h1>Agente</h1>
        <p className="notice">
          Não foi possível carregar a configuração agora. Atualize a página em alguns instantes.
        </p>
      </section>
    );
  }

  return (
    <section>
      <h1>Agente</h1>
      <p className="subtitle">
        Como o assistente se apresenta, em que tom fala, o que ele pode fazer e as regras que
        precisa seguir. Cada vez que você salva, nasce uma versão nova — e dá para voltar a qualquer
        uma delas.
      </p>

      <AgentConfigFormPanel config={config.data} options={catalog.data} />

      <h2>Histórico de versões</h2>
      <AgentVersionHistoryPanel
        versions={history.data.items}
        total={history.data.total}
        activeVersion={history.data.activeVersion}
        options={catalog.data}
      />
    </section>
  );
}
