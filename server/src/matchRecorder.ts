import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MatchSummary, MatchTelemetry } from '../../shared/telemetry.js';
import { MATCH_ID_PATTERN } from './matchValidation.js';

/**
 * File-based archive of completed matches: `<dir>/<matchId>.json` (full telemetry).
 * Ids are validated against a strict pattern, so they can never escape `dir`.
 */
export class MatchStore {
  constructor(readonly dir: string) {}

  private file(matchId: string): string | null {
    return MATCH_ID_PATTERN.test(matchId) ? path.join(this.dir, `${matchId}.json`) : null;
  }

  /** Writes a new match log. Never overwrites: returns `'exists'` if the id is taken. */
  async save(match: MatchTelemetry): Promise<'created' | 'exists'> {
    const file = this.file(match.matchId);
    if (!file) throw new Error(`Invalid match id "${match.matchId}"`);
    await mkdir(this.dir, { recursive: true });
    try {
      await writeFile(file, JSON.stringify(match, null, 2) + '\n', { flag: 'wx' });
      return 'created';
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'EEXIST') return 'exists';
      throw err;
    }
  }

  async load(matchId: string): Promise<MatchTelemetry | null> {
    const file = this.file(matchId);
    if (!file) return null;
    try {
      return JSON.parse(await readFile(file, 'utf8')) as MatchTelemetry;
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null;
      throw err;
    }
  }

  /** Summaries of all recorded matches, newest first. Unreadable files are skipped. */
  async list(): Promise<MatchSummary[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return [];
      throw err;
    }
    const summaries: MatchSummary[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const match = await this.load(name.slice(0, -'.json'.length)).catch(() => null);
      if (match?.summary) summaries.push(match.summary);
    }
    return summaries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
}
