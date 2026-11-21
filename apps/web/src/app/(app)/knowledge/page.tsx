import { redirect } from 'next/navigation';
import { AutoRefresh } from '@/components/auto-refresh';
import { KnowledgeAddForms } from '@/components/knowledge-add-forms';
import { KnowledgeSourcesTable } from '@/components/knowledge-sources-table';
import { apiOptions } from '@/lib/api-options';
import { fetchKnowledgeLimits, fetchKnowledgeSources } from '@/lib/knowledge';
import { hasWorkInProgress } from '@/lib/knowledge-format';
import { getMe } from '@/lib/server-session';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Base de conhecimento · Megabot' };

/**
 * Base de conhecimento: o que a empresa ensina ao assistente.
 * Mostra as fontes com situação e progresso e, enquanto algo está sendo processado, atualiza sozinha.
 */
export default async function KnowledgePage() {
  const me = await getMe();
  if (!me) redirect('/sign-in');

  const options = await apiOptions();
  const [sources, limits] = await Promise.all([
    fetchKnowledgeSources(options),
    fetchKnowledgeLimits(options),
  ]);

  if (sources.status !== 'ok' || limits.status !== 'ok') {
    return (
      <section>
        <h1>Base de conhecimento</h1>
        <p className="notice">
          Não foi possível carregar a base agora. Atualize a página em alguns instantes.
        </p>
      </section>
    );
  }

  return (
    <section>
      <h1>Base de conhecimento</h1>
      <p className="subtitle">
        O assistente responde com base nestes conteúdos. Envie arquivos, importe páginas do site ou
        cole textos.
      </p>

      <KnowledgeAddForms limits={limits.data} />

      <h2>Fontes</h2>
      {hasWorkInProgress(sources.data) ? <AutoRefresh seconds={10} /> : null}
      <KnowledgeSourcesTable sources={sources.data} />
    </section>
  );
}
