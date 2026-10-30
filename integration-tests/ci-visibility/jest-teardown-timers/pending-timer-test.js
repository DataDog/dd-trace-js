'use strict'

const queueTimer = () => {
  setTimeout(() => {
    process.stderr.write('PENDING_JSDOM_TIMER_FIRED\n')
  }, 0)
}

if (process.env.JEST_TIMER_SUITE_STATUS === 'error') {
  queueTimer()
  throw new Error('Error while loading the test suite')
}

afterAll(queueTimer)

it('reports the suite result before closing its environment', () => {
  expect(process.env.JEST_TIMER_SUITE_STATUS).toBe('pass')
})
