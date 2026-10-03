import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

const envDir = '../..';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, envDir, '');
  return {
    envDir,
    plugins: [react(), tailwindcss()],
    server: {
      port: Number(env.ADMIN_PORT ?? 3000),
      strictPort: true,
      proxy: {
        '/api': {
          target: env.VITE_API_PROXY_TARGET ?? 'http://localhost:4000',
          changeOrigin: false,
        },
      },
    },
    preview: { port: Number(env.ADMIN_PORT ?? 3000) },
    build: {
      sourcemap: true,
      chunkSizeWarningLimit: 600,
      rollupOptions: {
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
