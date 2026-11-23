import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    sourcemap: true,
    outDir: 'dist-lib',
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: {
      entry: 'src/lib/index.ts',
      formats: ['es'],
      fileName: () => 'randevouz.js',
    },
    rollupOptions: {
      output: {
        assetFileNames: 'randevouz[extname]',
      },
    },
  },
});
