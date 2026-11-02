import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyAction, createState, startEvent } from './engine.js';
import { readPersistentState, savePersistentState } from './persistence.js';

test('missing history starts with fresh state, but malformed history fails loudly', () => {
  const directory = mkdtempSync(join(tmpdir(), 'offscript-persistence-'));
  const missingPath = join(directory, 'missing.json');
  const malformedPath = join(directory, 'malformed.json');
  try {
    assert.equal(readPersistentState(missingPath), undefined);
    writeFileSync(malformedPath, '{not valid json');
    assert.throws(() => readPersistentState(malformedPath), /invalid JSON/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a completed encounter keeps its lore and unique reward after reload', () => {
  const directory = mkdtempSync(join(tmpdir(), 'offscript-persistence-'));
  const dataPath = join(directory, 'data', 'offscript.json');
  try {
    const state = createState();
    startEvent(state);
    applyAction(state, { user: 'viewer_1', command: 'join' });
    state.hp = 100;
    applyAction(state, { user: 'viewer_1', command: 'attack', source: 'twitch' });
    assert.equal(state.phase, 'won');

    savePersistentState(dataPath, state);
    const restored = createState(readPersistentState(dataPath));
    assert.equal(restored.phase, 'idle');
    assert.equal(restored.rewardCount, 1);
    assert.deepEqual(restored.history, state.history);
    assert.deepEqual(restored.memories, state.memories);
    assert.equal(restored.lore, state.lore);
    assert.deepEqual(restored.rewardedKeys, state.rewardedKeys);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
