const scenario = process.env.EMPTY_SESSION_SCENARIO

export default {
  test: {
    include: [scenario.startsWith('no-candidates') ? 'no-matching-tests.mjs' : 'vitest-empty-sessions/test.mjs'],
    passWithNoTests: ['empty-shard', 'empty-file', 'no-candidates', 'no-candidates-sharded'].includes(scenario),
    globalSetup: scenario === 'setup-error' ? ['vitest-empty-sessions/setup.mjs'] : [],
  },
}
