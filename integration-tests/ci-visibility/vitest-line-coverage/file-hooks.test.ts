import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'

import { fileBeforeAll, fileBeforeEach, fileAfterEach, fileAfterAll, inTest } from './src/hooks.mjs'

beforeAll(() => {
  fileBeforeAll()
})

beforeEach(() => {
  fileBeforeEach()
})

afterEach(() => {
  fileAfterEach()
})

afterAll(() => {
  fileAfterAll()
})

describe('with hooks at the file level', () => {
  it('runs inside a describe block', () => {
    expect(inTest()).toBe('in test')
  })
})

it('runs at the top level', () => {
  expect(inTest()).toBe('in test')
})
