import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { resolve } from 'node:path';
import { type Connect, defineConfig, type Plugin } from 'vite';

/**
 * The monorepo keeps one .env at the repo root. It is parsed here instead of via Vite's
 * `envDir`/`loadEnv`, which would apply the file's NODE_ENV=development to production builds
 * (bundling React's development build). Only VITE_* variables reach client code.
 */
function readRootEnv(): Record<string, string> {
  const file = resolve(__dirname, '../../.env');
  if (!existsSync(file)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match?.[1] && match[1] !== 'NODE_ENV')
      env[match[1]] = (match[2] ?? '').replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

/**
 * Mirrors production nginx in dev and preview: /e/:token is the server-rendered emergency page
 * from the API (one request, works without JavaScript); /verify/:token is the client entry.
 */
function emergencyRoute(apiTarget: string): Plugin {
  const handle: Connect.NextHandleFunction = (req, res, next) => {
    const url = req.url ?? '';
    const e = /^\/e\/([0-9A-Za-z_-]+)\/?(?:\?.*)?$/.exec(url);
    if (e) {
      const upstream = request(
        // "localhost" can resolve to ::1 while the dev API listens on IPv4 only.
        `${apiTarget.replace('//localhost', '//127.0.0.1')}/api/v1/public/emergency/${e[1]}/page`,
        { method: 'GET', headers: { ...req.headers, host: new URL(apiTarget).host } },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on('error', () => {
        req.url = '/emergency.html'; // API down: client fallback, as nginx does
        next();
      });
      upstream.end();
      return;
    }
    if (/^\/verify\/[^/?#]+\/?(\?.*)?$/.test(url)) req.url = '/emergency.html';
    next();
  };
  return {
    name: 'emergency-route',
    configureServer: (server) => void server.middlewares.use(handle),
    configurePreviewServer: (server) => void server.middlewares.use(handle),
  };
}

export default defineConfig(() => {
  const env: Record<string, string | undefined> = { ...readRootEnv(), ...process.env };
  const clientEnv = Object.fromEntries(
    Object.entries(env)
      .filter(([key]) => key.startsWith('VITE_'))
      .map(([key, value]) => [`import.meta.env.${key}`, JSON.stringify(value)]),
  );
  const port = Number(env.PORTAL_PORT ?? 3001);
  const apiTarget = env.VITE_API_PROXY_TARGET ?? 'http://localhost:4000';
  return {
    plugins: [emergencyRoute(apiTarget), react(), tailwindcss()],
    define: clientEnv,
    server: {
      port,
      strictPort: true,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: false,
        },
      },
    },
    preview: { port },
    build: {
      sourcemap: true,
      chunkSizeWarningLimit: 600,
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'index.html'),
          emergency: resolve(__dirname, 'emergency.html'),
        },
        output: {
          manualChunks(id: string) {
            if (!id.includes('node_modules')) return undefined;
            if (/[\\/](react|react-dom|scheduler|react-router|react-router-dom)@/.test(id))
              return 'react';
            if (/[\\/](@tanstack|react-hook-form|@hookform|zod)/.test(id)) return 'data';
            return 'vendor';
          },
        },
      },
    },
  };
});
