import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { StorageError, assertValidKey, type ObjectStorage } from './types';

/**
 * Driver de disco: guarda os arquivos numa pasta do projeto (padrão `.data/uploads`).
 * Serve para desenvolvimento e testes — não use em produção com mais de uma máquina, porque
 * cada máquina teria a sua pasta.
 */
export class LocalObjectStorage implements ObjectStorage {
  readonly driver = 'local';
  /** Pasta raiz (absoluta). Útil em teste e em log; nunca vem do cliente. */
  readonly root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
  }

  /** Caminho absoluto da chave, conferindo que ele continua DENTRO da pasta raiz. */
  private pathOf(key: string): string {
    const path = resolve(join(this.root, assertValidKey(key)));
    if (path !== this.root && !path.startsWith(this.root + sep)) {
      throw new StorageError('chave_invalida', `Chave de arquivo inválida: "${key}".`);
    }
    return path;
  }

  async put(key: string, bytes: Uint8Array, options: { contentType?: string } = {}): Promise<void> {
    // O disco não guarda o tipo do arquivo; ele fica no banco (knowledge_sources.mime_type).
    void options.contentType;
    const path = this.pathOf(key);
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    } catch (error) {
      throw new StorageError('indisponivel', 'Não foi possível gravar o arquivo em disco.', true, {
        cause: error,
      });
    }
  }

  async get(key: string): Promise<Uint8Array> {
    const path = this.pathOf(key);
    try {
      return new Uint8Array(await readFile(path));
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        throw new StorageError(
          'nao_encontrado',
          `Arquivo "${key}" não está mais no storage.`,
          false,
          {
            cause: error,
          },
        );
      }
      throw new StorageError('indisponivel', 'Não foi possível ler o arquivo do disco.', true, {
        cause: error,
      });
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await readFile(this.pathOf(key));
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return false;
      throw error;
    }
  }
}
