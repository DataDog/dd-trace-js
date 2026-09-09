export default {
  test: {
    disableConsoleIntercept: true,
    include: ['ci-visibility/automatic-log-submission-vitest/test.mjs'],
    pool: 'forks',
  },
}
