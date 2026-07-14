import { defineConfig } from 'vitest/config';
import { builtinModules } from 'node:module';
import path from 'path';

const nodeBuiltinAliases = builtinModules
  .filter(m => !m.startsWith('_'))
  .map(m => ({ find: new RegExp(`^${m}$`), replacement: `node:${m}` }));

export default defineConfig({
  resolve: {
    alias: [
      { find: 'playwright-core/src', replacement: path.resolve(__dirname, 'src') },
      ...nodeBuiltinAliases,
    ],
  },
  test: {
    include: ['tests/mcp/**/*.test.ts'],
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['json-summary', 'text'],
      include: [
        'src/mcp/**/*.ts',
        'src/tools/**/*.ts',
      ],
    },
  },
});
