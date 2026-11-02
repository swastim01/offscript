export type EventSubDiagnosticStage =
  | 'eventsub_connecting' | 'eventsub_socket_open' | 'eventsub_welcome' | 'subscription_request'
  | 'subscription_response' | 'subscription_confirmed' | 'eventsub_reconnect' | 'eventsub_disconnected'
  | 'eventsub_error' | 'chat_received' | 'chat_duplicate' | 'chat_ignored' | 'chat_processed';

export type EventSubDiagnosticFields = {
  category?: string;
  httpStatus?: number;
  commandRecognized?: boolean;
};

const SAFE_CATEGORIES = new Set([
  'success', 'started', 'http_error', 'network_error', 'unauthorized', 'invalid_welcome',
  'subscription_error', 'subscription_not_enabled', 'socket_error', 'startup_timeout',
  'closed', 'connection_lost', 'migration', 'revoked', 'invalid_reconnect_url',
  'invalid_message', 'duplicate', 'command_applied', 'command_rejected', 'chat_recorded',
  'not_running', 'unexpected_error',
]);

/** Serialize only fixed lifecycle labels and non-sensitive outcome metadata. */
export function formatEventSubDiagnostic(stage: EventSubDiagnosticStage, fields: EventSubDiagnosticFields = {}) {
  const record: Record<string, string | boolean | number> = { stage };
  if (fields.category && SAFE_CATEGORIES.has(fields.category)) record.category = fields.category;
  if (stage === 'subscription_response' && Number.isInteger(fields.httpStatus) && fields.httpStatus! >= 100 && fields.httpStatus! <= 599) record.httpStatus = fields.httpStatus!;
  if (typeof fields.commandRecognized === 'boolean') record.commandRecognized = fields.commandRecognized;
  return JSON.stringify(record);
}
