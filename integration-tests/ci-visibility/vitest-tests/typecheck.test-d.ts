import { expectTypeOf, test } from 'vitest'

test('typecheck can report type assertion', () => {
  expectTypeOf({ value: 'ok' }).toEqualTypeOf<{ value: string }>()
})

test.skip('typecheck can report skipped assertion', () => {
  expectTypeOf({ value: 'skipped' }).toEqualTypeOf<{ value: string }>()
})
