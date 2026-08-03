import { describe, expect, test, vi } from 'vitest'

vi.mock('./tia-mocked-target.mjs', async () => {
  const { getMockedValue } = await import('./tia-mocked-implementation.mjs')

  return { getValue: getMockedValue }
})

describe('TIA dynamic import and mock suite', () => {
  test('reports dynamically imported and mocked implementation files', async () => {
    const [{ dynamicValue }, { getValue }] = await Promise.all([
      import('./tia-dynamic-source.mjs'),
      import('./tia-mocked-target.mjs'),
    ])

    expect(dynamicValue).toBe('dynamic')
    expect(getValue()).toBe('mocked')
  })
})
