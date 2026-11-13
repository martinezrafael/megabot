'use client';

/** Se qualquer tela autenticada falhar, mostramos isto em vez de uma tela em branco. */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section>
      <h1>Algo deu errado</h1>
      <p className="subtitle">Não foi possível carregar esta tela. Tente novamente.</p>
      {error.digest ? <p className="subtitle">Código do erro: {error.digest}</p> : null}
      <button type="button" className="primary" onClick={reset}>
        Tentar de novo
      </button>
    </section>
  );
}
