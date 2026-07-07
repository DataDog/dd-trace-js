import { defineConfig } from 'vite'

const typecheckFixture = process.env.TYPECHECK_FAIL === 'true'
  ? 'fail'
  : process.env.TYPECHECK_TEST_MANAGEMENT_FAIL === 'true'
    ? 'testManagementFail'
    : process.env.TYPECHECK_TEST_MANAGEMENT_FILE_FAIL === 'true'
      ? 'testManagementFileFail'
      : 'default'

const typecheckFixtures = {
  default: {
    typecheckFile: 'ci-visibility/vitest-tests/typecheck.test-d.ts',
    tsconfig: 'tsconfig.typecheck.json',
  },
  fail: {
    typecheckFile: 'ci-visibility/vitest-tests/typecheck-fail.test-d.ts',
    tsconfig: 'tsconfig.typecheck-fail.json',
  },
  testManagementFail: {
    typecheckFile: 'ci-visibility/vitest-tests/typecheck-test-management-fail.test-d.ts',
    tsconfig: 'tsconfig.typecheck-test-management-fail.json',
  },
  testManagementFileFail: {
    typecheckFile: 'ci-visibility/vitest-tests/typecheck-test-management-file-fail.test-d.ts',
    tsconfig: 'tsconfig.typecheck-test-management-file-fail.json',
  },
}

const { typecheckFile, tsconfig } = typecheckFixtures[typecheckFixture]

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
