import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppShell } from '../src/components/app-shell';
import type { Me } from '../src/lib/me';

const ME: Me = {
  user: { id: 'u1', email: 'ana@exemplo.com', name: 'Ana Souza', image: null, emailVerified: true },
  tenant: { id: 't1', role: 'OWNER' },
};

function render(me: Me) {
  return renderToStaticMarkup(
    <AppShell me={me} nav={<a href="/dashboard">Início</a>} actions={<button>Sair</button>}>
      <h1>Conteúdo da página</h1>
    </AppShell>,
  );
}

describe('Layout autenticado (AppShell)', () => {
  it('mostra marca, navegação, usuário, papel, ações e o conteúdo da página', () => {
    const html = render(ME);

    assert.match(html, /Megabot/);
    assert.match(html, /<nav aria-label="Principal"[^>]*><a href="\/dashboard">Início<\/a><\/nav>/);
    assert.match(html, /Ana Souza/);
    assert.match(html, /Proprietário/);
    assert.match(html, /<button>Sair<\/button>/);
    assert.match(html, /<main class="shell-main"><h1>Conteúdo da página<\/h1><\/main>/);
  });

  it('traduz os papéis e tolera usuário sem tenant', () => {
    assert.match(render({ ...ME, tenant: { id: 't1', role: 'ADMIN' } }), /Administrador/);
    assert.match(render({ ...ME, tenant: { id: 't1', role: 'MEMBER' } }), /Membro/);

    const semTenant = render({ ...ME, tenant: null });
    assert.ok(!semTenant.includes('badge'));
    assert.match(semTenant, /Ana Souza/);
  });

  it('escapa HTML do nome (sem XSS)', () => {
    const html = render({ ...ME, user: { ...ME.user, name: '<script>alert(1)</script>' } });
    assert.ok(!html.includes('<script>'));
    assert.match(html, /&lt;script&gt;/);
  });
});
