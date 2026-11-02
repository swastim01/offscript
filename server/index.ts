import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEncounterProposal, ProposalDecisions, type CommunityMessage, type EncounterProposal } from './community.js';
import { formatEventSubDiagnostic, type EventSubDiagnosticFields, type EventSubDiagnosticStage } from './eventsub-diagnostics.js';
import { applyAction, createState, endEvent, pauseEvent, prepareEncounter, recordFeed, resetEvent, resumeEvent, startEvent, tick, type Action } from './engine.js';
import { createAuthorizationStartUrl, createAuthorizationUrl, createOAuthState, isHttpsTwitchCallbackUri, parseChatCommand, readTwitchConfig, requestHostMatchesCallback, TwitchApi, TwitchEventSubConnection, TwitchError, validateOAuthState, type TwitchSession, type TwitchStatus } from './twitch.js';
import { processTwitchMessage } from './twitch-gameplay.js';
import { runDemoBattle, type DemoStage } from './demo-scenario.js';
import { disconnectTwitch } from './twitch-disconnect.js';
import { formatOAuthDiagnostic, oauthFailureReason, safeOAuthErrorCategory, safeOAuthErrorName, type OAuthDiagnosticFields, type OAuthDiagnosticStage } from './oauth-diagnostics.js';
import { readPersistentState, savePersistentState } from './persistence.js';

loadLocalEnv();
const app = express(); app.use(express.json({ limit: '16kb' }));
const httpServer = createServer(app); const wss = new WebSocketServer({ server: httpServer, path: '/socket' });
const clientBuildPath = fileURLToPath(new URL('../dist/', import.meta.url));
const clientIndexPath = resolve(clientBuildPath, 'index.html');
const dataPath = resolve(process.env.OFFSCRIPT_DATA_FILE ?? 'data/offscript.json');
const state = createState(readPersistentState(dataPath));
type ChatMessage = CommunityMessage;
const chatBuffers: Record<ChatMessage['source'], ChatMessage[]> = { simulated: [], twitch: [] }; const chatDedup = new Map<string, number>();
let proposal: EncounterProposal | null = null;
const proposalDecisions = new ProposalDecisions();
type DemoRunStatus = { active: boolean; stage: DemoStage | null };
let demoRunStatus: DemoRunStatus = { active: false, stage: null };
let demoRunSequence = 0;
function logOAuthDiagnostic(stage: OAuthDiagnosticStage, fields: OAuthDiagnosticFields = {}) { console.info(`[OFFSCRIPT_OAUTH] ${formatOAuthDiagnostic(stage, fields)}`); }
function logEventSubDiagnostic(stage: EventSubDiagnosticStage, fields: EventSubDiagnosticFields = {}) { console.info(`[OFFSCRIPT_EVENTSUB] ${formatEventSubDiagnostic(stage, fields)}`); }
const twitchConfig = readTwitchConfig(); const twitchReady = Boolean(twitchConfig && isHttpsTwitchCallbackUri(process.env.TWITCH_REDIRECT_URI?.trim()));
const twitchApi = twitchConfig ? new TwitchApi(twitchConfig, fetch, status => logOAuthDiagnostic('token_exchange', { httpStatus: status, category: status >= 200 && status < 300 ? 'success' : 'http_error' })) : null;
const twitchAuthorizationStartUrl = twitchReady && twitchConfig ? createAuthorizationStartUrl(twitchConfig.redirectUri) : null;
let twitchSession: TwitchSession | null = null; let tokenValidationTimer: NodeJS.Timeout | undefined;
let twitchStatus: TwitchStatus = { state: twitchReady ? 'needs_authorization' : 'not_configured', channel: null, message: twitchReady ? 'Connect the Twitch account that owns the channel.' : twitchConfigurationProblem(), configured: twitchReady, authorizationStartUrl: twitchAuthorizationStartUrl };
function publishTwitchStatus(next: TwitchStatus['state'], message: string | null = null) {
  twitchStatus = { state: next, channel: twitchSession ? { id: twitchSession.id, login: twitchSession.login, displayName: twitchSession.displayName } : null, message, configured: twitchReady, authorizationStartUrl: twitchAuthorizationStartUrl };
  broadcast();
}
const twitchConnection = twitchApi ? new TwitchEventSubConnection(twitchApi, {
  onStatus: (connectionState, message) => {
    if (demoRunStatus.active && ['connecting', 'connected', 'reconnecting'].includes(connectionState)) cancelDemoRun();
    if (connectionState === 'connection_error' && message?.includes('revoked')) { twitchSession = null; clearTwitchChatContext(); if (tokenValidationTimer) clearTimeout(tokenValidationTimer); }
    publishTwitchStatus(connectionState, message ?? null);
  },
  onChat: chat => receiveTwitchChat(chat.user, chat.text),
  onDiagnostic: logEventSubDiagnostic,
}) : null;
function save() {
  try { savePersistentState(dataPath, state); }
  catch (error) { console.error('Could not persist OFFSCRIPT history:', error); }
}
function broadcast() { const payload = JSON.stringify({ type: 'state', state, proposal, chatCount: { simulated: chatBuffers.simulated.length, twitch: chatBuffers.twitch.length }, connection: twitchStatus, demoRun: demoRunStatus }); for (const client of wss.clients) if (client.readyState === 1) client.send(payload); }
function cancelDemoRun() {
  if (!demoRunStatus.active) return;
  demoRunSequence++;
  demoRunStatus = { active: false, stage: null };
}
app.use('/api', (req, res, next) => {
  const canStopDemo = ['/event/pause', '/event/end', '/event/reset'].includes(req.path);
  if (demoRunStatus.active && req.method === 'POST' && !canStopDemo) {
    return res.status(409).json({ ok: false, reason: 'A simulated replay is running. Pause, end, or reset it before using other controls.' });
  }
  next();
});
function result(res: express.Response, outcome: { ok: boolean; reason?: string }, extra: object = {}) { if (outcome.ok) { if (state.phase === 'won' || state.phase === 'lost') save(); broadcast(); } res.status(outcome.ok ? 200 : 400).json({ ...outcome, ...extra, state, proposal }); }
wss.on('connection', socket => { socket.send(JSON.stringify({ type: 'state', state, proposal, chatCount: { simulated: chatBuffers.simulated.length, twitch: chatBuffers.twitch.length }, connection: twitchStatus, demoRun: demoRunStatus })); });
app.get('/api/state', (_req, res) => res.json({ ...state, proposal, chatCount: { simulated: chatBuffers.simulated.length, twitch: chatBuffers.twitch.length }, connection: twitchStatus, demoRun: demoRunStatus }));
app.get('/api/health', (_req, res) => res.json({ ok: true, mode: twitchStatus.state === 'connected' ? 'twitch+demo' : 'demo', twitchConnected: twitchStatus.state === 'connected' }));
app.get('/api/twitch/status', (_req, res) => res.json(twitchStatus));
app.get('/api/chat', (req, res) => { const source = req.query.source === 'twitch' ? 'twitch' : 'simulated'; res.json({ messages: chatBuffers[source].slice(-12), source }); });
app.get('/api/proposal', (_req, res) => res.json({ proposal }));
app.get('/auth/twitch', (req, res) => {
  let diagnosticStage: OAuthDiagnosticStage = 'config_validation';
  let hostMatchesCallback: boolean | undefined;
  try {
    if (!twitchReady || !twitchConfig) {
      logOAuthDiagnostic('oauth_start', { category: 'configuration_missing' });
      return res.status(503).json({ ok: false, stage: 'oauth_start', reason: twitchConfigurationProblem() });
    }

    diagnosticStage = 'host_validation';
    hostMatchesCallback = requestHostMatchesCallback(req.get('host'), twitchConfig.redirectUri);
    logOAuthDiagnostic('oauth_start', { hostMatchesCallback, category: hostMatchesCallback ? 'success' : 'host_mismatch' });
    if (!hostMatchesCallback) return res.status(400).json({ ok: false, stage: 'oauth_start', reason: 'OAuth start host does not match the configured HTTPS callback host. Use the Connect Twitch button from the local dashboard.' });

    diagnosticStage = 'state_cookie_creation';
    const stateToken = createOAuthState();
    const cookie = `offscript_twitch_state=${encodeURIComponent(stateToken)}; HttpOnly; SameSite=Lax; Secure; Path=/auth/twitch/callback; Max-Age=600`;

    diagnosticStage = 'authorization_url_creation';
    const authorizationUrl = createAuthorizationUrl(twitchConfig, stateToken);

    diagnosticStage = 'state_cookie_creation';
    res.setHeader('Set-Cookie', cookie);
    diagnosticStage = 'redirect';
    return res.redirect(authorizationUrl);
  } catch (error) {
    const category = safeOAuthErrorCategory(error);
    const fields: OAuthDiagnosticFields = { category };
    if (hostMatchesCallback !== undefined) fields.hostMatchesCallback = hostMatchesCallback;
    // In dev, include only a built-in/allowlisted error class name. Never log its message or stack.
    if (process.env.NODE_ENV !== 'production') fields.errorName = safeOAuthErrorName(error);
    logOAuthDiagnostic(diagnosticStage, fields);
    if (res.headersSent) { res.destroy(); return; }
    return res.status(500).json({ ok: false, stage: 'oauth_start', operation: diagnosticStage, reason: oauthFailureReason('oauth_start', category) });
  }
});
app.get('/auth/twitch/callback', async (req, res) => {
  const cookies = parseCookies(req.headers.cookie); const expected = cookies.offscript_twitch_state;
  const stateCookiePresent = typeof expected === 'string' && expected.length > 0;
  if (!twitchReady || !twitchConfig || !twitchApi || !twitchConnection) {
    logOAuthDiagnostic('callback_received', { hostMatchesCallback: false, stateCookiePresent, category: 'configuration_missing' });
    return res.status(503).json({ ok: false, stage: 'callback_received', reason: twitchConfigurationProblem() });
  }
  const hostMatches = requestHostMatchesCallback(req.get('host'), twitchConfig.redirectUri);
  logOAuthDiagnostic('callback_received', { hostMatchesCallback: hostMatches, stateCookiePresent, category: hostMatches ? 'success' : 'host_mismatch' });
  if (!hostMatches) return res.status(400).json({ ok: false, stage: 'callback_received', reason: 'OAuth callback host does not match the configured HTTPS callback host.' });
  const received = typeof req.query.state === 'string' ? req.query.state : undefined;
  res.setHeader('Set-Cookie', 'offscript_twitch_state=; HttpOnly; SameSite=Lax; Secure; Path=/auth/twitch/callback; Max-Age=0');
  const stateValid = validateOAuthState(expected, received);
  logOAuthDiagnostic('state_validation', { stateCookiePresent, stateValid, category: !stateCookiePresent ? 'state_cookie_missing' : stateValid ? 'success' : 'state_mismatch' });
  if (!stateValid) return redirectTwitchResult(res, 'error', stateCookiePresent ? 'OAuth state did not match. Start the connection again from OFFSCRIPT.' : 'OAuth state cookie was missing. Open Connect Twitch from the dashboard and retry.', 'state_validation');
  if (typeof req.query.error === 'string') {
    logOAuthDiagnostic('callback_received', { category: req.query.error === 'access_denied' ? 'access_denied' : 'unexpected_error' });
    return redirectTwitchResult(res, 'error', req.query.error === 'access_denied' ? 'Twitch authorization was cancelled.' : 'Twitch returned an authorization error.', 'callback_received');
  }
  if (typeof req.query.code !== 'string' || !req.query.code) {
    logOAuthDiagnostic('callback_received', { category: 'code_missing' });
    return redirectTwitchResult(res, 'error', 'Twitch did not return an authorization code.', 'callback_received');
  }
  let failureStage: OAuthDiagnosticStage = 'token_exchange';
  try {
    publishTwitchStatus('connecting', 'Validating Twitch authorization and starting EventSub.');
    const session = await twitchApi.exchangeCode(req.query.code, stage => { failureStage = stage; logOAuthDiagnostic(stage); });
    logOAuthDiagnostic('authorization_result', { category: 'success' });
    failureStage = 'eventsub_start'; logOAuthDiagnostic('eventsub_start');
    twitchSession = session;
    await twitchConnection.start(session);
    scheduleTwitchValidation(); redirectTwitchResult(res, 'connected');
  } catch (error) {
    twitchSession = null; clearTwitchChatContext(); twitchConnection.stop(false);
    const category = safeOAuthErrorCategory(error);
    logOAuthDiagnostic(failureStage, { category });
    const message = oauthFailureReason(failureStage, category);
    publishTwitchStatus('connection_error', message); redirectTwitchResult(res, 'error', message, failureStage);
  }
});
app.post('/api/twitch/disconnect', async (_req, res) => {
  if (tokenValidationTimer) clearTimeout(tokenValidationTimer); tokenValidationTimer = undefined;
  const session = twitchSession;
  const diagnostic = await disconnectTwitch({
    stop: () => twitchConnection?.stop(false),
    clear: () => { twitchSession = null; clearTwitchChatContext(); },
    revoke: session && twitchApi ? () => twitchApi.revoke(session.accessToken) : null,
    publish: message => publishTwitchStatus(twitchReady ? 'disconnected' : 'not_configured', message),
    disconnectedMessage: twitchReady ? 'Disconnected from Twitch. Demo mode remains available.' : twitchConfigurationProblem(),
    revocationFailureMessage: 'Disconnected locally, but Twitch did not confirm token revocation. You can revoke OFFSCRIPT from Twitch Connections.',
  });
  res.json({ ok: true, connection: twitchStatus });
});
app.post('/api/event/start', (_req, res) => result(res, startEvent(state)));
app.post('/api/event/pause', (_req, res) => { const out = pauseEvent(state); if (out.ok) cancelDemoRun(); return result(res, out); });
app.post('/api/event/resume', (_req, res) => result(res, resumeEvent(state)));
app.post('/api/event/end', (_req, res) => { const out = endEvent(state); if (out.ok) cancelDemoRun(); return result(res, out); });
app.post('/api/event/reset', (_req, res) => { const r = resetEvent(state); cancelDemoRun(); if (proposal) proposalDecisions.remember(proposal); proposal = null; return result(res, r); });
app.post('/api/action', (req, res) => result(res, applyAction(state, { ...(req.body ?? {}), source: 'simulated' } as Action), { source: 'simulated' }));
app.post('/api/mock', (req, res) => {
  const action = { ...(req.body ?? {}), source: 'simulated' } as Action;
  const out = applyAction(state, action);
  if (!out.ok && typeof action.command === 'string') { recordFeed(state, action.user, `Demo !${action.command} ignored: ${out.reason}`, 'simulated'); broadcast(); }
  return result(res, out, { source: 'simulated' });
});
app.post('/api/chat/message', (req, res) => {
  const user = typeof req.body?.user === 'string' ? req.body.user.trim().replace(/^@/, '').slice(0, 24) : '';
  const text = typeof req.body?.text === 'string' ? req.body.text.replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 180) : '';
  if (!/^[\w-]{1,24}$/.test(user) || text.length < 3) return res.status(400).json({ ok: false, reason: 'Enter a valid username and a message of at least 3 characters.' });
  if (req.body?.source !== 'simulated') return res.status(400).json({ ok: false, reason: 'Only explicitly simulated chat is enabled. Twitch is not connected.' });
  const now = Date.now(); const dedupKey = `${user.toLowerCase()}:${text.toLowerCase()}`;
  if (chatDedup.has(dedupKey) && now - chatDedup.get(dedupKey)! < 10000) return res.status(409).json({ ok: false, reason: 'Duplicate message ignored.' });
  chatDedup.set(dedupKey, now); for (const [key, at] of chatDedup) if (now - at > 60000) chatDedup.delete(key);
  const command = parseChatCommand(text);
  if (command) {
    const out = applyAction(state, { user, command, source: 'simulated' });
    if (!out.ok) recordFeed(state, user, `Simulated !${command} ignored: ${out.reason}`, 'simulated');
    return result(res, out, { source: 'simulated' });
  }
  const message = { user, text, source: 'simulated' as const, at: now }; chatBuffers.simulated.push(message); if (chatBuffers.simulated.length > 60) chatBuffers.simulated.splice(0, chatBuffers.simulated.length - 60);
  recordFeed(state, user, `Simulated chat: “${text}”`, 'simulated');
  maybeCreateProposal(chatBuffers.simulated);
  broadcast(); res.json({ ok: true, message, proposal, state });
});
app.post('/api/encounter/approve', (_req, res) => {
  if (!proposal) return res.status(400).json({ ok: false, reason: 'Add a few chat messages to create an encounter proposal.' });
  const activeProposal = proposal;
  const out = prepareEncounter(state, activeProposal.boss, activeProposal.theme);
  if (out.ok) { proposalDecisions.remember(activeProposal); proposal = null; }
  return result(res, out);
});
app.post('/api/encounter/reject', (_req, res) => {
  if (!proposal) return res.status(400).json({ ok: false, reason: 'There is no encounter proposal to decline.' });
  const rejectedProposal = proposal;
  proposalDecisions.remember(rejectedProposal);
  proposal = null;
  recordFeed(state, 'STREAMER', `Declined encounter proposal: ${rejectedProposal.boss}.`);
  return result(res, { ok: true, reason: 'Proposal declined. New repeated phrases can still create another proposal.' });
});
app.post('/api/demo/conversation', (_req, res) => {
  const sample = [
    ['MossMage', 'one more run, the build is almost ready'], ['ByteBard', 'one more run! surely the build works now'],
    ['PixelPilot', 'one more run for science'], ['CozyChaos', 'the one more run curse is real'],
  ];
  const now = Date.now(); for (const [user, text] of sample) { chatBuffers.simulated.push({ user, text, source: 'simulated', at: now }); recordFeed(state, user, `Simulated chat: “${text}”`, 'simulated'); }
  if (chatBuffers.simulated.length > 60) chatBuffers.simulated.splice(0, chatBuffers.simulated.length - 60); maybeCreateProposal(chatBuffers.simulated); broadcast(); res.json({ ok: true, source: 'simulated conversation', count: sample.length, proposal, state });
});
app.post('/api/demo/run', (_req, res) => {
  if (twitchStatus.state === 'connected') return res.status(409).json({ ok: false, reason: 'Disconnect Twitch before running the simulated replay so real and demo activity stay separate.' });
  if (state.phase === 'live' || state.phase === 'paused') return res.status(400).json({ ok: false, reason: 'End or reset the live encounter before running the repeatable demo scenario.' });
  const runId = ++demoRunSequence;
  demoRunStatus = { active: true, stage: 'awakening' };
  const replay = runDemoBattle(state, stage => {
    if (runId !== demoRunSequence) return;
    demoRunStatus = { active: true, stage };
    if (stage === 'victory') save();
    broadcast();
  }, undefined, () => runId !== demoRunSequence);
  res.status(202).json({ ok: true, message: 'Simulated arena replay started. Watch the boss phases and the labeled demo feed.', state, proposal, demoRun: demoRunStatus });
  void replay.then(() => {
    if (runId !== demoRunSequence) return;
    demoRunStatus = { active: false, stage: null };
    broadcast();
  }).catch(() => {
    if (runId !== demoRunSequence) return;
    demoRunStatus = { active: false, stage: null };
    console.error('[OFFSCRIPT] simulated replay failed (unexpected_error)');
    broadcast();
  });
});
app.use('/api', (_req, res) => res.status(404).json({ ok: false, reason: 'API route not found.' }));
app.use('/auth', (_req, res) => res.status(404).json({ ok: false, reason: 'Authentication route not found.' }));
if (process.env.NODE_ENV === 'production') {
  if (!existsSync(clientIndexPath)) throw new Error('Production frontend build is missing. Run npm run build before npm start.');
  app.use(express.static(clientBuildPath, { index: false }));
  app.get('*', (req, res, next) => {
    if (!req.get('accept')?.includes('text/html')) return next();
    return res.sendFile(clientIndexPath, error => { if (error) next(error); });
  });
}
app.use((_req, res) => res.status(404).json({ ok: false, reason: 'Route not found.' }));
app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const invalidJson = error instanceof SyntaxError && (error as SyntaxError & { status?: number }).status === 400;
  const twitchRoute = req.path === '/auth/twitch' || req.path === '/auth/twitch/callback';
  const stage: OAuthDiagnosticStage = req.path === '/auth/twitch' ? 'oauth_start' : req.path === '/auth/twitch/callback' ? 'callback_received' : 'oauth_error';
  const category = invalidJson ? 'invalid_json' : safeOAuthErrorCategory(error);
  if (twitchRoute) logOAuthDiagnostic(stage, { hostMatchesCallback: Boolean(twitchConfig && requestHostMatchesCallback(req.get('host'), twitchConfig.redirectUri)), category });
  else console.error(`[OFFSCRIPT] request failed (${category})`);
  const reason = invalidJson
    ? 'Request body must contain valid JSON.'
    : twitchRoute
      ? oauthFailureReason(stage, category)
      : 'Request could not be processed.';
  res.status(invalidJson ? 400 : 500).json({ ok: false, stage, reason });
});
const gameTimer = setInterval(() => { const phase = state.phase; const seconds = state.secondsLeft; tick(state); if (phase !== state.phase || seconds !== state.secondsLeft) { if (phase === 'live' && ['won', 'lost'].includes(state.phase)) save(); broadcast(); } }, 1000); gameTimer.unref();
const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST?.trim() || '0.0.0.0';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port number.');
httpServer.listen(port, host, () => console.log(`OFFSCRIPT server listening on ${host}:${port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  clearInterval(gameTimer); if (tokenValidationTimer) clearTimeout(tokenValidationTimer); twitchSession = null; clearTwitchChatContext(); twitchConnection?.stop(false); httpServer.close();
});

function receiveTwitchChat(user: string, rawText: string) {
  if (demoRunStatus.active) cancelDemoRun();
  const processed = processTwitchMessage(state, user, rawText);
  if (processed.kind === 'empty') {
    logEventSubDiagnostic('chat_processed', { category: 'invalid_message', commandRecognized: false });
    return;
  }
  if (processed.kind === 'command') {
    if (processed.completed) save();
    logEventSubDiagnostic('chat_processed', { category: processed.accepted ? 'command_applied' : 'command_rejected', commandRecognized: true });
    broadcast(); return;
  }
  const message = { user, text: processed.text, source: 'twitch' as const, at: Date.now() }; chatBuffers.twitch.push(message); if (chatBuffers.twitch.length > 60) chatBuffers.twitch.splice(0, chatBuffers.twitch.length - 60);
  recordFeed(state, user, `Twitch chat: “${processed.text}”`, 'twitch'); maybeCreateProposal(chatBuffers.twitch);
  logEventSubDiagnostic('chat_processed', { category: 'chat_recorded', commandRecognized: false });
  broadcast();
}

function scheduleTwitchValidation() {
  if (tokenValidationTimer) clearTimeout(tokenValidationTimer);
  if (!twitchSession || !twitchApi) return;
  const delay = Math.min(60 * 60 * 1000, Math.max(30_000, twitchSession.expiresAt - Date.now() - 5 * 60 * 1000));
  tokenValidationTimer = setTimeout(() => { void validateTwitchSession(); }, delay); tokenValidationTimer.unref();
}
async function validateTwitchSession() {
  if (!twitchSession || !twitchApi) return;
  const current = twitchSession;
  try {
    let validation;
    try { validation = await twitchApi.validateToken(current.accessToken); }
    catch (error) {
      if (!(error instanceof TwitchError) || error.code !== 'unauthorized') {
        publishTwitchStatus(twitchStatus.state, 'Twitch token check is temporarily unavailable. OFFSCRIPT will retry shortly.');
        tokenValidationTimer = setTimeout(() => { void validateTwitchSession(); }, 60_000); tokenValidationTimer.unref(); return;
      }
      twitchSession = await twitchApi.refresh(current); twitchConnection?.updateSession(twitchSession); scheduleTwitchValidation(); return;
    }
    if (validation.client_id !== twitchConfig?.clientId || validation.user_id !== current.id || !validation.scopes.includes('user:read:chat')) throw new TwitchError('Twitch authorization changed. Reconnect the channel.', 'authorization_changed');
    if (validation.expires_in < 300) { twitchSession = await twitchApi.refresh(current); twitchConnection?.updateSession(twitchSession); }
    scheduleTwitchValidation();
  } catch (error) {
    twitchConnection?.stop(false); twitchSession = null; clearTwitchChatContext();
    const message = error instanceof Error ? error.message : 'Twitch authorization expired. Reconnect the channel.';
    publishTwitchStatus('connection_error', safeTwitchMessage(message));
  }
}
function clearTwitchChatContext() { chatBuffers.twitch.length = 0; if (proposal?.source === 'Twitch chat') proposal = null; }
function twitchConfigurationProblem() {
  const problems: string[] = [];
  if (!process.env.TWITCH_CLIENT_ID?.trim() || !process.env.TWITCH_CLIENT_SECRET?.trim()) problems.push('Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in .env.');
  const redirectUri = process.env.TWITCH_REDIRECT_URI?.trim();
  if (!redirectUri) problems.push('Set TWITCH_REDIRECT_URI to the HTTPS Cloudflare Quick Tunnel URL ending in /auth/twitch/callback.');
  else if (!isHttpsTwitchCallbackUri(redirectUri)) problems.push('TWITCH_REDIRECT_URI must be the exact HTTPS tunnel URL ending in /auth/twitch/callback, with no query string or fragment.');
  if (process.env.NODE_ENV === 'production') {
    const dashboardUrl = process.env.DASHBOARD_URL?.trim();
    if (!dashboardUrl) problems.push('Set DASHBOARD_URL to the permanent HTTPS deployment origin with a trailing slash.');
    else if (redirectUri) {
      try {
        const dashboard = new URL(dashboardUrl);
        const callback = new URL(redirectUri);
        if (dashboard.protocol !== 'https:' || dashboard.origin !== callback.origin || dashboard.pathname !== '/' || dashboard.search || dashboard.hash) problems.push('In production, DASHBOARD_URL must be the HTTPS root of the same origin as TWITCH_REDIRECT_URI.');
      } catch { problems.push('DASHBOARD_URL must be the HTTPS root of the same origin as TWITCH_REDIRECT_URI.'); }
    }
  }
  return problems.length ? problems.join(' ') : 'Twitch is ready for authorization.';
}
function redirectTwitchResult(res: express.Response, result: 'connected' | 'error', message?: string, stage?: OAuthDiagnosticStage) {
  const target = new URL(twitchConfig?.dashboardUrl ?? 'http://localhost:5173/'); target.searchParams.set('twitch', result);
  if (message) target.searchParams.set('twitchMessage', message.slice(0, 220));
  if (stage) target.searchParams.set('twitchStage', stage);
  res.redirect(target.toString());
}
function safeTwitchMessage(message: string) { return message.replace(/(?:access|refresh|client)_token[^\s]*/gi, '[redacted]').replace(/[\r\n\u0000-\u001f]/g, ' ').slice(0, 220); }
function parseCookies(header: string | undefined) {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) { const index = part.indexOf('='); if (index < 0) continue; const key = part.slice(0, index).trim(); try { cookies[key] = decodeURIComponent(part.slice(index + 1).trim()); } catch { /* ignore malformed cookie */ } }
  return cookies;
}
function loadLocalEnv() {
  const envPath = resolve('.env'); if (!existsSync(envPath)) return;
  try { for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) { const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line); if (!match || process.env[match[1]] !== undefined) continue; let value = match[2]; if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1); process.env[match[1]] = value; } }
  catch { /* .env is optional; configuration status will explain if required values are absent */ }
}

function maybeCreateProposal(messages: ChatMessage[]) {
  if (proposal) return;
  const candidate = createEncounterProposal(messages);
  if (candidate && !proposalDecisions.has(candidate)) proposal = candidate;
}
