/** Validate the explicit public HTTPS callback used for the local tunnel flow. */
export function isHttpsTwitchCallbackUri(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const uri = new URL(value);
    return uri.protocol === 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(uri.hostname.toLowerCase()) && !uri.username && !uri.password && uri.pathname === '/auth/twitch/callback' && !uri.search && !uri.hash;
  } catch { return false; }
}

/** Point the dashboard's Connect link at the callback's origin, keeping OAuth state cookie host aligned. */
export function createAuthorizationStartUrl(redirectUri: string) {
  if (!isHttpsTwitchCallbackUri(redirectUri)) throw new Error('Set TWITCH_REDIRECT_URI to the HTTPS tunnel callback before connecting Twitch.');
  const callbackOrigin = new URL(redirectUri).origin;
  return new URL('/auth/twitch', callbackOrigin).toString();
}

export function requestHostMatchesCallback(host: string | undefined, redirectUri: string) {
  if (!host) return false;
  try { return host.toLowerCase() === new URL(redirectUri).host.toLowerCase(); } catch { return false; }
}
