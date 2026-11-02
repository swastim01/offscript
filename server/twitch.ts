import { randomBytes, timingSafeEqual } from 'node:crypto';
import WebSocket from 'ws';
import type { EventSubDiagnosticFields, EventSubDiagnosticStage } from './eventsub-diagnostics.js';
export { createAuthorizationStartUrl, isHttpsTwitchCallbackUri, requestHostMatchesCallback } from './twitch-url.js';

export const TWITCH_SCOPE = 'user:read:chat';
export const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws';
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';
const USERS_URL = 'https://api.twitch.tv/helix/users';
const SUBSCRIPTIONS_URL = 'https://api.twitch.tv/helix/eventsub/subscriptions';
const MAX_CHAT_TEXT = 180;

export type TwitchConfig = { clientId: string; clientSecret: string; redirectUri: string; dashboardUrl: string };
export type TwitchIdentity = { id: string; login: string; displayName: string };
export type TwitchSession = TwitchIdentity & { accessToken: string; refreshToken: string; expiresAt: number; scopes: string[] };
export type TwitchStatus = {
  state: 'not_configured' | 'needs_authorization' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'connection_error';
  channel: TwitchIdentity | null; message: string | null; configured: boolean; authorizationStartUrl: string | null;
};
export type NormalizedChat = { id: string; user: string; userId: string; text: string; sentAt: string };
type Fetcher = typeof fetch;
type Socket = WebSocket;
type SocketFactory = (url: string) => Socket;
type EventSubEnvelope = { metadata?: { message_type?: string; message_id?: string; message_timestamp?: string; subscription_type?: string }; payload?: Record<string, any> };

export class TwitchError extends Error { constructor(message: string, readonly code = 'twitch_error') { super(message); this.name = 'TwitchError'; } }

export function readTwitchConfig(env: NodeJS.ProcessEnv = process.env): TwitchConfig | null {
  const clientId = env.TWITCH_CLIENT_ID?.trim(); const clientSecret = env.TWITCH_CLIENT_SECRET?.trim();
  const redirectUri = env.TWITCH_REDIRECT_URI?.trim() || 'http://localhost:3001/auth/twitch/callback';
  if (!clientId || !clientSecret) return null;
  let parsed: URL; try { parsed = new URL(redirectUri); } catch { return null; }
  if (!['http:', 'https:'].includes(parsed.protocol) || (parsed.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) || parsed.username || parsed.password || parsed.pathname !== '/auth/twitch/callback' || parsed.search || parsed.hash) return null;
  const configuredDashboardUrl = env.DASHBOARD_URL?.trim();
  if (env.NODE_ENV === 'production' && !configuredDashboardUrl) return null;
  const dashboardUrl = configuredDashboardUrl || 'http://localhost:5173/';
  let dashboard: URL; try { dashboard = new URL(dashboardUrl); } catch { return null; }
  if (!['http:', 'https:'].includes(dashboard.protocol) || dashboard.username || dashboard.password) return null;
  if (env.NODE_ENV === 'production' && (dashboard.protocol !== 'https:' || dashboard.origin !== parsed.origin || dashboard.pathname !== '/' || dashboard.search || dashboard.hash)) return null;
  return { clientId, clientSecret, redirectUri, dashboardUrl: dashboard.toString() };
}
export function createOAuthState() { return randomBytes(32).toString('base64url'); }
export function validateOAuthState(expected: string | undefined, received: string | undefined) {
  if (!expected || !received) return false;
  const left = Buffer.from(expected); const right = Buffer.from(received);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function createAuthorizationUrl(config: TwitchConfig, state: string) {
  const url = new URL('https://id.twitch.tv/oauth2/authorize');
  url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', scope: TWITCH_SCOPE, state }).toString();
  return url.toString();
}
export function createSubscriptionRequest(broadcasterId: string, userId: string, sessionId: string) {
  return { type: 'channel.chat.message', version: '1', condition: { broadcaster_user_id: broadcasterId, user_id: userId }, transport: { method: 'websocket', session_id: sessionId } };
}
export function parseChatCommand(text: string): 'join' | 'attack' | 'shield' | 'inspect' | 'lore' | null {
  const command = /^!(join|attack|shield|inspect|lore)(?:\s|$)/i.exec(text)?.[1]?.toLowerCase();
  return command === 'join' || command === 'attack' || command === 'shield' || command === 'inspect' || command === 'lore' ? command : null;
}

export class TwitchApi {
  constructor(readonly config: TwitchConfig, private readonly fetcher: Fetcher = fetch, private readonly onAuthorizationCodeResponse?: (status: number) => void) {}

  async exchangeCode(code: string, onStage?: (stage: 'token_exchange' | 'token_validation' | 'user_lookup') => void): Promise<TwitchSession> {
    const body = new URLSearchParams({ client_id: this.config.clientId, client_secret: this.config.clientSecret, code, grant_type: 'authorization_code', redirect_uri: this.config.redirectUri });
    onStage?.('token_exchange');
    const token = await this.requestJson<{ access_token?: string; refresh_token?: string; expires_in?: number; scope?: string[] }>(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }, 'Twitch rejected the authorization code.', status => this.onAuthorizationCodeResponse?.(status));
    if (!token.access_token || !token.refresh_token || !token.scope?.includes(TWITCH_SCOPE)) throw new TwitchError('Twitch did not grant the required read-only chat permission.', 'missing_scope');
    onStage?.('token_validation');
    const validated = await this.validateToken(token.access_token);
    if (validated.client_id !== this.config.clientId || !validated.user_id || !validated.scopes.includes(TWITCH_SCOPE)) throw new TwitchError('The returned Twitch token does not match this application or required permission.', 'token_mismatch');
    onStage?.('user_lookup');
    const user = await this.getCurrentUser(token.access_token);
    if (user.id !== validated.user_id) throw new TwitchError('Twitch user identity did not match the authorized token.', 'identity_mismatch');
    return { ...user, accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: Date.now() + (token.expires_in ?? 14400) * 1000, scopes: validated.scopes };
  }

  async validateToken(accessToken: string) {
    const data = await this.requestJson<{ client_id?: string; user_id?: string; login?: string; scopes?: string[]; expires_in?: number }>(VALIDATE_URL, { headers: { Authorization: `OAuth ${accessToken}` } }, 'Twitch access token validation failed.');
    if (!data.client_id || !data.user_id || !Array.isArray(data.scopes)) throw new TwitchError('Twitch returned incomplete token validation data.', 'invalid_token_response');
    return { client_id: data.client_id, user_id: data.user_id, login: data.login ?? '', scopes: data.scopes, expires_in: data.expires_in ?? 0 };
  }

  async getCurrentUser(accessToken: string): Promise<TwitchIdentity> {
    const data = await this.requestJson<{ data?: Array<{ id: string; login: string; display_name: string }> }>(USERS_URL, { headers: { 'Client-Id': this.config.clientId, Authorization: `Bearer ${accessToken}` } }, 'Could not retrieve the authorized Twitch account.');
    const user = data.data?.[0]; if (!user?.id || !user.login) throw new TwitchError('Twitch did not return the authorized channel identity.', 'missing_user');
    return { id: user.id, login: user.login, displayName: user.display_name || user.login };
  }

  async refresh(session: TwitchSession): Promise<TwitchSession> {
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: session.refreshToken, client_id: this.config.clientId, client_secret: this.config.clientSecret });
    const token = await this.requestJson<{ access_token?: string; refresh_token?: string; expires_in?: number; scope?: string[] }>(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }, 'Twitch authorization expired. Reconnect the channel.');
    if (!token.access_token || !token.refresh_token) throw new TwitchError('Twitch could not refresh authorization. Reconnect the channel.', 'refresh_failed');
    const validation = await this.validateToken(token.access_token);
    if (validation.client_id !== this.config.clientId || validation.user_id !== session.id || !validation.scopes.includes(TWITCH_SCOPE)) throw new TwitchError('Refreshed Twitch authorization no longer has the required identity and scope.', 'refresh_mismatch');
    return { ...session, accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: Date.now() + (token.expires_in ?? 14400) * 1000, scopes: validation.scopes };
  }

  async revoke(accessToken: string) {
    let response: Response;
    try { response = await this.fetcher('https://id.twitch.tv/oauth2/revoke', { method: 'POST', signal: AbortSignal.timeout(8000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.config.clientId, token: accessToken }) }); }
    catch { throw new TwitchError('Could not reach Twitch to revoke the token.', 'network_error'); }
    if (!response.ok) throw new TwitchError('Twitch did not confirm token revocation.', `http_${response.status}`);
  }

  async createChatSubscription(accessToken: string, userId: string, sessionId: string, signal?: AbortSignal, onResponse?: (status: number) => void) {
    const data = await this.requestJson<{ data?: Array<{ type?: string; status?: string }> }>(SUBSCRIPTIONS_URL, {
      method: 'POST', signal, headers: { 'Client-Id': this.config.clientId, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(createSubscriptionRequest(userId, userId, sessionId)),
    }, 'Twitch could not create the chat subscription.', onResponse);
    if (!data.data?.some(subscription => subscription.type === 'channel.chat.message' && subscription.status === 'enabled')) throw new TwitchError('Twitch did not enable the chat message subscription.', 'subscription_not_enabled');
  }

  private async requestJson<T>(url: string, init: RequestInit, failure: string, onResponse?: (status: number) => void): Promise<T> {
    let response: Response; try { response = await this.fetcher(url, { ...init, signal: init.signal ?? AbortSignal.timeout(10000) }); } catch { throw new TwitchError('Could not reach Twitch. Check your network and try again.', 'network_error'); }
    onResponse?.(response.status);
    let data: any; try { data = await response.json(); } catch { throw new TwitchError(failure, 'invalid_response'); }
    if (!response.ok) {
      const status = response.status === 401 ? 'Twitch authorization is invalid or expired. Reconnect the channel.' : failure;
      throw new TwitchError(status, response.status === 401 ? 'unauthorized' : `http_${response.status}`);
    }
    return data as T;
  }
}

export function normalizeChatNotification(envelope: EventSubEnvelope): NormalizedChat | null {
  if (envelope.metadata?.message_type !== 'notification' || envelope.metadata.subscription_type !== 'channel.chat.message') return null;
  const event = envelope.payload?.event;
  if (!event || typeof event !== 'object') return null;
  const message = event.message; const id = typeof message?.message_id === 'string' ? message.message_id : typeof event.message_id === 'string' ? event.message_id : '';
  const userId = typeof event.chatter_user_id === 'string' ? event.chatter_user_id : '';
  const rawUser = typeof event.chatter_user_login === 'string' ? event.chatter_user_login : userId;
  const user = rawUser.trim().toLowerCase().slice(0, 25);
  const text = typeof message?.text === 'string' ? Array.from(message.text.replace(/[<>\u0000-\u001f\u007f]/g, '').trim()).slice(0, MAX_CHAT_TEXT).join('') : '';
  if (!id || !userId || !/^[a-z0-9_-]{1,25}$/.test(user) || !text) return null;
  return { id, user, userId, text, sentAt: envelope.metadata?.message_timestamp ?? '' };
}

type ConnectionCallbacks = {
  onStatus: (state: TwitchStatus['state'], message?: string | null) => void;
  onChat: (chat: NormalizedChat) => void;
  onDiagnostic?: (stage: EventSubDiagnosticStage, fields?: EventSubDiagnosticFields) => void;
};
type SocketRecord = { migration: boolean; keepaliveSeconds: number; welcomeTimer?: NodeJS.Timeout; keepaliveTimer?: NodeJS.Timeout };
export class TwitchEventSubConnection {
  private readonly factory: SocketFactory;
  private sockets = new Map<Socket, SocketRecord>();
  private active: Socket | null = null;
  private migration: Socket | null = null;
  private reconnectTimer?: NodeJS.Timeout;
  private startupTimer?: NodeJS.Timeout;
  private stopped = true;
  private backoff = 1000;
  private session?: TwitchSession;
  private sessionId: string | null = null;
  private startupResolve?: () => void;
  private startupReject?: (error: Error) => void;
  private startupDone = false;
  private seenMessages = new Set<string>();
  private readonly callbacks: ConnectionCallbacks;

  constructor(private readonly api: TwitchApi, callbacks: ConnectionCallbacks, socketFactory?: SocketFactory) {
    this.callbacks = callbacks; this.factory = socketFactory ?? (url => new WebSocket(url));
  }

  getSessionId() { return this.sessionId; }
  updateSession(session: TwitchSession) { this.session = session; }

  start(session: TwitchSession): Promise<void> {
    this.stop(false); this.stopped = false; this.session = session; this.sessionId = null; this.startupDone = false; this.seenMessages.clear();
    this.diagnostic('eventsub_connecting', { category: 'started' });
    this.callbacks.onStatus('connecting', 'Opening Twitch EventSub and subscribing to this channel.');
    const startup = new Promise<void>((resolve, reject) => {
      this.startupResolve = resolve; this.startupReject = reject;
      this.startupTimer = setTimeout(() => {
        if (this.startupDone) return; this.startupDone = true; this.startupTimer = undefined;
        this.diagnostic('eventsub_error', { category: 'startup_timeout' });
        this.startupReject?.(new TwitchError('Twitch EventSub did not become ready. Check network access and try again.', 'startup_timeout'));
        this.startupResolve = undefined; this.startupReject = undefined; this.callbacks.onStatus('connection_error', 'Twitch EventSub did not become ready. Check network access and try again.'); this.stop(false);
      }, 30000);
    });
    this.openSocket(EVENTSUB_URL, false); return startup;
  }

  stop(report = true) {
    this.stopped = true; if (this.reconnectTimer) clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined;
    if (this.startupTimer) clearTimeout(this.startupTimer); this.startupTimer = undefined;
    if (!this.startupDone && this.startupReject) { this.startupDone = true; this.startupReject(new TwitchError('Twitch connection was stopped.', 'stopped')); this.startupResolve = undefined; this.startupReject = undefined; }
    const sockets = [...this.sockets.entries()]; this.sockets.clear(); this.active = null; this.migration = null; this.sessionId = null; this.session = undefined;
    for (const [socket, record] of sockets) { if (record.welcomeTimer) clearTimeout(record.welcomeTimer); if (record.keepaliveTimer) clearTimeout(record.keepaliveTimer); }
    for (const [socket] of sockets) { try { socket.close(1000, 'OFFSCRIPT disconnect'); } catch { /* already closed */ } }
    if (report) this.callbacks.onStatus('disconnected', 'Twitch is disconnected. Demo mode remains available.');
  }

  private openSocket(url: string, migration: boolean) {
    if (this.stopped) return;
    let socket: Socket;
    try { socket = this.factory(url); } catch { this.diagnostic('eventsub_error', { category: 'socket_error' }); this.failOrRetry('Could not open the Twitch EventSub connection.'); return; }
    const record: SocketRecord = { migration, keepaliveSeconds: 10 }; this.sockets.set(socket, record); if (migration) this.migration = socket; else this.active = socket;
    record.welcomeTimer = setTimeout(() => { if (this.sockets.has(socket)) { socket.close(); this.failOrRetry('Twitch EventSub did not send a welcome message in time.'); } }, 10000);
    socket.on('open', () => this.diagnostic('eventsub_socket_open', { category: migration ? 'migration' : 'success' }));
    socket.on('message', raw => {
      const frame = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
      void this.onMessage(socket, frame.toString('utf8'));
    });
    socket.on('error', () => { if (!this.stopped) { this.diagnostic('eventsub_error', { category: 'socket_error' }); this.callbacks.onStatus('reconnecting', 'Twitch EventSub connection interrupted; reconnecting.'); } });
    socket.on('close', () => this.onClose(socket));
  }

  private async onMessage(socket: Socket, raw: string) {
    const record = this.sockets.get(socket); if (!record || this.stopped) return;
    let envelope: EventSubEnvelope; try { envelope = JSON.parse(raw) as EventSubEnvelope; } catch { return; }
    const metadata = envelope.metadata; if (!metadata?.message_type) return;
    if (metadata.message_type === 'session_welcome') {
      if (record.welcomeTimer) clearTimeout(record.welcomeTimer); const session = envelope.payload?.session;
      const sessionId = typeof session?.id === 'string' ? session.id : '';
      const keepalive = typeof session?.keepalive_timeout_seconds === 'number' ? session.keepalive_timeout_seconds : 10;
      if (!sessionId || session?.status !== 'connected') { this.diagnostic('eventsub_welcome', { category: 'invalid_welcome' }); socket.close(); return this.failOrRetry('Twitch EventSub welcome message did not confirm a connected session.'); }
      this.sessionId = sessionId;
      record.keepaliveSeconds = keepalive; this.resetKeepalive(socket, keepalive);
      if (record.migration) {
        const old = this.active; this.active = socket; this.migration = null; record.migration = false; this.backoff = 1000;
        if (old && old !== socket) old.close(1000, 'EventSub session migrated');
        this.diagnostic('eventsub_welcome', { category: 'migration' });
        this.diagnostic('eventsub_reconnect', { category: 'success' });
        this.diagnostic('subscription_confirmed', { category: 'migration' });
        this.callbacks.onStatus('connected', 'Twitch EventSub session migrated; chat subscription retained.'); return;
      }
      this.diagnostic('eventsub_welcome', { category: 'success' });
      try {
        const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 8000);
        this.diagnostic('subscription_request', { category: 'started' });
        try { await this.api.createChatSubscription(this.session!.accessToken, this.session!.id, sessionId, controller.signal, status => this.diagnostic('subscription_response', { httpStatus: status, category: status >= 200 && status < 300 ? 'success' : 'http_error' })); }
        finally { clearTimeout(timeout); }
        if (this.stopped || this.active !== socket) return;
        this.diagnostic('subscription_confirmed', { category: 'success' });
        this.backoff = 1000; this.callbacks.onStatus('connected', 'Subscribed to channel chat messages.');
        if (!this.startupDone) { this.startupDone = true; if (this.startupTimer) clearTimeout(this.startupTimer); this.startupTimer = undefined; this.startupResolve?.(); this.startupResolve = undefined; this.startupReject = undefined; }
      } catch (error) {
        this.diagnostic('eventsub_error', { category: eventSubErrorCategory(error) });
        const message = error instanceof Error ? error.message : 'Twitch chat subscription failed.';
        if (!this.startupDone) { this.startupDone = true; if (this.startupTimer) clearTimeout(this.startupTimer); this.startupTimer = undefined; this.startupReject?.(error instanceof Error ? error : new Error(message)); this.startupResolve = undefined; this.startupReject = undefined; }
        this.callbacks.onStatus('connection_error', message); this.stop(false);
      }
      return;
    }
    if (metadata.message_type === 'session_keepalive' || metadata.message_type === 'notification') {
      this.resetKeepalive(socket, record.keepaliveSeconds);
    }
    if (metadata.message_type === 'session_reconnect') {
      const reconnectUrl = envelope.payload?.session?.reconnect_url;
      if (typeof reconnectUrl !== 'string' || !reconnectUrl.startsWith('wss://eventsub.wss.twitch.tv/')) {
        this.diagnostic('eventsub_error', { category: 'invalid_reconnect_url' });
        this.callbacks.onStatus('connection_error', 'Twitch supplied an invalid EventSub reconnect address. Starting a fresh session.');
        socket.close(4000, 'Invalid EventSub reconnect address');
        return;
      }
      if (this.migration) return;
      this.diagnostic('eventsub_reconnect', { category: 'started' });
      this.resetKeepalive(socket, record.keepaliveSeconds); this.callbacks.onStatus('reconnecting', 'Twitch is migrating the EventSub session.'); this.openSocket(reconnectUrl, true); return;
    }
    if (metadata.message_type === 'revocation') {
      const reason = envelope.payload?.subscription?.status;
      this.diagnostic('eventsub_error', { category: 'revoked' });
      this.stop(false); this.callbacks.onStatus('connection_error', `Twitch revoked the chat subscription${typeof reason === 'string' ? ` (${reason})` : ''}. Reconnect Twitch to continue.`); return;
    }
    if (metadata.message_type !== 'notification' || metadata.subscription_type !== 'channel.chat.message') return;
    const chat = normalizeChatNotification(envelope);
    if (!chat) { this.diagnostic('chat_ignored', { category: 'invalid_message' }); return; }
    const commandRecognized = parseChatCommand(chat.text) !== null;
    this.diagnostic('chat_received', { category: 'success', commandRecognized });
    if (this.seenMessages.has(chat.id)) { this.diagnostic('chat_duplicate', { category: 'duplicate', commandRecognized }); return; }
    this.seenMessages.add(chat.id); if (this.seenMessages.size > 2000) this.seenMessages.delete(this.seenMessages.values().next().value!);
    this.callbacks.onChat(chat);
  }

  private resetKeepalive(socket: Socket, seconds: number) {
    const record = this.sockets.get(socket); if (!record) return;
    if (record.keepaliveTimer) clearTimeout(record.keepaliveTimer);
    record.keepaliveTimer = setTimeout(() => { socket.close(); }, Math.max(10, Math.min(600, seconds)) * 1000 + 1000);
  }

  private onClose(socket: Socket) {
    const record = this.sockets.get(socket); if (record?.welcomeTimer) clearTimeout(record.welcomeTimer); if (record?.keepaliveTimer) clearTimeout(record.keepaliveTimer);
    const wasActive = this.active === socket; const wasMigration = this.migration === socket; this.sockets.delete(socket);
    if (wasMigration) this.migration = null;
    if (this.stopped) { this.diagnostic('eventsub_disconnected', { category: 'closed' }); return; }
    if (wasMigration && this.active) { this.active.close(); return; }
    if (!wasActive) return;
    this.active = null;
    this.diagnostic('eventsub_disconnected', { category: 'connection_lost' });
    if (!this.startupDone) { this.failOrRetry('Twitch EventSub closed before chat subscription was ready.'); return; }
    this.scheduleReconnect();
  }

  private failOrRetry(message: string) {
    if (!this.startupDone) { this.callbacks.onStatus('reconnecting', message); this.scheduleReconnect(); return; }
    this.callbacks.onStatus('reconnecting', message); this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.diagnostic('eventsub_reconnect', { category: 'started' });
    this.callbacks.onStatus('reconnecting', 'Twitch EventSub connection lost; reconnecting.');
    const delay = this.backoff; this.backoff = Math.min(this.backoff * 2, 30000);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; if (!this.stopped) this.openSocket(EVENTSUB_URL, false); }, delay);
  }

  private diagnostic(stage: EventSubDiagnosticStage, fields: EventSubDiagnosticFields = {}) { this.callbacks.onDiagnostic?.(stage, fields); }
}

function eventSubErrorCategory(error: unknown) {
  if (error instanceof TwitchError) {
    if (error.code === 'subscription_not_enabled') return 'subscription_not_enabled';
    if (error.code === 'unauthorized') return 'unauthorized';
    if (error.code === 'network_error') return 'network_error';
    if (/^http_[1-5][0-9]{2}$/.test(error.code)) return 'http_error';
    if (error.code === 'invalid_response') return 'subscription_error';
  }
  if (error instanceof Error && error.name === 'AbortError') return 'startup_timeout';
  return 'subscription_error';
}
