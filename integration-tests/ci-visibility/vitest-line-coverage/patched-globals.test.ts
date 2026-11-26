import fs from 'node:fs'
import path from 'node:path'

import { describe, it, expect, vi } from 'vitest'

import { add } from './src/arithmetic.ts'

/**
 * Replaces every function of `modules` with one that records its direct caller, as fs mocks and
 * stubs do, until `restore` is called.
 */
function recordCalls (modules: Record<string, Record<string, unknown>>) {
  const callers: Array<{ name: string, caller: string }> = []
  const restores: Array<() => void> = []
  for (const [label, object] of Object.entries(modules)) {
    for (const name of Object.keys(object)) {
      const original = object[name]
      if (typeof original !== 'function' || /^[A-Z]/.test(name)) continue
      const replacement = function (this: unknown, ...args: unknown[]) {
        const call: { stack?: string } = {}
        Error.captureStackTrace(call, replacement)
        callers.push({ name: `${label}.${name}`, caller: call.stack?.split('\n')[1] ?? '' })
        return original.apply(this, args)
      }
      Object.assign(replacement, original)
      object[name] = replacement
      restores.push(() => { object[name] = original })
    }
  }
  return {
    restore () {
      for (const restore of restores) restore()
    },
    // The replaced functions that line coverage called itself.
    fromLineCoverage () {
      const directory = `${path.sep}line-coverage${path.sep}`
      return callers.filter(({ caller }) => caller.includes(directory)).map(({ name }) => name)
    },
  }
}

describe('with replaced fs, path and timers', () => {
  it('runs code loaded while fs and path functions are replaced', async () => {
    const calls = recordCalls({ fs, path })
    let lazy
    try {
      lazy = await import('./src/lazy.mjs')
    } finally {
      calls.restore()
    }
    expect(lazy.double(21)).toBe(42)
    expect(calls.fromLineCoverage()).toEqual([])
  })

  it('runs instrumented code with every timer faked', async () => {
    // Vitest cannot fake process.nextTick in a child process.
    vi.useFakeTimers({
      toFake: [
        'setTimeout', 'clearTimeout', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
        'Date', 'queueMicrotask', 'hrtime', 'performance',
      ],
    })
    try {
      // Code that runs after a resumption makes line coverage schedule its work again.
      await null
      expect(add(2, 2)).toBe(4)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
