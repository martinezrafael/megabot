import Link from 'next/link';
import { AuthCard } from '@/components/auth-card';

export default function NotFound() {
  return (
    <AuthCard title="Página não encontrada" subtitle="O endereço que você abriu não existe.">
      <p className="footer">
        <Link href="/dashboard">Voltar ao início</Link>
      </p>
    </AuthCard>
  );
}
