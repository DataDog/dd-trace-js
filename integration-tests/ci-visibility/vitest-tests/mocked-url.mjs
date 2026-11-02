import tracer from 'dd-trace'
import { afterEach, describe, test, vi } from 'vitest'

describe('mocked global URL', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('continues reporting while DogStatsD is disabled', () => {
    vi.stubGlobal('URL', () => {})

    tracer.dogstatsd.flush()
  })

  test('preserves the original test failure', () => {
    vi.stubGlobal('URL', () => {})
    throw new Error('expected test failure')
  })
})
