import { describe, expectTypeOf, test } from 'vitest'

test('typecheck can report disabled failing assertion', () => {
  expectTypeOf({ value: 'disabled fail' }).toEqualTypeOf<{ value: number }>()
})

test('typecheck can report quarantined failing assertion', () => {
  expectTypeOf({ value: 'quarantined fail' }).toEqualTypeOf<{ value: number }>()
})

describe('typecheck nested failing suite', () => {
  test('can report nested disabled failing assertion', () => {
    expectTypeOf({ value: 'nested disabled fail' }).toEqualTypeOf<{ value: number }>()
  })
})
