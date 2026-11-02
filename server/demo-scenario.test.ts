import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, pauseEvent, startEvent } from './engine.js';
import { runDemoBattle, type DemoStage } from './demo-scenario.js';

test('staged demo exposes all boss phases and saves a simulated victory through the engine', async () => {
  const state = createState();
  const stages: Array<{ stage: DemoStage; hp: number; phase: string }> = [];
  const completed = await runDemoBattle(state, stage => stages.push({ stage, hp: state.hp, phase: state.phase }), async () => undefined);

  assert.equal(completed, true);
  assert.deepEqual(stages.map(stage => stage.stage), ['awakening', 'fracture', 'last_stand', 'victory']);
  assert.deepEqual(stages.map(stage => stage.hp), [2400, 1500, 300, 0]);
  assert.equal(state.phase, 'won');
  assert.equal(state.rewardCount, 1);
  assert.equal(state.history.length, 1);
  assert.equal(state.feed.filter(item => item.command === '!attack').every(item => item.source === 'simulated'), true);
  assert.ok(state.feed.some(item => item.text.includes('Team ward blocked a pressure wave')));
});

test('staged demo stops cleanly if the encounter is paused during a phase', async () => {
  const state = createState();
  const stages: DemoStage[] = [];
  let waits = 0;
  const completed = await runDemoBattle(state, stage => stages.push(stage), async () => { if (++waits === 2) state.phase = 'paused'; });

  assert.equal(completed, false);
  assert.deepEqual(stages, ['awakening', 'fracture']);
  assert.equal(state.phase, 'paused');
  assert.equal(state.rewardCount, 0);
  assert.equal(state.history.length, 0);
});

test('staged demo refuses to replace an already live or paused encounter', async () => {
  const liveState = createState();
  startEvent(liveState);
  liveState.hp = 900;
  const liveFeedCount = liveState.feed.length;
  assert.equal(await runDemoBattle(liveState, () => undefined, async () => undefined), false);
  assert.equal(liveState.phase, 'live');
  assert.equal(liveState.hp, 900);
  assert.equal(liveState.feed.length, liveFeedCount);

  const pausedState = createState();
  startEvent(pausedState);
  pauseEvent(pausedState);
  const pausedFeedCount = pausedState.feed.length;
  assert.equal(await runDemoBattle(pausedState, () => undefined, async () => undefined), false);
  assert.equal(pausedState.phase, 'paused');
  assert.equal(pausedState.feed.length, pausedFeedCount);
});
