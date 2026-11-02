import { applyAction, recordFeed, type GameState } from './engine.js';
import { parseChatCommand } from './twitch.js';

export type TwitchMessageProcessing =
  | { kind: 'empty' }
  | { kind: 'chat'; text: string }
  | { kind: 'command'; command: NonNullable<ReturnType<typeof parseChatCommand>>; accepted: boolean; completed: boolean };

/** Sanitize EventSub chat and route recognized commands into the single authoritative engine. */
export function processTwitchMessage(state: GameState, user: string, rawText: string, now = Date.now()): TwitchMessageProcessing {
  const text = rawText.replace(/[<>\u0000-\u001f\u007f]/g, '').trim().slice(0, 180);
  if (!text) return { kind: 'empty' };
  const command = parseChatCommand(text);
  if (!command) return { kind: 'chat', text };
  const previousPhase = state.phase;
  const outcome = applyAction(state, { user, command, source: 'twitch' }, now);
  if (!outcome.ok) recordFeed(state, user, `Twitch !${command} ignored: ${outcome.reason}`, 'twitch');
  const completed = outcome.ok && previousPhase === 'live' && (state.phase === 'won' || state.phase === 'lost');
  return { kind: 'command', command, accepted: outcome.ok, completed };
}
