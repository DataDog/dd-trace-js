import { defineConfig } from 'vite'

export default defineConfig({
  test: {
    include: [
      process.env.TEST_DIR || 'ci-visibility/vitest-tests/test-visibility*'
    ]
  }
})
