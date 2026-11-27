import { expect, it } from 'vitest'

import { add } from './src/arithmetic.ts'

// A process that collects line coverage hides the probes from a function's source. One that does not hides
// nothing, so this fails when such a process is given code that another run instrumented.
it('shows the source of a function as written', () => {
  expect(String(add)).not.toContain('$dd$')
  expect(add(1, 2)).toBe(3)
})
