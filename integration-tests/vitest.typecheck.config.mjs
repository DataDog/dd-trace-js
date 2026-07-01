import { defineConfig } from 'vite'

const typecheckFile = process.env.TYPECHECK_FAIL === 'true'
  ? 'ci-visibility/vitest-tests/typecheck-fail.test-d.ts'
  : 'ci-visibility/vitest-tests/typecheck.test-d.ts'
const tsconfig = process.env.TYPECHECK_FAIL === 'true'
  ? 'tsconfig.typecheck-fail.json'
  : 'tsconfig.typecheck.json'

export default defineConfig({
  test: {
    include: [],
    typecheck: {
      checker: 'tsc',
      enabled: true,
      include: [typecheckFile],
      tsconfig,
    },
  },
})
