import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * A plain content-addressed store: results keyed by the content hash of their
 * inputs. Re-analyzing identical inputs returns the cached result. It is
 * deterministic by construction and bounds the cost of re-running on large
 * repositories. Deliberately simple; anything fancier is debt.
 */

/**
 * Compute a content key from an ordered list of input parts.
 *
 * @param parts - the inputs that fully determine the result.
 * @returns a lowercase hex sha256 of the joined parts.
 */
export function contentKey(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export class AnalysisCache {
  /**
   * @param dir - directory the cache entries live in; created on first write.
   */
  constructor(private readonly dir: string) {}

  private pathFor(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  /**
   * Read a cached value by key.
   *
   * @param key - the content key.
   * @returns the parsed value, or null on a miss.
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(this.pathFor(key), "utf8")) as T;
    } catch {
      return null;
    }
  }

  /**
   * Write a value under a key.
   *
   * @param key - the content key.
   * @param value - the JSON-serializable value to store.
   */
  async set<T>(key: string, value: T): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.pathFor(key), JSON.stringify(value), "utf8");
  }
}
