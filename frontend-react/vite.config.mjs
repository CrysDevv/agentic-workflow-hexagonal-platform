import react from '@vitejs/plugin-react';
import autoprefixer from 'autoprefixer';
import tailwindcss from 'tailwindcss';
import { defineConfig } from 'vite';

// En desarrollo, /config.js lo sirve Vite; en producción lo sirve server.mjs (configuración en tiempo de ejecución).
const configEnDesarrollo = () => ({
  name: 'config-runtime-dev',
  configureServer(server) {
    server.middlewares.use('/config.js', (_req, res) => {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.end(
        `window.__CONFIG__=${JSON.stringify({ apiBaseUrl: process.env.VITE_API_BASE_URL || 'http://localhost:3000' })};`,
      );
    });
  },
});

export default defineConfig({
  plugins: [react(), configEnDesarrollo()],
  css: {
    postcss: {
      plugins: [
        tailwindcss({
          content: ['./index.html', './src/**/*.{ts,tsx}'],
          theme: { extend: {} },
        }),
        autoprefixer(),
      ],
    },
  },
  server: { host: '0.0.0.0', port: 5173 },
  build: { outDir: 'dist', sourcemap: false, target: 'es2022' },
});
