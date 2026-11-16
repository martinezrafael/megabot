/**
 * Anonimiza um payload REAL de webhook da Meta para virar fixture de teste.
 *
 * Uso: pnpm --filter @megabot/api webhook:anonymize <entrada.json> [saida.json]
 *
 * O mapeamento é determinístico dentro do arquivo: o mesmo telefone/wamid real vira sempre o
 * mesmo valor falso, então as referências entre eventos (status -> mensagem, resposta -> citada)
 * continuam coerentes. SEMPRE revise a saída antes de commitar.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const PHONE_KEYS = new Set(['wa_id', 'from', 'recipient_id', 'phone']);
const OPAQUE_USER_KEYS = new Set([
  'user_id',
  'from_user_id',
  'recipient_user_id',
  'parent_user_id',
]);
const NAME_KEYS = new Set(['formatted_name', 'first_name', 'last_name', 'middle_name']);

class Aliaser {
  private readonly seen = new Map<string, string>();
  constructor(private readonly make: (n: number) => string) {}
  get(real: string): string {
    let alias = this.seen.get(real);
    if (!alias) {
      alias = this.make(this.seen.size + 1);
      this.seen.set(real, alias);
    }
    return alias;
  }
}

export function anonymizeWebhook<T>(payload: T): T {
  const phones = new Aliaser((n) => `5511900000${String(n).padStart(3, '0')}`);
  const users = new Aliaser((n) => `BR.ANON${String(n).padStart(4, '0')}`);
  const names = new Aliaser((n) => `Cliente Anonimo ${n}`);
  const wamids = new Aliaser((n) => `wamid.ANON${String(n).padStart(6, '0')}`);
  const media = new Aliaser((n) => `MEDIA-ANON-${n}`);
  const business = new Aliaser((n) => `10000000000000${n}`);

  const visit = (node: unknown, key: string, parentKey: string): unknown => {
    if (Array.isArray(node)) return node.map((item) => visit(item, key, parentKey));
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, visit(v, k, key)]));
    }
    if (typeof node === 'string') {
      if (node.startsWith('wamid.')) return wamids.get(node);
      if (PHONE_KEYS.has(key)) return phones.get(node);
      if (OPAQUE_USER_KEYS.has(key)) return users.get(node);
      if (key === 'display_phone_number') return '551100000000';
      if (key === 'phone_number_id' || (key === 'id' && parentKey === 'entry')) {
        return business.get(node);
      }
      if (NAME_KEYS.has(key) || (key === 'name' && ['profile', 'name'].includes(parentKey))) {
        return names.get(node);
      }
      if (key === 'body' && parentKey === 'text') return 'Texto anonimizado';
      if (key === 'caption') return 'Legenda anonimizada';
      if (key === 'address' || (key === 'name' && parentKey === 'location'))
        return 'Endereco anonimizado';
      if (key === 'url' || key === 'source_url' || key === 'link')
        return 'https://exemplo.invalid/anonimizado';
      if (key === 'filename') return 'arquivo-anonimizado.pdf';
      if (key === 'id' && ['image', 'audio', 'video', 'document', 'sticker'].includes(parentKey)) {
        return media.get(node);
      }
    }
    if (typeof node === 'number' && (key === 'latitude' || key === 'longitude')) {
      return key === 'latitude' ? -23.55 : -46.63;
    }
    return node;
  };

  return visit(payload, '', '') as T;
}

if (require.main === module) {
  const [input, output] = process.argv.slice(2);
  if (!input) {
    console.error('Uso: pnpm --filter @megabot/api webhook:anonymize <entrada.json> [saida.json]');
    process.exit(1);
  }
  const result = `${JSON.stringify(anonymizeWebhook(JSON.parse(readFileSync(input, 'utf8'))), null, 2)}\n`;
  if (output) {
    writeFileSync(output, result);
    console.info(`Anonimizado em ${output}. REVISE o arquivo antes de commitar.`);
  } else {
    process.stdout.write(result);
  }
}
