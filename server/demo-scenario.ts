import { applyAction, startEvent, tick, type Command, type GameState } from './engine.js';

export type DemoStage = 'awakening' | 'fracture' | 'last_stand' | 'victory';
export type DemoWait = (milliseconds: number) => Promise<void>;
export type DemoCancelled = () => boolean;

const pause: DemoWait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const isInPhase = (state: GameState, phase: GameState['phase']) => state.phase === phase;
const hasHealth = (state: GameState, hp: number) => state.hp === hp;

/** Play the repeatable, explicitly simulated battle in visible stages through the real encounter engine. */
export async function runDemoBattle(
  state: GameState,
  onStage: (stage: DemoStage) => void,
  wait: DemoWait = pause,
  isCancelled: DemoCancelled = () => false,
): Promise<boolean> {
  // startEvent owns the eligibility check and transitions the state to live.
  if (!startEvent(state).ok) return false;

  let now = Date.now();
  const action = (user: string, command: Command, damage?: number) => {
    if (isCancelled() || !isInPhase(state, 'live')) return false;
    const outcome = applyAction(state, { user, command, ...(damage === undefined ? {} : { damage }), source: 'simulated' }, now);
    now += 3100;
    return outcome.ok;
  };

  onStage('awakening');
  for (const user of ['MossMage', 'ByteBard', 'PixelPilot', 'CozyChaos']) {
    if (!action(user, 'join')) return false;
  }
  await wait(1100);
  if (isCancelled() || !isInPhase(state, 'live')) return false;

  for (const user of ['MossMage', 'PixelPilot', 'CozyChaos']) {
    if (!action(user, 'attack', 300)) return false;
  }
  if (!hasHealth(state, 1500) || isCancelled()) return false;
  onStage('fracture');
  await wait(1100);
  if (isCancelled() || !isInPhase(state, 'live')) return false;

  if (!action('ByteBard', 'shield')) return false;
  const chargesBeforeWave = state.guardCharges;
  for (let second = 0; second < 30 && state.guardCharges === chargesBeforeWave && isInPhase(state, 'live'); second++) tick(state);
  if (state.guardCharges === chargesBeforeWave) return false;
  for (const user of ['MossMage', 'ByteBard', 'PixelPilot', 'CozyChaos']) {
    if (!action(user, 'attack', 300)) return false;
  }
  if (!hasHealth(state, 300) || isCancelled()) return false;
  onStage('last_stand');
  await wait(1100);
  if (isCancelled() || !isInPhase(state, 'live')) return false;

  if (!action('MossMage', 'attack', 300) || !isInPhase(state, 'won')) return false;
  onStage('victory');
  await wait(1100);
  return true;
}
