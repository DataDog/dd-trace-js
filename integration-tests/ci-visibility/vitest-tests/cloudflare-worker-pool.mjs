import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'

describe('cloudflare vitest worker pool', () => {
  it('runs with Datadog provided context', () => {
    expect(env).toBeDefined()
    expect(typeof Request).toBe('function')
  })
})
