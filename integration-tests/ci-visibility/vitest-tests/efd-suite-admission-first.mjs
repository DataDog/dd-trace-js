import { expect, test } from 'vitest'

test('first EFD suite admission test', async () => {
  if (process.env.VITEST_LARGE_WORKER_TRACES) {
    const { default: tracer } = await import('dd-trace')
    const value = 'a'.repeat(4800)
    const span = tracer.scope().active()
    for (let index = 0; index < 640; index++) {
      span.setTag('worker_payload.' + index, value)
    }
  }
  expect(true).to.equal(true)
})
