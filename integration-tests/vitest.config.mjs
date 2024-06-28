import { defineConfig } from 'vite'

export default defineConfig({
  test: {
    include: [
      'ci-visibility/vitest-tests/test-visibility*'
    ]
  }
})
