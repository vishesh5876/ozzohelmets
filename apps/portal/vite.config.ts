import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'node:fs';
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

/** Serves the standalone emergency entry for /e/* in dev and preview (nginx does this in production). */
function emergencyRoute(): Plugin {
  const rewrite: Connect.NextHandleFunction = (req, _res, next) => {
    if (req.url && /^\/e\/[^/?#]+\/?(\?.*)?$/.test(req.url)) req.url = '/emergency.html';
    next();
  };
  return {
    name: 'emergency-route',
    configureServer: (server) => void server.middlewares.use(rewrite),
    configurePreviewServer: (server) => void server.middlewares.use(rewrite),
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
  return {
    plugins: [emergencyRoute(), react(), tailwindcss()],
    define: clientEnv,
    server: {
      port,
      strictPort: true,
      proxy: {
        '/api': {
          target: env.VITE_API_PROXY_TARGET ?? 'http://localhost:4000',
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
