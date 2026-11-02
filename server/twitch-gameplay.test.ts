import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, startEvent } from './engine.js';
import { processTwitchMessage } from './twitch-gameplay.js';

test('Twitch !join and !attack update the authoritative encounter state and Twitch feed', () => {
  const state = createState();
  startEvent(state);
  assert.deepEqual(processTwitchMessage(state, 'viewer_1', '!join', 1000), { kind: 'command', command: 'join', accepted: true, completed: false });
  assert.deepEqual(processTwitchMessage(state, 'viewer_1', '!attack', 2000), { kind: 'command', command: 'attack', accepted: true, completed: false });
  assert.equal(state.viewers, 1);
  assert.equal(state.hp, state.maxHp - 100);
  assert.equal(state.score, 100);
  assert.equal(state.feed[0].source, 'twitch');
  assert.equal(state.feed[0].command, '!attack');
});

test('rejected Twitch commands do not mutate the encounter and leave a safe activity entry', () => {
  const state = createState();
  startEvent(state);
  const beforeHp = state.hp;
  assert.deepEqual(processTwitchMessage(state, 'viewer_2', '!attack', 1000), { kind: 'command', command: 'attack', accepted: false, completed: false });
  assert.equal(state.hp, beforeHp);
  assert.equal(state.feed[0].source, 'twitch');
  assert.match(state.feed[0].text, /Join the party first/);
});

test('a Twitch command that wins creates one persistent outcome for the server to save', () => {
  const state = createState();
  startEvent(state);
  processTwitchMessage(state, 'viewer_4', '!join', 1000);
  state.hp = 100;
  const outcome = processTwitchMessage(state, 'viewer_4', '!attack', 2000);
  assert.deepEqual(outcome, { kind: 'command', command: 'attack', accepted: true, completed: true });
  assert.equal(state.phase, 'won');
  assert.equal(state.memories.length, 1);
  assert.equal(state.history.length, 1);
  assert.equal(state.rewardCount, 1);
  const duplicateAttempt = processTwitchMessage(state, 'viewer_4', '!attack', 6000);
  assert.deepEqual(duplicateAttempt, { kind: 'command', command: 'attack', accepted: false, completed: false });
  assert.equal(state.rewardCount, 1);
  assert.equal(state.memories.length, 1);
});

test('unrecognized commands remain ordinary chat and empty sanitized messages are ignored', () => {
  const state = createState();
  assert.deepEqual(processTwitchMessage(state, 'viewer_3', '!reset', 1000), { kind: 'chat', text: '!reset' });
  assert.deepEqual(processTwitchMessage(state, 'viewer_3', '<>\u0000', 1000), { kind: 'empty' });
});
