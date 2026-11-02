import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { isHttpsTwitchCallbackUri } from './server/twitch-url.ts';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  let tunnelHost: string | undefined;
  try {
    const callback = new URL(env.TWITCH_REDIRECT_URI ?? '');
    if (isHttpsTwitchCallbackUri(callback.toString())) {
      tunnelHost = callback.hostname;
    }
  } catch { /* leave the local demo routes and default Vite host rules in place */ }

  return {
    plugins: [react()],
    server: {
      allowedHosts: tunnelHost ? [tunnelHost] : [],
      proxy: {
        '/api': { target: 'http://localhost:3001', changeOrigin: false },
        // Preserve the browser's tunnel Host so the OAuth state cookie is set on that origin.
        '/auth': { target: 'http://localhost:3001', changeOrigin: false },
        '/socket': { target: 'ws://localhost:3001', ws: true, changeOrigin: false },
      },
    },
  };
});
