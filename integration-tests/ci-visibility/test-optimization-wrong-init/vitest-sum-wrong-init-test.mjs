'use strict'

import tracer from 'dd-trace'
import { describe, it, expect } from 'vitest'

tracer.trace('sum.test', { resource: 'sum.test.js' }, () => {
  describe('sum', () => {
    it('should return the sum of two numbers', async () => {
      // we need to give time for the tracer to flush the spans
      // otherwise the vitest worker process will exit before the spans are flushed
      await new Promise(resolve => setTimeout(resolve, 2000))
      expect(1 + 2).toBe(3)
    })
  })
})
