'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// Para adicionar uma tela: crie a pasta em app/(app)/, liste aqui e no matcher do middleware.
const ITEMS = [
  { href: '/dashboard', label: 'Início' },
  { href: '/knowledge', label: 'Base de conhecimento' },
  { href: '/agent', label: 'Agente' },
  { href: '/settings', label: 'Conta' },
];

const ADMIN_ITEMS = [{ href: '/admin/queues', label: 'Filas' }];

/** `platformAdmin`: itens da equipe Megabot (a API também protege as rotas; isto só esconde o link). */
export function AppNav({ platformAdmin = false }: { platformAdmin?: boolean }) {
  const pathname = usePathname();

  return (
    <>
      {(platformAdmin ? [...ITEMS, ...ADMIN_ITEMS] : ITEMS).map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link key={item.href} href={item.href} aria-current={active ? 'page' : undefined}>
            {item.label}
          </Link>
        );
      })}
    </>
  );
}
