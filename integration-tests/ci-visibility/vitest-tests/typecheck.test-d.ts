import { expectTypeOf, test } from 'vitest'

test('typecheck can report type assertion', () => {
  expectTypeOf({ value: 'ok' }).toEqualTypeOf<{ value: string }>()
})

test('typecheck can report disabled assertion', () => {
  expectTypeOf({ value: 'disabled' }).toEqualTypeOf<{ value: string }>()
})

test('typecheck can report quarantined assertion', () => {
  expectTypeOf({ value: 'quarantined' }).toEqualTypeOf<{ value: string }>()
})

test('typecheck can report attempt-to-fix assertion', () => {
  expectTypeOf({ value: 'attempt-to-fix' }).toEqualTypeOf<{ value: string }>()
})

test.skip('typecheck can report skipped assertion', () => {
  expectTypeOf({ value: 'skipped' }).toEqualTypeOf<{ value: string }>()
})
