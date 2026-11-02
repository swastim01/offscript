import test from 'node:test';
import assert from 'node:assert/strict';
import { createEncounterProposal, ProposalDecisions, type CommunityMessage } from './community.js';

function message(text: string, user: string, source: CommunityMessage['source'] = 'twitch', at = Date.now()): CommunityMessage {
  return { text, user, source, at };
}

test('repeated chat phrases create a review proposal with a bounded boss name', () => {
  const proposal = createEncounterProposal([
    message('one more run, this build is close', 'viewer_a', 'twitch', 1000),
    message('one more run for the team', 'viewer_b', 'twitch', 21000),
  ]);
  assert.ok(proposal);
  assert.match(proposal.theme, /one more run/i);
  assert.equal(proposal.source, 'Twitch chat');
  assert.ok(proposal.evidenceCount >= 2);
  assert.equal(proposal.evidenceWindowSeconds, 20);
  assert.equal(proposal.sampleSize, 2);
  assert.ok(proposal.boss.length <= 48);
});

test('proposal decisions suppress repeats while allowing a different community phrase', () => {
  const decisions = new ProposalDecisions();
  const first = createEncounterProposal([
    message('one more run, this build is close', 'viewer_a', 'simulated'),
    message('one more run for the team', 'viewer_b', 'simulated'),
  ]);
  assert.ok(first);
  assert.equal(decisions.has(first), false);
  decisions.remember(first);
  assert.equal(decisions.has(first), true);

  const second = createEncounterProposal([
    message('the purple comet is coming', 'viewer_a'),
    message('the purple comet is back', 'viewer_b'),
  ]);
  assert.ok(second);
  assert.equal(decisions.has(second), false);
});

test('one message alone never creates a proposal', () => {
  assert.equal(createEncounterProposal([message('one more run', 'viewer_a')]), null);
  assert.equal(createEncounterProposal([message('one more run, one more run', 'viewer_a')]), null);
});
