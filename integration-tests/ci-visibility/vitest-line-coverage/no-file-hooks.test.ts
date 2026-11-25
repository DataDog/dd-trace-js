import { it, expect } from 'vitest'

import { inTest } from './src/hooks.mjs'

it('runs in a file without hooks', () => {
  expect(inTest()).toBe('in test')
})
