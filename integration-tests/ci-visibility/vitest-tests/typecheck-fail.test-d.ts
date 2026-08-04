import { expectTypeOf, test } from 'vitest'

test('typecheck can report failing assertion', () => {
  expectTypeOf({ value: 'not ok' }).toEqualTypeOf<{ value: number }>()
})
