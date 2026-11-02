export type CommunityMessage = { text: string; user: string; source: 'simulated' | 'twitch'; at: number };
export type EncounterProposal = { boss: string; theme: string; source: string; method: string; evidenceCount: number; evidenceWindowSeconds: number; sampleSize: number };

/** Derive a streamer-review proposal from repeated phrases in the recent message window. */
export function createEncounterProposal(messages: CommunityMessage[]): EncounterProposal | null {
  const recentMessages = messages.slice(-30);
  const counts = new Map<string, { count: number; text: string; firstAt: number; lastAt: number }>();
  for (const { text, at } of recentMessages) {
    const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (normalized.length < 4) continue;
    const messagePhrases = new Set([normalized]);
    const words = normalized.split(' ');
    for (let size = 2; size <= Math.min(5, words.length); size++) {
      for (let index = 0; index <= words.length - size; index++) {
        const phrase = words.slice(index, index + size).join(' ');
        if (phrase.length < 6) continue;
        messagePhrases.add(phrase);
      }
    }
    for (const phrase of messagePhrases) {
      const entry = counts.get(phrase) ?? { count: 0, text: phrase, firstAt: at, lastAt: at };
      entry.count++;
      entry.firstAt = Math.min(entry.firstAt, at);
      entry.lastAt = Math.max(entry.lastAt, at);
      counts.set(phrase, entry);
    }
  }
  const ranked = [...counts.values()].filter(entry => entry.count >= 2).sort((a, b) => b.count - a.count || b.text.length - a.text.length);
  if (!ranked.length) return null;
  const theme = ranked[0].text;
  const title = theme.replace(/\b\w/g, character => character.toUpperCase()).slice(0, 34);
  return {
    boss: `The ${title} Curse`.slice(0, 48),
    theme: `Chat keeps returning to “${theme}.”`,
    source: messages.at(-1)?.source === 'simulated' ? 'Simulated community chat' : 'Twitch chat',
    method: 'Deterministic repeated-phrase fallback',
    evidenceCount: ranked[0].count,
    evidenceWindowSeconds: Math.max(0, Math.round((ranked[0].lastAt - ranked[0].firstAt) / 1000)),
    sampleSize: recentMessages.length,
  };
}

/** Keeps approved or declined phrase proposals from reappearing on each subsequent chat message. */
export class ProposalDecisions {
  private readonly keys = new Set<string>();

  has(proposal: Pick<EncounterProposal, 'boss' | 'theme'>) { return this.keys.has(this.key(proposal)); }

  remember(proposal: Pick<EncounterProposal, 'boss' | 'theme'>) {
    this.keys.add(this.key(proposal));
    if (this.keys.size > 200) this.keys.delete(this.keys.values().next().value!);
  }

  private key(proposal: Pick<EncounterProposal, 'boss' | 'theme'>) {
    return `${proposal.boss.toLowerCase()}|${proposal.theme.toLowerCase()}`;
  }
}
