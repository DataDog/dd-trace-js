const scenario = process.env.EMPTY_SESSION_SCENARIO

export default {
  test: {
    include: ['vitest-empty-sessions/test.mjs'],
    passWithNoTests: scenario === 'empty-shard' || scenario === 'empty-file',
    globalSetup: scenario === 'setup-error' ? ['vitest-empty-sessions/setup.mjs'] : [],
  },
}
