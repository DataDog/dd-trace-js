import { defineConfig } from 'vite'

export default defineConfig({
  test: {
    include: [],
    typecheck: {
      checker: 'tsc',
      enabled: true,
      include: ['ci-visibility/vitest-tests/*.test-d.ts'],
      tsconfig: 'tsconfig.typecheck.json',
    },
  },
})
