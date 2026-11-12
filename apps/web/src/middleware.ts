import { NextResponse, type NextRequest } from 'next/server';
import { getSessionCookie } from 'better-auth/cookies';

/**
 * Primeira barreira: se não existe cookie de sessão, manda para o login.
 * Isto é só uma checagem rápida (otimista). A validação real acontece no
 * layout autenticado (app/(app)/layout.tsx) via getMe() e na API (AuthGuard).
 */
export function middleware(request: NextRequest) {
  if (!getSessionCookie(request)) {
    const url = new URL('/sign-in', request.url);
    url.searchParams.set('next', request.nextUrl.pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

// Toda rota nova dentro de app/(app)/ deve ser listada aqui.
export const config = {
  matcher: ['/dashboard/:path*', '/settings/:path*'],
};
