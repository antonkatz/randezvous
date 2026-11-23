import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    sourcemap: true,
    outDir: 'dist-lib',
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: {
      entry: {
        randevouz: 'src/lib/index.ts',
        circles: 'src/circles/index.ts',
        'circles-ui': 'src/circles/ui/index.ts',
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      output: {
        assetFileNames: 'randevouz[extname]',
      },
    },
  },
});
