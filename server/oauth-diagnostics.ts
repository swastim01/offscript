export type OAuthDiagnosticStage = 'oauth_start' | 'config_validation' | 'host_validation' | 'state_cookie_creation' | 'authorization_url_creation' | 'redirect' | 'callback_received' | 'state_validation' | 'token_exchange' | 'token_validation' | 'user_lookup' | 'authorization_result' | 'eventsub_start' | 'oauth_error';
export type OAuthDiagnosticFields = {
  hostMatchesCallback?: boolean;
  stateCookiePresent?: boolean;
  stateValid?: boolean;
  httpStatus?: number;
  category?: string;
  errorName?: string;
};

const SAFE_ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'TwitchError']);

const SAFE_CATEGORIES = new Set([
  'success', 'configuration_missing', 'invalid_callback', 'host_mismatch', 'state_cookie_missing', 'state_mismatch',
  'access_denied', 'code_missing', 'http_error', 'network_error', 'unauthorized', 'missing_scope', 'token_mismatch',
  'identity_mismatch', 'invalid_token_response', 'missing_user', 'refresh_failed', 'refresh_mismatch',
  'subscription_not_enabled', 'startup_timeout', 'stopped', 'authorization_changed', 'invalid_response', 'invalid_json', 'type_error',
  'syntax_error', 'unexpected_error', 'unknown_error',
]);

/** Serializes only the explicitly approved diagnostic fields. Never pass raw request or error data here. */
export function formatOAuthDiagnostic(stage: OAuthDiagnosticStage, fields: OAuthDiagnosticFields = {}) {
  const record: Record<string, string | boolean | number> = { stage };
  if (typeof fields.hostMatchesCallback === 'boolean') record.hostMatchesCallback = fields.hostMatchesCallback;
  if (typeof fields.stateCookiePresent === 'boolean') record.stateCookiePresent = fields.stateCookiePresent;
  if (typeof fields.stateValid === 'boolean') record.stateValid = fields.stateValid;
  if (Number.isInteger(fields.httpStatus) && fields.httpStatus! >= 100 && fields.httpStatus! <= 599) record.httpStatus = fields.httpStatus!;
  if (fields.category && SAFE_CATEGORIES.has(fields.category)) record.category = fields.category;
  if (fields.errorName && SAFE_ERROR_NAMES.has(fields.errorName)) record.errorName = fields.errorName;
  return JSON.stringify(record);
}

/** Returns a fixed, allowlisted exception name; custom names are never emitted. */
export function safeOAuthErrorName(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown';
  return SAFE_ERROR_NAMES.has(error.name) ? error.name : 'Error';
}

export function safeOAuthErrorCategory(error: unknown): string {
  if (error instanceof Error && error.name === 'TypeError') return 'type_error';
  if (error instanceof Error && error.name === 'SyntaxError') return 'syntax_error';
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    const code = error.code;
    if (SAFE_CATEGORIES.has(code)) return code;
    if (/^http_[1-5][0-9]{2}$/.test(code)) return 'http_error';
    if (code === 'invalid_response') return 'invalid_response';
  }
  return error instanceof Error ? 'unexpected_error' : 'unknown_error';
}

export function oauthFailureReason(stage: OAuthDiagnosticStage, category: string) {
  const safeCategory = SAFE_CATEGORIES.has(category) ? category : 'unexpected_error';
  return `Twitch ${stage.replaceAll('_', ' ')} failed (${safeCategory}). Check the current tunnel origin and retry.`;
}
