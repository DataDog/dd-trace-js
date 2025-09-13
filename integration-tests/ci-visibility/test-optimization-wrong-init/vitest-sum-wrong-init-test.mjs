import tracer from 'dd-trace'
import { describe, it, expect } from 'vitest'

// The tracer needs to be initialized both in the main process and in the worker process.
// This is normally taken care of by using NODE_OPTIONS, but we can't set
// flushInterval through an env var
tracer.init({
  flushInterval: 0
})

tracer.trace('sum.test', { resource: 'sum.test.js' }, () => {
  describe('sum', () => {
    it('should return the sum of two numbers', async () => {
      expect(1 + 2).toBe(3)
    })
  })
})
