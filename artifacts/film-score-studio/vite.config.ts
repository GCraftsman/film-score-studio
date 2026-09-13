import path from 'path';
import { createReadStream, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

const rawPort = process.env.PORT;

if (!rawPort) {
  throw new Error(
    'PORT environment variable is required but was not provided.',
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH;

if (!basePath) {
  throw new Error(
    'BASE_PATH environment variable is required but was not provided.',
  );
}

const require = createRequire(import.meta.url);
const SPESSASYNTH_PROCESSOR_FILE = 'spessasynth_processor-4.3.14.min.js';
const spessaSynthProcessorPath = path.join(
  path.dirname(require.resolve('spessasynth_lib/package.json')),
  'dist',
  'spessasynth_processor.min.js',
);

/**
 * AudioWorklet scripts must be served as their original JavaScript source.
 * Vite's `?url` dev path is an /@fs module transform, which can hang in an
 * AudioWorklet realm. This emits the pinned upstream processor as a static,
 * versioned file in production and streams exactly the same bytes in dev.
 *
 * Keep the version and source path synchronized with spessasynth_lib in
 * package.json. Its Apache-2.0 license is retained under public/soundfonts/licenses.
 */
function spessaSynthProcessorAsset(): Plugin {
  const publicSuffix = `/audio-engine/${SPESSASYNTH_PROCESSOR_FILE}`;
  return {
    name: 'spessasynth-static-worklet-processor',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = request.url?.split('?', 1)[0];
        if (!pathname?.endsWith(publicSuffix)) return next();
        response.statusCode = 200;
        response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        response.setHeader('Cache-Control', 'no-cache');
        createReadStream(spessaSynthProcessorPath).pipe(response);
      });
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: `audio-engine/${SPESSASYNTH_PROCESSOR_FILE}`,
        source: readFileSync(spessaSynthProcessorPath),
      });
    },
  };
}

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    spessaSynthProcessorAsset(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== 'production' &&
    process.env.REPL_ID !== undefined
      ? [
          await import('@replit/vite-plugin-cartographer').then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, '..'),
            }),
          ),
          await import('@replit/vite-plugin-dev-banner').then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
});
