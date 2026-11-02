import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createState, endEvent, getBossBeat, pauseEvent, prepareEncounter, resetEvent, resumeEvent, startEvent, tick } from './engine.js';

function live() { const s = createState(); assert.equal(startEvent(s).ok, true); return s; }
function joined(s: ReturnType<typeof createState>, user = 'Nova', now = 1000) { return applyAction(s, { user, command: 'join' }, now); }

test('initial state is idle with full health and no participants', () => {
  const state = createState(); assert.equal(state.phase, 'idle'); assert.equal(state.hp, state.maxHp); assert.equal(state.viewers, 0);
  assert.equal(getBossBeat(state), null);
});
test('boss dialogue shifts through awakening, fracture, and final stand using authoritative HP', () => {
  const s = live();
  assert.equal(getBossBeat(s)?.phase, 'awakening');
  s.hp = 1500; assert.equal(getBossBeat(s)?.phase, 'fracture');
  s.hp = 1584; assert.equal(getBossBeat(s)?.phase, 'fracture');
  s.hp = 500; assert.equal(getBossBeat(s)?.phase, 'last_stand');
  s.hp = 600; assert.equal(getBossBeat(s)?.phase, 'last_stand');
  assert.match(getBossBeat(s)?.message ?? '', /final push/);
  s.phase = 'paused'; assert.equal(getBossBeat(s), null);
});
test('preparation, start, pause, resume, end, and reset enforce transitions', () => {
  const s = createState(); assert.equal(prepareEncounter(s, 'The One More Run Curse', 'One more run').ok, true); assert.equal(s.phase, 'prepared');
  assert.equal(startEvent(s).ok, true); assert.equal(startEvent(s).ok, false); assert.equal(pauseEvent(s).ok, true); assert.equal(tick(s), undefined); assert.equal(s.secondsLeft, 120);
  assert.equal(resumeEvent(s).ok, true); assert.equal(endEvent(s).ok, true); assert.equal(s.phase, 'ended'); assert.equal(resetEvent(s).ok, true); assert.equal(s.phase, 'idle');
});
test('join registers each username once and actions require membership', () => {
  const s = live(); assert.equal(applyAction(s, { user: 'Nova', command: 'attack' }, 1).ok, false);
  assert.equal(joined(s).ok, true); joined(s, 'nova', 1001); assert.equal(s.viewers, 1);
});
test('attack clamps damage, updates score, and cannot reduce health below zero', () => {
  const s = live(); joined(s); assert.deepEqual(applyAction(s, { user: 'Nova', command: 'attack', damage: 9999 }, 1000).ok, true);
  assert.equal(s.hp, 2100); assert.equal(s.score, 300); assert.equal(s.playerScores.nova, 300);
  assert.equal(applyAction(s, { user: 'Nova', command: 'attack', damage: 999 }, 2000).ok, false);
  assert.equal(applyAction(s, { user: 'Nova', command: 'attack', damage: 999 }, 4000).ok, true); assert.equal(s.hp, 1800);
});
test('team shield stores up to three charges and blocks pressure waves', () => {
  const s = live(); joined(s, 'Nova');
  assert.equal(applyAction(s, { user: 'Nova', command: 'shield' }, 1000).ok, true); assert.equal(s.guardCharges, 1);
  s.secondsLeft = 21; tick(s); assert.equal(s.secondsLeft, 20); assert.equal(s.guardCharges, 0);
  s.secondsLeft = 1; tick(s); assert.equal(s.phase, 'lost');
});
test('inspection has a cooldown and lore is available after an outcome', () => {
  const s = live(); joined(s); assert.equal(applyAction(s, { user: 'Nova', command: 'inspect' }, 1000).ok, true);
  assert.equal(applyAction(s, { user: 'Nova', command: 'inspect' }, 2000).ok, false);
  s.hp = 100; assert.equal(applyAction(s, { user: 'Nova', command: 'attack' }, 4000).ok, true);
  assert.equal(s.phase, 'won'); assert.equal(s.rewardCount, 1); assert.equal(s.memories.length, 1);
  assert.equal(applyAction(s, { user: 'Nova', command: 'lore' }, 5000).ok, true);
});
test('timeout records a memory but does not grant a victory reward; reset grants none', () => {
  const s = live(); s.secondsLeft = 1; tick(s); assert.equal(s.phase, 'lost'); assert.equal(s.rewardCount, 0); assert.equal(s.history.length, 1);
  resetEvent(s); assert.equal(s.history.length, 1); assert.equal(s.rewardCount, 0);
});
test('replaying a reset encounter cannot farm the same reward', () => {
  const s = live(); joined(s); s.hp = 100; applyAction(s, { user: 'Nova', command: 'attack' }, 1000); assert.equal(s.rewardCount, 1);
  resetEvent(s); startEvent(s); joined(s); s.hp = 100; applyAction(s, { user: 'Nova', command: 'attack' }, 5000);
  assert.equal(s.phase, 'won'); assert.equal(s.rewardCount, 1); assert.equal(s.memories[0].reward, undefined);
});
test('duplicate, malformed, and invalid usernames are rejected', () => {
  const s = live(); const invalidUser = applyAction(s, { user: 'bad name', command: 'join' }, 1);
  assert.deepEqual(invalidUser, { ok: false, reason: 'Use a valid chat username.' });
  joined(s); assert.equal(applyAction(s, { user: 'Nova', command: 'attack', damage: Number.NaN }, 1000).ok, false);
  assert.equal(applyAction(s, { user: 'Nova', command: 'lore' }, 1100).ok, false);
});
test('a prepared encounter becomes the active encounter and cooldown keys ignore case', () => {
  const s = createState(); prepareEncounter(s, 'The One More Run Curse', 'one more run'); startEvent(s); joined(s);
  assert.equal(s.boss, 'The One More Run Curse'); assert.equal(applyAction(s, { user: 'Nova', command: 'attack' }, 1000).ok, true);
  assert.equal(applyAction(s, { user: 'nova', command: 'shield' }, 2000).ok, false);
});
