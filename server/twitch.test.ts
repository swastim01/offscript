import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { applyAction, createState, startEvent } from './engine.js';
import { formatOAuthDiagnostic, oauthFailureReason, safeOAuthErrorCategory, safeOAuthErrorName } from './oauth-diagnostics.js';
import { createAuthorizationStartUrl, createAuthorizationUrl, createOAuthState, createSubscriptionRequest, isHttpsTwitchCallbackUri, normalizeChatNotification, parseChatCommand, readTwitchConfig, requestHostMatchesCallback, TwitchApi, TwitchError, TwitchEventSubConnection, validateOAuthState, type TwitchSession } from './twitch.js';

const config = { clientId: 'test-client', clientSecret: 'test-secret', redirectUri: 'https://oauth.example.invalid/auth/twitch/callback', dashboardUrl: 'http://localhost:5173/' };
const session: TwitchSession = { id: '12345', login: 'streamer', displayName: 'Streamer', accessToken: 'access-test', refreshToken: 'refresh-test', expiresAt: Date.now() + 3_600_000, scopes: ['user:read:chat'] };
function json(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
function fakeChat(id = 'chat-message-1', text = '!join') { return { metadata: { message_id: `event-${id}`, message_type: 'notification', message_timestamp: new Date().toISOString(), subscription_type: 'channel.chat.message' }, payload: { event: { chatter_user_id: '456', chatter_user_login: 'viewer_1', message_id: id, message: { text } } } }; }

test('missing Twitch configuration leaves OFFSCRIPT in a usable demo configuration', () => {
  assert.equal(readTwitchConfig({}), null);
  const state = createState(); assert.equal(startEvent(state).ok, true); assert.equal(applyAction(state, { user: 'DemoViewer', command: 'join' }).ok, true);
});
test('Twitch config needs an explicit HTTPS tunnel callback before OAuth is ready', () => {
  const defaults = readTwitchConfig({ TWITCH_CLIENT_ID: 'id', TWITCH_CLIENT_SECRET: 'secret' });
  assert.ok(defaults);
  assert.equal(defaults.redirectUri, 'http://localhost:3001/auth/twitch/callback');
  assert.equal(isHttpsTwitchCallbackUri(undefined), false);
  assert.equal(isHttpsTwitchCallbackUri(defaults.redirectUri), false);
  assert.equal(isHttpsTwitchCallbackUri('https://localhost/auth/twitch/callback'), false);

  const explicit = readTwitchConfig({ TWITCH_CLIENT_ID: 'id', TWITCH_CLIENT_SECRET: 'secret', TWITCH_REDIRECT_URI: 'https://oauth.example.invalid/auth/twitch/callback' });
  assert.ok(explicit);
  assert.equal(explicit.redirectUri, 'https://oauth.example.invalid/auth/twitch/callback');
  assert.equal(isHttpsTwitchCallbackUri(explicit.redirectUri), true);

  assert.equal(readTwitchConfig({ TWITCH_CLIENT_ID: 'id', TWITCH_CLIENT_SECRET: 'secret', TWITCH_REDIRECT_URI: 'http://localhost:3001/auth/twitch/not-callback' }), null);
  assert.equal(readTwitchConfig({ TWITCH_CLIENT_ID: 'id', TWITCH_CLIENT_SECRET: 'secret', TWITCH_REDIRECT_URI: 'https://example.com/wrong-callback' }), null);
  assert.equal(isHttpsTwitchCallbackUri('https://oauth.example.invalid/auth/twitch/callback?next=/'), false);
});
test('production Twitch config requires a matching HTTPS dashboard origin', () => {
  const base = { NODE_ENV: 'production', TWITCH_CLIENT_ID: 'id', TWITCH_CLIENT_SECRET: 'secret', TWITCH_REDIRECT_URI: 'https://app.example.invalid/auth/twitch/callback' };
  assert.equal(readTwitchConfig(base), null);
  assert.equal(readTwitchConfig({ ...base, DASHBOARD_URL: 'http://app.example.invalid/' }), null);
  assert.equal(readTwitchConfig({ ...base, DASHBOARD_URL: 'https://other.example.invalid/' }), null);
  const config = readTwitchConfig({ ...base, DASHBOARD_URL: 'https://app.example.invalid/' });
  assert.ok(config);
  assert.equal(config.dashboardUrl, 'https://app.example.invalid/');
});
test('OAuth state is unpredictable and must match the HTTP-only callback value', () => {
  const state = createOAuthState(); assert.ok(state.length >= 40); assert.notEqual(state, createOAuthState());
  assert.equal(validateOAuthState(state, state), true); assert.equal(validateOAuthState(state, `${state}x`), false); assert.equal(validateOAuthState(undefined, state), false);
});
test('OAuth diagnostics whitelist only safe stage fields and distinguish failures', () => {
  const line = formatOAuthDiagnostic('state_validation', { stateCookiePresent: true, stateValid: false, category: 'state_mismatch', cookie: 'never-log' } as never);
  assert.deepEqual(Object.keys(JSON.parse(line)).sort(), ['category', 'stage', 'stateCookiePresent', 'stateValid']);
  assert.equal(line.includes('never-log'), false);
  assert.equal(safeOAuthErrorCategory(new Error('sensitive-code-value')), 'unexpected_error');
  assert.notEqual(oauthFailureReason('oauth_start', 'host_mismatch'), oauthFailureReason('callback_received', 'host_mismatch'));
});
test('authorization-start diagnostics identify fixed operation stages without exposing exception details', () => {
  const secretMessage = 'client_secret=do-not-log';
  const error = new TypeError(secretMessage);
  const line = formatOAuthDiagnostic('authorization_url_creation', { category: safeOAuthErrorCategory(error), errorName: safeOAuthErrorName(error) });
  assert.deepEqual(JSON.parse(line), { stage: 'authorization_url_creation', category: 'type_error', errorName: 'TypeError' });
  assert.equal(line.includes(secretMessage), false);
  const custom = new Error(secretMessage); custom.name = 'private-hostname.example';
  assert.equal(safeOAuthErrorName(custom), 'Error');
  assert.equal(createAuthorizationStartUrl(config.redirectUri), 'https://oauth.example.invalid/auth/twitch');
});
test('authorization URL requests only the read-only chat scope and code grant', () => {
  const url = new URL(createAuthorizationUrl(config, 'state-value'));
  assert.equal(url.searchParams.get('response_type'), 'code'); assert.equal(url.searchParams.get('state'), 'state-value');
  assert.equal(url.searchParams.get('redirect_uri'), config.redirectUri);
  assert.equal(url.searchParams.get('scope'), 'user:read:chat'); assert.equal(url.searchParams.has('client_secret'), false);
  assert.equal(createAuthorizationStartUrl(config.redirectUri), 'https://oauth.example.invalid/auth/twitch');
  assert.equal(requestHostMatchesCallback('oauth.example.invalid', config.redirectUri), true);
  assert.equal(requestHostMatchesCallback('localhost:5173', config.redirectUri), false);
  assert.equal(requestHostMatchesCallback('oauth.example.invalid.attacker.test', config.redirectUri), false);
  const callbackWithPort = 'https://oauth.example.invalid:8443/auth/twitch/callback';
  assert.equal(createAuthorizationStartUrl(callbackWithPort), 'https://oauth.example.invalid:8443/auth/twitch');
  assert.equal(requestHostMatchesCallback('oauth.example.invalid:8443', callbackWithPort), true);
  assert.throws(() => createAuthorizationStartUrl('http://localhost:3001/auth/twitch/callback'), /HTTPS tunnel/);
});
test('authorization code exchange validates token and resolves the authorized user', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const responses = [
    json({ access_token: 'access-test', refresh_token: 'refresh-test', expires_in: 3600, scope: ['user:read:chat'] }),
    json({ client_id: 'test-client', user_id: '12345', login: 'streamer', scopes: ['user:read:chat'], expires_in: 3600 }),
    json({ data: [{ id: '12345', login: 'streamer', display_name: 'Streamer' }] }),
  ];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: String(input), init }); return responses.shift()!; }) as typeof fetch;
  const tokenStatuses: number[] = [];
  const result = await new TwitchApi(config, fetcher, status => tokenStatuses.push(status)).exchangeCode('one-time-code');
  assert.equal(result.login, 'streamer'); assert.equal(result.accessToken, 'access-test'); assert.equal(result.refreshToken, 'refresh-test');
  assert.equal(calls[0].url, 'https://id.twitch.tv/oauth2/token'); assert.equal(calls[1].init?.headers && new Headers(calls[1].init?.headers).get('Authorization'), 'OAuth access-test');
  assert.deepEqual(tokenStatuses, [200]);
  assert.equal(new URLSearchParams(String(calls[0].init?.body)).get('redirect_uri'), config.redirectUri);
  assert.equal(calls[2].init?.headers && new Headers(calls[2].init?.headers).get('Client-Id'), 'test-client');
});
test('missing required scope and invalid validation response fail closed', async () => {
  const exchangeStatuses: number[] = [];
  const missingScope = new TwitchApi(config, (async () => json({ access_token: 'x', refresh_token: 'r', scope: [] })) as typeof fetch, status => exchangeStatuses.push(status));
  await assert.rejects(() => missingScope.exchangeCode('code'), (error: unknown) => error instanceof TwitchError && error.code === 'missing_scope');
  assert.deepEqual(exchangeStatuses, [200]);
  const rejectedExchangeStatuses: number[] = [];
  const rejectedExchange = new TwitchApi(config, (async () => json({ error: 'Unauthorized' }, 401)) as typeof fetch, status => rejectedExchangeStatuses.push(status));
  await assert.rejects(() => rejectedExchange.exchangeCode('code'), (error: unknown) => error instanceof TwitchError && error.code === 'unauthorized');
  assert.deepEqual(rejectedExchangeStatuses, [401]);
  const invalidToken = new TwitchApi(config, (async () => json({ error: 'Unauthorized' }, 401)) as typeof fetch);
  await assert.rejects(() => invalidToken.validateToken('bad-token'), (error: unknown) => error instanceof TwitchError && error.code === 'unauthorized');
});
test('refresh rotates tokens and validates the same Twitch user and scope', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []; const responses = [
    json({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600 }),
    json({ client_id: 'test-client', user_id: '12345', login: 'streamer', scopes: ['user:read:chat'], expires_in: 3600 }),
  ];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: String(input), init }); return responses.shift()!; }) as typeof fetch;
  const refreshed = await new TwitchApi(config, fetcher).refresh({ ...session, refreshToken: 'refresh+with&chars' });
  assert.equal(refreshed.accessToken, 'access-new'); assert.equal(refreshed.refreshToken, 'refresh-new');
  assert.equal(new URLSearchParams(String(calls[0].init?.body)).get('refresh_token'), 'refresh+with&chars');
});
test('chat normalization rejects malformed and unsafe payloads and caps message text', () => {
  assert.equal(normalizeChatNotification({ metadata: { message_type: 'notification', subscription_type: 'channel.follow' }, payload: {} }), null);
  assert.equal(normalizeChatNotification({ metadata: { message_type: 'notification', subscription_type: 'channel.chat.message' }, payload: {} }), null);
  const normalized = normalizeChatNotification(fakeChat('id-2', `<hello>\u0000${'x'.repeat(250)}`));
  assert.ok(normalized); assert.equal(normalized.user, 'viewer_1'); assert.equal(normalized.text.length, 180); assert.equal(normalized.text.includes('<'), false);
});
test('subscription uses broadcaster and reader user IDs with a user-token websocket transport', () => {
  assert.deepEqual(createSubscriptionRequest('12345', '12345', 'session-1'), { type: 'channel.chat.message', version: '1', condition: { broadcaster_user_id: '12345', user_id: '12345' }, transport: { method: 'websocket', session_id: 'session-1' } });
});
test('only approved viewer commands route into the existing game engine', () => {
  assert.equal(parseChatCommand('!attack'), 'attack'); assert.equal(parseChatCommand('!ATTACK extra'), 'attack'); assert.equal(parseChatCommand('!reset'), null); assert.equal(parseChatCommand('!attacknow'), null);
  const state = createState(); startEvent(state);
  assert.equal(applyAction(state, { user: 'viewer_1', command: parseChatCommand('!join')!, source: 'twitch' }).ok, true);
  const result = applyAction(state, { user: 'viewer_1', command: parseChatCommand('!attack')!, source: 'twitch' });
  assert.equal(result.ok, true); assert.equal(state.hp, state.maxHp - 100); assert.equal(state.feed[0].source, 'twitch');
});

class FakeSocket extends EventEmitter {
  closed = false;
  constructor(readonly url: string) { super(); }
  sendMessage(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value))); }
  close(code = 1000, reason = '') { if (this.closed) return; this.closed = true; this.emit('close', code, Buffer.from(reason)); }
}
const welcome = (id: string) => ({ metadata: { message_type: 'session_welcome' }, payload: { session: { id, status: 'connected', keepalive_timeout_seconds: 30 } } });

test('EventSub welcome creates a single authorized subscription and duplicate chat IDs are ignored', async () => {
  let subscribeCalls = 0; let subscriptionBody: any; let subscriptionAuth = '';
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => { subscribeCalls++; subscriptionBody = JSON.parse(String(init?.body)); subscriptionAuth = new Headers(init?.headers).get('Authorization') ?? ''; return json({ data: [{ type: 'channel.chat.message', status: 'enabled' }] }, 202); }) as typeof fetch;
  const sockets: FakeSocket[] = []; const statuses: string[] = []; const chats: string[] = []; const diagnostics: Array<{ stage: string; fields?: any }> = [];
  const connection = new TwitchEventSubConnection(new TwitchApi(config, fetcher), { onStatus: status => statuses.push(status), onChat: chat => chats.push(`${chat.user}:${chat.text}`), onDiagnostic: (stage, fields) => diagnostics.push({ stage, fields }) }, url => { const socket = new FakeSocket(url); sockets.push(socket); return socket as unknown as WebSocket; });
  const ready = connection.start(session); sockets[0].emit('open'); sockets[0].sendMessage('{malformed'); sockets[0].sendMessage(welcome('session-1')); await ready;
  assert.equal(connection.getSessionId(), 'session-1'); assert.equal(subscribeCalls, 1); assert.equal(subscriptionAuth, 'Bearer access-test');
  assert.equal(subscriptionBody.condition.broadcaster_user_id, '12345'); assert.equal(subscriptionBody.condition.user_id, '12345'); assert.equal(statuses.at(-1), 'connected');
  const event = fakeChat(); sockets[0].sendMessage(event); sockets[0].sendMessage(event); assert.deepEqual(chats, ['viewer_1:!join']);
  assert.ok(diagnostics.some(entry => entry.stage === 'eventsub_socket_open'));
  assert.ok(diagnostics.some(entry => entry.stage === 'subscription_response' && entry.fields?.httpStatus === 202));
  assert.ok(diagnostics.some(entry => entry.stage === 'subscription_confirmed' && entry.fields?.category === 'success'));
  assert.equal(diagnostics.filter(entry => entry.stage === 'chat_received').length, 2);
  assert.equal(diagnostics.filter(entry => entry.stage === 'chat_duplicate').length, 1);
  assert.ok(diagnostics.every(entry => !JSON.stringify(entry).includes('access-test') && !JSON.stringify(entry).includes('!join')));
  connection.stop(); assert.equal(sockets[0].closed, true); assert.equal(statuses.at(-1), 'disconnected');
});

test('EventSub reconnect uses Twitch migration URL and retains the subscription', async () => {
  let subscribeCalls = 0; const fetcher = (async () => { subscribeCalls++; return json({ data: [{ type: 'channel.chat.message', status: 'enabled' }] }, 202); }) as typeof fetch;
  const sockets: FakeSocket[] = []; const states: string[] = []; const messages: string[] = []; const diagnostics: string[] = [];
  const connection = new TwitchEventSubConnection(new TwitchApi(config, fetcher), { onStatus: state => states.push(state), onChat: chat => messages.push(chat.id), onDiagnostic: stage => diagnostics.push(stage) }, url => { const socket = new FakeSocket(url); sockets.push(socket); return socket as unknown as WebSocket; });
  const ready = connection.start(session); sockets[0].emit('open'); sockets[0].sendMessage(welcome('session-a')); await ready;
  const event = fakeChat('same-message'); sockets[0].sendMessage(event);
  const reconnectUrl = 'wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30&token=migration-token';
  sockets[0].sendMessage({ metadata: { message_type: 'session_reconnect' }, payload: { session: { reconnect_url: reconnectUrl } } });
  assert.equal(sockets[1].url, reconnectUrl); sockets[1].emit('open'); sockets[1].sendMessage(welcome('session-b'));
  sockets[1].sendMessage(event);
  assert.equal(sockets[0].closed, true); assert.equal(states.at(-1), 'connected'); assert.equal(subscribeCalls, 1);
  assert.deepEqual(messages, ['same-message']);
  assert.ok(diagnostics.includes('eventsub_reconnect'));
  connection.stop();
});

test('unexpected EventSub disconnect reports reconnecting and confirms a fresh subscription before connected', async () => {
  let subscribeCalls = 0;
  const fetcher = (async () => { subscribeCalls++; return json({ data: [{ type: 'channel.chat.message', status: 'enabled' }] }, 202); }) as typeof fetch;
  const sockets: FakeSocket[] = []; const states: string[] = []; const diagnostics: string[] = [];
  const connection = new TwitchEventSubConnection(new TwitchApi(config, fetcher), {
    onStatus: state => states.push(state), onChat: () => undefined, onDiagnostic: stage => diagnostics.push(stage),
  }, url => { const socket = new FakeSocket(url); sockets.push(socket); return socket as unknown as WebSocket; });
  const ready = connection.start(session);
  sockets[0].emit('open');
  sockets[0].sendMessage(welcome('session-first'));
  await ready;
  sockets[0].close(1006, 'network interruption');
  assert.equal(states.at(-1), 'reconnecting');
  assert.ok(diagnostics.includes('eventsub_disconnected'));
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = () => {
      if (sockets.length === 2) return resolve();
      if (Date.now() >= deadline) return reject(new Error('EventSub did not create a reconnect socket in time.'));
      setTimeout(poll, 25);
    };
    poll();
  });
  assert.equal(sockets.length, 2);
  assert.equal(states.at(-1), 'reconnecting');
  sockets[1].emit('open');
  sockets[1].sendMessage(welcome('session-second'));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(subscribeCalls, 2);
  assert.equal(states.at(-1), 'connected');
  connection.stop();
});

test('failed subscription never reports connected and disconnect cancels pending sockets', async () => {
  const fetcher = (async () => json({ error: 'Forbidden' }, 403)) as typeof fetch;
  const sockets: FakeSocket[] = []; const states: string[] = []; const diagnosticCategories: string[] = [];
  const connection = new TwitchEventSubConnection(new TwitchApi(config, fetcher), { onStatus: state => states.push(state), onChat: () => undefined, onDiagnostic: (_stage, fields) => { if (fields?.category) diagnosticCategories.push(fields.category); } }, url => { const socket = new FakeSocket(url); sockets.push(socket); return socket as unknown as WebSocket; });
  const ready = connection.start(session); sockets[0].emit('open'); sockets[0].sendMessage(welcome('session-fail'));
  await assert.rejects(ready); assert.ok(states.includes('connection_error')); assert.equal(states.includes('connected'), false); assert.equal(sockets[0].closed, true);
  assert.ok(diagnosticCategories.includes('http_error'));
});
