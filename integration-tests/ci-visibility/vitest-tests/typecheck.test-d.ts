import { expectTypeOf, test } from 'vitest'

test('typecheck can report type assertion', () => {
  expectTypeOf({ value: 'ok' }).toEqualTypeOf<{ value: string }>()
})
