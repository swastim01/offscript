import test from 'node:test';
import assert from 'node:assert/strict';
import { disconnectTwitch } from './twitch-disconnect.js';

test('disconnect reports the local stop before waiting for Twitch token revocation', async () => {
  const messages: string[] = [];
  let stopCalled = false;
  let clearCalled = false;
  let resolveRevocation!: () => void;
  const pendingRevocation = new Promise<void>(resolve => { resolveRevocation = resolve; });
  const result = disconnectTwitch({
    stop: () => { stopCalled = true; },
    clear: () => { clearCalled = true; },
    revoke: () => pendingRevocation,
    publish: message => messages.push(message),
    disconnectedMessage: 'Disconnected from Twitch. Demo mode remains available.',
    revocationFailureMessage: 'Disconnected locally, but Twitch did not confirm token revocation.',
  });

  assert.equal(stopCalled, true);
  assert.equal(clearCalled, true);
  assert.deepEqual(messages, ['Twitch chat stopped. Confirming token revocation.']);
  resolveRevocation();
  assert.equal(await result, 'Disconnected from Twitch. Demo mode remains available.');
  assert.deepEqual(messages, ['Twitch chat stopped. Confirming token revocation.', 'Disconnected from Twitch. Demo mode remains available.']);
});

test('disconnect stays local and reports when Twitch does not confirm revocation', async () => {
  const messages: string[] = [];
  const result = await disconnectTwitch({
    stop: () => undefined,
    clear: () => undefined,
    revoke: async () => { throw new Error('private transport detail'); },
    publish: message => messages.push(message),
    disconnectedMessage: 'Disconnected from Twitch. Demo mode remains available.',
    revocationFailureMessage: 'Disconnected locally, but Twitch did not confirm token revocation.',
  });

  assert.equal(result, 'Disconnected locally, but Twitch did not confirm token revocation.');
  assert.equal(messages.at(-1), result);
  assert.equal(messages.join(' ').includes('private transport detail'), false);
});
