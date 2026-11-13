'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// Para adicionar uma tela: crie a pasta em app/(app)/, liste aqui e no matcher do middleware.
const ITEMS = [
  { href: '/dashboard', label: 'Início' },
  { href: '/settings', label: 'Conta' },
];

export function AppNav() {
  const pathname = usePathname();

  return (
    <>
      {ITEMS.map((item) => {
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
