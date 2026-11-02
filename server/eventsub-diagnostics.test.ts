import test from 'node:test';
import assert from 'node:assert/strict';
import { formatEventSubDiagnostic } from './eventsub-diagnostics.js';

test('EventSub diagnostics serialize only fixed stages and safe result fields', () => {
  const line = formatEventSubDiagnostic('chat_received', {
    category: 'success', commandRecognized: true, httpStatus: 200,
    message: '!attack', user: 'private-viewer', messageId: 'private-message-id',
    url: 'https://private.example/path?query=private', token: 'never-log',
    cookie: 'private-cookie', clientSecret: 'private-secret', accessToken: 'private-access',
  } as never);
  assert.deepEqual(JSON.parse(line), { stage: 'chat_received', category: 'success', commandRecognized: true });
  for (const sensitive of ['!attack', 'private-viewer', 'private-message-id', 'private.example', 'private', 'never-log', 'private-cookie', 'private-secret', 'private-access']) {
    assert.equal(line.includes(sensitive), false, `diagnostic leaked ${sensitive}`);
  }
  assert.equal(formatEventSubDiagnostic('chat_received', { httpStatus: 200 }), '{"stage":"chat_received"}');
  assert.equal(formatEventSubDiagnostic('subscription_response', { httpStatus: 202, category: 'success' }), '{"stage":"subscription_response","category":"success","httpStatus":202}');
});
