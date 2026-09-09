import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    experimental: {
      nodeLoader: false,
      viteModuleRunner: false,
    },
    fileParallelism: false,
    include: ['ci-visibility/vitest-tests/efd-always-fails.mjs'],
    isolate: false,
    maxWorkers: 1,
    minWorkers: 1,
    outputFile: 'efd-results.json',
    pool: 'forks',
    reporters: ['json'],
    retry: 1,
  },
})
