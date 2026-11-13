import type { ReactNode } from 'react';
import type { Me } from '@/lib/me';

const ROLE_LABEL: Record<string, string> = {
  OWNER: 'Proprietário',
  ADMIN: 'Administrador',
  MEMBER: 'Membro',
};

/**
 * Estrutura visual das telas autenticadas (cabeçalho + navegação + conteúdo).
 * É um componente "burro" (só recebe dados e slots), por isso pode ser testado
 * sem subir o Next. A navegação e o botão de sair entram como slots.
 */
export function AppShell({
  me,
  nav,
  actions,
  children,
}: {
  me: Me;
  nav: ReactNode;
  actions: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="shell">
      <header className="shell-header">
        <strong className="shell-brand">Megabot</strong>
        <nav aria-label="Principal" className="shell-nav">
          {nav}
        </nav>
        <div className="shell-user">
          <span className="shell-user-name">{me.user.name}</span>
          {me.tenant ? (
            <span className="badge">{ROLE_LABEL[me.tenant.role] ?? me.tenant.role}</span>
          ) : null}
          {actions}
        </div>
      </header>
      <main className="shell-main">{children}</main>
    </div>
  );
}
