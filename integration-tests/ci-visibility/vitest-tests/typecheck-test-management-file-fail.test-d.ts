import { describe, expectTypeOf, test } from 'vitest'

const fileLevelTypeError: number = 'file-level typecheck error'

describe('typecheck container failing suite', () => {
  test('can report disabled assertion with file-level error', () => {
    expectTypeOf({ value: 'disabled pass' }).toEqualTypeOf<{ value: string }>()
  })

  test('can report quarantined assertion with file-level error', () => {
    expectTypeOf({ value: 'quarantined pass' }).toEqualTypeOf<{ value: string }>()
  })
})
