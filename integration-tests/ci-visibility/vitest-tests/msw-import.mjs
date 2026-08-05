import { describe, expect, test } from 'vitest'
import { HttpResponse, http } from 'msw'

describe('msw import', () => {
  test('loads MSW exports', () => {
    expect(typeof http.get).toBe('function')
    expect(typeof HttpResponse.json).toBe('function')
  })
})
