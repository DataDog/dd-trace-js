import { afterAll, afterEach, beforeEach, describe, test } from 'vitest'

const counts = {}

for (const failure of ['body', 'beforeEach', 'afterEach', 'fixture']) {
  describe(failure, () => {
    const attempts = counts[failure] = { beforeEach: 0, body: 0, afterEach: 0, fixture: 0 }
    beforeEach(() => {
      attempts.beforeEach++
      if (failure === 'beforeEach') throw new Error(`beforeEach failure ${attempts.beforeEach}`)
    })
    afterEach(() => {
      attempts.afterEach++
      if (failure === 'afterEach') throw new Error(`afterEach failure ${attempts.afterEach}`)
    })
    const fixtureTest = test.extend({
      // eslint-disable-next-line no-empty-pattern
      value: async ({}, use) => {
        attempts.fixture++
        await use(1)
        if (failure === 'fixture') throw new Error(`fixture failure ${attempts.fixture}`)
      },
    })
    fixtureTest('failure', ({ value }) => {
      attempts.body += value
      if (failure === 'body') throw new Error(`body failure ${attempts.body}`)
    })
  })
}

test.fails('expected failure', () => {
  counts.expectedFailure = (counts.expectedFailure || 0) + 1
  throw new Error('expected failure')
})

test.fails('unexpected pass', () => {
  counts.unexpectedPass = (counts.unexpectedPass || 0) + 1
})

test('eventually passes', () => {
  counts.eventuallyPasses = (counts.eventuallyPasses || 0) + 1
  if (counts.eventuallyPasses === 1) throw new Error('first attempt fails')
})

test('slow first attempt', async () => {
  counts.slow = (counts.slow || 0) + 1
  if (counts.slow === 1) await new Promise(resolve => setTimeout(resolve, 5100))
  throw new Error(`slow failure ${counts.slow}`)
}, 10_000)

afterAll(() => {
  // eslint-disable-next-line no-console
  console.log(`DYNAMIC_ATR_COUNTS ${JSON.stringify(counts)}`)
})
