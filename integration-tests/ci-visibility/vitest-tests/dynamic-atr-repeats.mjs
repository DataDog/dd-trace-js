import { afterAll, beforeEach, describe, test } from 'vitest'

const counts = {}
for (const scenario of ['slow pass then fast fail', 'fast fail then slow fail', 'slow fail then fast fail']) {
  describe(scenario, () => {
    const attempts = counts[scenario] = [0, 0]
    beforeEach(async ({ task }) => {
      const repeat = task.result.repeatCount
      const attempt = attempts[repeat]++
      const slowRepeat = scenario === 'fast fail then slow fail' ? 1 : 0
      if (attempt === 0 && repeat === slowRepeat) {
        await new Promise(resolve => setTimeout(resolve, 5100))
      }
    })
    test('failure', { repeats: 1, timeout: 10_000 }, ({ task }) => {
      const repeat = task.result.repeatCount
      if (scenario === 'slow pass then fast fail' && repeat === 0) return
      throw new Error(`${scenario}: repeat ${repeat} attempt ${attempts[repeat]}`)
    })
  })
}

afterAll(() => {
  // eslint-disable-next-line no-console
  console.log(`DYNAMIC_ATR_REPEATS ${JSON.stringify(counts)}`)
})
