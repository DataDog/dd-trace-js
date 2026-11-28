import { describe, it, expect, beforeAll, afterEach } from 'vitest'

import { add, subtract, multiply, divide } from './src/arithmetic.ts'
import { prepare, cleanUp } from './src/fixture.mjs'
import { ANSWER, describeAnswer } from './src/answer.mjs'

describe('with a suite setup', () => {
  let state: string

  beforeAll(() => {
    state = prepare()
  })

  it('adds', () => {
    expect(add(1, 2)).toBe(3)
    expect(state).toBe('prepared')
    expect(describeAnswer()).toBe('the answer is 42')
  })

  it('subtracts', () => {
    expect(subtract(3, 1)).toBe(2)
    expect(ANSWER).toBe(42)
  })
})

describe('with a per-test hook', () => {
  let state: string

  afterEach(() => {
    state = cleanUp()
  })

  it('multiplies', () => {
    expect(multiply(2, 3)).toBe(6)
    state = 'initial'
    expect(state).toBe('initial')
  })
})

describe('concurrent tests', () => {
  it.concurrent('multiplies concurrently', async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(multiply(2, 4)).toBe(8)
  })

  it.concurrent('divides concurrently', async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(divide(6, 3)).toBe(2)
  })
})

describe('skipped tests', () => {
  it('skips itself after it starts', (context) => {
    expect(subtract(5, 3)).toBe(2)
    context.skip()
  })

  it.skip('is skipped before it starts', () => {
    expect(add(1, 1)).toBe(2)
  })
})
