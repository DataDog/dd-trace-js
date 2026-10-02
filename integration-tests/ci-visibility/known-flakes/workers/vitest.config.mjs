export default {
  test: {
    globals: true,
    include: ['ci-visibility/known-flakes/workers/{first,second}.js'],
    setupFiles: ['ci-visibility/known-flakes/workers/vitest-setup.mjs'],
    minWorkers: 2,
    maxWorkers: 2,
  },
}
