import { lookup as dnsLookup } from 'node:dns/promises';
import { knowledgeError } from './errors';
import {
  DEFAULT_MAX_BYTES,
  detectFormat,
  formatBytes,
  normalizeMimeType,
  type DocumentFormat,
} from './formats';

/**
 * Importação por URL (a seção "Site da empresa" da tela).
 *
 * Aqui o servidor busca um endereço escolhido pelo cliente: é o caminho clássico de um ataque de
 * SSRF ("faz o servidor buscar o que eu não alcanço"). Por isso:
 *  - só http/https, sem usuário:senha na URL;
 *  - o nome é RESOLVIDO e os IPs têm de ser públicos (bloqueia localhost, 10.x, 169.254.169.254...);
 *  - redirecionamentos são seguidos à mão, revalidando cada salto;
 *  - o download tem tempo máximo e tamanho máximo (corta no meio, sem carregar o resto).
 *
 * Limite conhecido: entre a checagem do IP e a conexão, o DNS pode mudar (DNS rebinding). Fechar
 * isso exige conectar no IP já validado (ou um proxy de saída); está registrado na ADR 0020.
 */

export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

export type LookupFn = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export interface FetchRemoteOptions {
  fetch?: typeof fetch;
  lookup?: LookupFn;
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RemoteDocument {
  bytes: Uint8Array;
  /** Tipo declarado pelo servidor, sem parâmetros (`text/html`). */
  mimeType: string;
  charset: string | null;
  format: DocumentFormat;
  /** URL final, depois dos redirecionamentos. */
  finalUrl: string;
  fileName: string | null;
}

/** Valida a forma da URL (sintaxe, esquema, credenciais). Não resolve DNS. */
export function assertHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw knowledgeError(
      'url_invalida',
      `"${raw}" não é um endereço válido. Exemplo: https://suaempresa.com.br/sobre`,
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw knowledgeError('url_invalida', 'Use um endereço http:// ou https://.');
  }
  if (url.username || url.password) {
    throw knowledgeError('url_invalida', 'Não aceitamos endereços com usuário e senha embutidos.');
  }
  if (!url.hostname) throw knowledgeError('url_invalida', 'O endereço não tem domínio.');
  return url;
}

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa'];

/** `true` para IPs que não devem ser alcançados a partir do servidor (rede interna, metadados...). */
export function isPrivateAddress(address: string): boolean {
  const value = address
    .trim()
    .toLowerCase()
    .replace(/^\[|]$/g, '');

  if (value.includes(':')) {
    // IPv6. ::ffff:10.0.0.1 é um IPv4 disfarçado.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
    if (mapped) return isPrivateAddress(mapped[1]!);
    if (value === '::' || value === '::1') return true;
    const head = value.split(':')[0] ?? '';
    if (/^f[cd]/.test(head)) return true; // fc00::/7 (uso local)
    if (/^fe[89ab]/.test(head)) return true; // fe80::/10 (link local)
    return false;
  }

  const parts = value.split('.');
  if (parts.length !== 4) return true; // formato estranho: trata como inseguro
  const [a, b] = parts.map((part) => Number(part));
  if (parts.some((part) => !/^\d{1,3}$/.test(part)) || a === undefined || b === undefined)
    return true;
  if (parts.some((part) => Number(part) > 255)) return true;

  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link local, inclui 169.254.169.254 (metadados de nuvem)
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 e 192.0.2.0/24 (documentação)
  if (a >= 224) return true; // multicast e reservados
  return false;
}

/** Resolve o nome e exige que TODOS os IPs sejam públicos. */
export async function assertPublicHost(url: URL, lookup: LookupFn = defaultLookup): Promise<void> {
  const hostname = url.hostname.toLowerCase().replace(/^\[|]$/g, '');
  if (hostname === 'localhost' || BLOCKED_HOST_SUFFIXES.some((s) => hostname.endsWith(s))) {
    throw knowledgeError('url_bloqueada', 'Esse endereço aponta para a rede interna do servidor.');
  }
  // IP literal: nem precisa de DNS.
  if (/^[\d.]+$/.test(hostname) || hostname.includes(':')) {
    if (isPrivateAddress(hostname)) {
      throw knowledgeError(
        'url_bloqueada',
        'Esse endereço aponta para a rede interna do servidor.',
      );
    }
    return;
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(hostname);
  } catch {
    throw knowledgeError(
      'url_inacessivel',
      `Não consegui encontrar o domínio "${hostname}". Confira o endereço.`,
      true,
    );
  }
  if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw knowledgeError('url_bloqueada', 'Esse endereço aponta para a rede interna do servidor.');
  }
}

const defaultLookup: LookupFn = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

function fileNameFromUrl(url: URL): string | null {
  const last = url.pathname.split('/').filter(Boolean).pop();
  return last && last.includes('.') ? decodeURIComponent(last) : null;
}

async function readWithLimit(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw knowledgeError(
      'arquivo_grande',
      `A página tem ${formatBytes(declared)} e o limite é ${formatBytes(maxBytes)}.`,
    );
  }
  if (!response.body) return new Uint8Array(await response.arrayBuffer());

  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw knowledgeError(
          'arquivo_grande',
          `O conteúdo passou de ${formatBytes(maxBytes)}; o download foi interrompido.`,
        );
      }
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

/** Baixa o documento da URL, com todas as proteções acima. */
export async function fetchRemoteDocument(
  rawUrl: string,
  options: FetchRemoteOptions = {},
): Promise<RemoteDocument> {
  const fetchImpl = options.fetch ?? fetch;
  const lookup = options.lookup ?? defaultLookup;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

  let url = assertHttpUrl(rawUrl);
  let response: Response | undefined;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicHost(url, lookup);

    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      response = await fetchImpl(url.toString(), {
        redirect: 'manual',
        signal,
        headers: {
          // Um user agent honesto: alguns sites bloqueiam quem não se identifica.
          'user-agent': 'MegabotKnowledgeBot/1.0 (+https://megabot.app)',
          accept: 'text/html,text/plain,application/pdf,text/csv,*/*;q=0.8',
          'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8',
        },
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (timeout.aborted) {
        throw knowledgeError(
          'url_inacessivel',
          `O site não respondeu em ${Math.round(timeoutMs / 1000)} segundos. Tente de novo mais tarde.`,
          true,
          error,
        );
      }
      throw knowledgeError(
        'url_inacessivel',
        'Não consegui acessar esse endereço. Confira se ele abre no navegador.',
        true,
        error,
      );
    }

    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      if (hop === MAX_REDIRECTS) {
        throw knowledgeError('url_inacessivel', 'O endereço tem redirecionamentos demais.');
      }
      try {
        url = assertHttpUrl(new URL(location, url).toString());
      } catch {
        throw knowledgeError(
          'url_invalida',
          'O site redirecionou para um endereço que não sei abrir.',
        );
      }
      continue;
    }
    break;
  }

  if (!response)
    throw knowledgeError('url_inacessivel', 'Não consegui acessar esse endereço.', true);

  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    throw knowledgeError(
      'url_erro_http',
      retryable
        ? `O site respondeu ${response.status} (instável ou limitando acessos). Vamos tentar de novo.`
        : `O site respondeu ${response.status}. Confira se o endereço está público (sem login).`,
      retryable,
    );
  }

  const contentType = response.headers.get('content-type');
  const mimeType = normalizeMimeType(contentType) || 'text/html';
  const charset = /charset\s*=\s*"?([\w-]+)/i.exec(contentType ?? '')?.[1] ?? null;
  const fileName = fileNameFromUrl(url);
  const format = detectFormat({ mimeType, fileName });
  const bytes = await readWithLimit(response, maxBytes);

  if (bytes.byteLength === 0) {
    throw knowledgeError('documento_vazio', 'A página veio vazia.');
  }
  return { bytes, mimeType, charset, format, finalUrl: url.toString(), fileName };
}
