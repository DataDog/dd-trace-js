import { afterEach, describe, test, vi } from 'vitest'

describe('mocked global URL', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('continues reporting while DogStatsD telemetry is flushed', async () => {
    vi.stubGlobal('URL', () => {})

    // Keep the mock active across the automatic 10-second CustomMetrics telemetry flush.
    await new Promise(resolve => setTimeout(resolve, 11_000))
  }, 15_000)

  test('preserves the original test failure', () => {
    vi.stubGlobal('URL', () => {})
    throw new Error('expected test failure')
  })
})
