export type Phase = 'idle' | 'prepared' | 'live' | 'paused' | 'won' | 'lost' | 'ended';
export type Command = 'join' | 'attack' | 'shield' | 'inspect' | 'lore';
export type Action = { user: string; command: Command; damage?: number; source?: 'simulated' | 'twitch' };
export type ActionSuccess = { ok: true; message?: string; damage?: number; guardCharges?: number };
export type ActionFailure = { ok: false; reason: string };
export type ActionResult = ActionSuccess | ActionFailure;
export type BossBeat = { phase: 'awakening' | 'fracture' | 'last_stand'; label: string; message: string };
export type FeedItem = { user: string; command: string; text: string; time: number; kind: 'attack' | 'shield' | 'system' | 'chat'; source?: 'simulated' | 'twitch' };
export type Memory = { id: string; boss: string; theme: string; result: 'won' | 'lost'; text: string; reward?: string; at: number };
export type GameState = {
  phase: Phase; boss: string; theme: string; hp: number; maxHp: number; secondsLeft: number; duration: number;
  viewers: number; lore: string; score: number; streak: number; feed: FeedItem[]; cooldowns: Record<string, number>;
  playerScores: Record<string, number>; participants: Record<string, true>; inspectCooldowns: Record<string, number>;
  guardCharges: number; memories: Memory[]; rewardCount: number; history: Memory[]; rewardedKeys: string[]; lastOutcomeId: string | null;
};
const COOLDOWN = 3000;
const MAX_FEED = 40;
const MAX_MEMORIES = 20;

export function createState(saved?: Partial<GameState>): GameState {
  const fresh: GameState = {
    phase: 'idle', boss: 'The Algorithm', theme: 'The chat keeps saying “one more run”', hp: 2400, maxHp: 2400,
    secondsLeft: 120, duration: 120, viewers: 0, lore: 'Born from one more run. Fueled by emotes. Defeated by teamwork.',
    score: 0, streak: 0, feed: [{ user: 'SYSTEM', command: '', text: 'The arena is quiet. Start an event when chat is ready.', time: Date.now(), kind: 'system' }],
    cooldowns: {}, playerScores: {}, participants: {}, inspectCooldowns: {}, guardCharges: 0, memories: [], rewardCount: 0, history: [], rewardedKeys: [], lastOutcomeId: null,
  };
  return { ...fresh, ...saved, phase: 'idle', rewardedKeys: saved?.rewardedKeys ?? [], hp: saved?.maxHp ?? fresh.maxHp, secondsLeft: saved?.duration ?? fresh.duration,
    feed: saved?.feed?.length ? saved.feed : fresh.feed, cooldowns: {}, playerScores: {}, participants: {}, inspectCooldowns: {}, guardCharges: 0 };
}
export function getBossBeat(state: Pick<GameState, 'phase' | 'boss' | 'hp' | 'maxHp'>): BossBeat | null {
  if (state.phase !== 'live' || state.maxHp <= 0) return null;
  const healthRatio = state.hp / state.maxHp;
  if (healthRatio > .66) return { phase: 'awakening', label: 'Awakening', message: `${state.boss} is feeding on the running joke. Rally the party.` };
  if (healthRatio > .25) return { phase: 'fracture', label: 'Fracture', message: `Every coordinated hit makes the joke work against ${state.boss}.` };
  return { phase: 'last_stand', label: 'Final stand', message: `${state.boss} is nearly broken. One final push can end it.` };
}
export function prepareEncounter(state: GameState, boss: string, theme: string) {
  if (state.phase === 'live' || state.phase === 'paused') return fail('End the current encounter before preparing another.');
  const safeBoss = cleanText(boss, 48); const safeTheme = cleanText(theme, 180);
  if (!safeBoss || !safeTheme) return fail('Add a boss name and a community theme.');
  state.boss = safeBoss; state.theme = safeTheme; state.phase = 'prepared'; state.hp = state.maxHp; state.secondsLeft = state.duration;
  push(state, 'SYSTEM', '', `Encounter proposal ready: ${safeBoss}. Waiting for streamer approval.`, 'system'); return { ok: true };
}
export function startEvent(state: GameState) {
  if (!['idle', 'prepared', 'won', 'lost', 'ended'].includes(state.phase)) return fail('The encounter cannot start from its current state.');
  state.phase = 'live'; state.hp = state.maxHp; state.secondsLeft = state.duration; state.score = 0; state.streak = 0;
  state.cooldowns = {}; state.inspectCooldowns = {}; state.playerScores = {}; state.participants = {}; state.viewers = 0; state.guardCharges = 0; state.lastOutcomeId = null;
  push(state, 'SYSTEM', '', `${state.boss} has entered the arena. Type !join to fight.`, 'system'); return { ok: true };
}
export function pauseEvent(state: GameState) { if (state.phase !== 'live') return fail('Only a live encounter can be paused.'); state.phase = 'paused'; push(state, 'SYSTEM', '', 'The streamer paused the encounter.', 'system'); return { ok: true }; }
export function resumeEvent(state: GameState) { if (state.phase !== 'paused') return fail('There is no paused encounter to resume.'); state.phase = 'live'; push(state, 'SYSTEM', '', 'The encounter is back in motion.', 'system'); return { ok: true }; }
export function resetEvent(state: GameState) {
  if (state.phase === 'live' || state.phase === 'paused') push(state, 'SYSTEM', '', 'Encounter reset by the streamer. No reward was earned.', 'system');
  state.phase = 'idle'; state.hp = state.maxHp; state.secondsLeft = state.duration; state.score = 0; state.streak = 0; state.cooldowns = {};
  state.inspectCooldowns = {}; state.playerScores = {}; state.participants = {}; state.viewers = 0; state.guardCharges = 0; state.lastOutcomeId = null;
  if (!state.feed[0]?.text.includes('Encounter reset')) push(state, 'SYSTEM', '', 'The arena is ready for another encounter.', 'system'); return { ok: true };
}
export function endEvent(state: GameState) {
  if (!['live', 'paused'].includes(state.phase)) return fail('There is no active encounter to end.');
  state.phase = 'ended'; push(state, 'SYSTEM', '', 'Encounter ended by the streamer. No reward was earned.', 'system'); return { ok: true };
}
export function applyAction(state: GameState, action: Action, now = Date.now()): ActionResult {
  const user = normalizeUser(action?.user);
  if (!user) return fail('Use a valid chat username.');
  if (!['join', 'attack', 'shield', 'inspect', 'lore'].includes(action.command)) return fail('Unknown command. Try !join, !attack, !shield, !inspect, or !lore.');
  if (action.command === 'lore') {
    const memory = state.memories[0];
    if (!memory) return fail('No community memories have been unlocked yet. Win or finish an encounter to write the first one.');
    push(state, user, '!lore', `remembered ${memory.boss}: ${memory.text}`, 'system', action.source); return { ok: true, message: memory.text };
  }
  if (state.phase !== 'live') return fail('There is no live encounter.');
  if (action.command === 'join') {
    const key = user.toLowerCase(); if (!state.participants[key]) { state.participants[key] = true; state.viewers = Object.keys(state.participants).length; push(state, user, '!join', 'joined the party', 'system', action.source); }
    return { ok: true, message: 'You joined the party.' };
  }
  const key = user.toLowerCase();
  if (!state.participants[key]) return fail('Join the party first with !join.');
  if (action.command === 'inspect') {
    const until = state.inspectCooldowns[key] ?? 0; if (now < until) return fail('Your insight is recovering. Try !inspect again in a few seconds.');
    state.inspectCooldowns[key] = now + 15000;
    const hpPct = state.hp / state.maxHp;
    const hint = hpPct > .66 ? `${state.boss} is strongest while chat is scattered. Coordinate attacks in a burst.` : hpPct > .25 ? 'The pattern is cracking. Keep the team streak alive and protect time with !shield.' : 'The final phase! Every hit counts; shields can block the next pressure wave.';
    push(state, user, '!inspect', hint, 'system', action.source); return { ok: true, message: hint };
  }
  const cooldownUntil = state.cooldowns[key] ?? 0; if (now < cooldownUntil) return fail('Action cooling down. Wait three seconds.');
  state.cooldowns[key] = now + COOLDOWN;
  if (action.command === 'attack') {
    const raw = action.damage ?? 100; if (!Number.isFinite(raw)) return fail('Damage must be a number.');
    const damage = Math.max(1, Math.min(300, Math.floor(raw))); const dealt = Math.min(state.hp, damage);
    state.hp = Math.max(0, state.hp - dealt); state.score += dealt; state.streak += 1; state.playerScores[key] = (state.playerScores[key] ?? 0) + dealt;
    push(state, user, '!attack', `dealt ${dealt} damage`, 'attack', action.source); if (state.hp === 0) finish(state, 'won');
    return { ok: true, damage: dealt };
  }
  if (state.guardCharges >= 3) { delete state.cooldowns[key]; return fail('The team shield is fully charged (3). Wait for a pressure wave to use one.'); }
  state.guardCharges += 1; state.score += 10; state.streak = 0; state.playerScores[key] = (state.playerScores[key] ?? 0) + 10;
  push(state, user, '!shield', `charged the team ward (${state.guardCharges}/3). It blocks a pressure wave every 20 seconds.`, 'shield', action.source); return { ok: true, guardCharges: state.guardCharges };
}
export function tick(state: GameState) {
  if (state.phase !== 'live') return;
  state.secondsLeft = Math.max(0, state.secondsLeft - 1);
  if (state.secondsLeft > 0 && state.secondsLeft % 20 === 0) {
    if (state.guardCharges > 0) { state.guardCharges--; push(state, 'SYSTEM', '', `Team ward blocked a pressure wave. ${state.guardCharges} charge${state.guardCharges === 1 ? '' : 's'} remain.`, 'system'); }
    else { state.secondsLeft = Math.max(0, state.secondsLeft - 5); push(state, 'SYSTEM', '', 'Pressure wave! No shield was ready; 5 seconds were lost.', 'system'); }
  }
  if (state.secondsLeft === 0 && state.phase === 'live') finish(state, 'lost');
}
export function finish(state: GameState, result: 'won' | 'lost', now = Date.now()) {
  if (state.phase !== 'live') return;
  state.phase = result;
  const id = `${now}-${state.boss.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const rewardKey = `${state.boss.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}|${state.theme.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;
  const reward = result === 'won' && !state.rewardedKeys.includes(rewardKey) ? `Unlocked the ${state.boss} badge` : undefined;
  const memory: Memory = { id, boss: state.boss, theme: state.theme, result, text: result === 'won' ? `${state.boss} fell when the chat rallied around “${state.theme}.”` : `${state.boss} held the line. The chat learned to coordinate around “${state.theme}.”`, reward, at: now };
  if (state.lastOutcomeId !== id) { state.lastOutcomeId = id; state.memories = [memory, ...state.memories].slice(0, MAX_MEMORIES); state.history = [memory, ...state.history].slice(0, MAX_MEMORIES); if (reward) { state.rewardCount += 1; state.rewardedKeys = [...state.rewardedKeys, rewardKey]; } state.lore = memory.text; }
  push(state, 'SYSTEM', '', result === 'won' ? (reward ? `${state.boss} has been defeated! Reward unlocked: ${reward}.` : `${state.boss} has been defeated! This encounter's badge was already earned.`) : `${state.boss} held the line. A new memory was added to community lore.`, 'system');
}
export function recordFeed(state: GameState, user: string, text: string, source?: 'simulated' | 'twitch') { push(state, normalizeUser(user) ?? 'CHAT', '', cleanText(text, 180), 'chat', source); }
function normalizeUser(value: unknown) { if (typeof value !== 'string') return ''; const user = value.trim().replace(/^@/, '').slice(0, 25); return /^[\w-]{1,25}$/.test(user) ? user : ''; }
function cleanText(value: unknown, max: number) { return typeof value === 'string' ? value.replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, max) : ''; }
function push(state: GameState, user: string, command: string, text: string, kind: FeedItem['kind'], source?: FeedItem['source']) { state.feed.unshift({ user, command, text, time: Date.now(), kind, ...(source ? { source } : {}) }); state.feed = state.feed.slice(0, MAX_FEED); }
function fail(reason: string): ActionFailure { return { ok: false, reason }; }
