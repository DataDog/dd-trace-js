export default {
  test: {
    include: ['ci-visibility/known-flakes/vitest.mjs'],
    retry: Number(process.env.NATIVE_RETRIES) || 0,
  },
}
