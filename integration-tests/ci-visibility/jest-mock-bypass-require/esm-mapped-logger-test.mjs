import { describe, expect, it } from '@jest/globals'
import loggerModule from 'winston'

describe('Winston ESM resolution', () => {
  it('uses the mapped logger', () => {
    expect(loggerModule).toEqual({ mapped: true })
  })
})
