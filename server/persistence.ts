import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type { GameState } from './engine.js';

export function readPersistentState(dataPath: string): Partial<GameState> | undefined {
  let contents: string;
  try {
    contents = readFileSync(dataPath, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw new Error('Could not read OFFSCRIPT history. Check OFFSCRIPT_DATA_FILE and persistent-volume permissions.');
  }

  let saved: unknown;
  try { saved = JSON.parse(contents); }
  catch { throw new Error('OFFSCRIPT history contains invalid JSON. Refusing to start with empty history.'); }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
    throw new Error('OFFSCRIPT history must contain a JSON object. Refusing to start with empty history.');
  }
  return saved as Partial<GameState>;
}

export function savePersistentState(dataPath: string, state: GameState): void {
  mkdirSync(dirname(dataPath), { recursive: true });
  const tempPath = `${dataPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, JSON.stringify({
      history: state.history,
      memories: state.memories,
      rewardCount: state.rewardCount,
      rewardedKeys: state.rewardedKeys,
      lore: state.lore,
      boss: state.boss,
      theme: state.theme,
      maxHp: state.maxHp,
      duration: state.duration,
    }, null, 2), { flag: 'wx' });
    renameSync(tempPath, dataPath);
  } catch (error) {
    try { unlinkSync(tempPath); } catch { /* The rename may have completed, or the temporary file may not exist. */ }
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
