'use strict'

const fs = require('fs')
const path = require('path')

/**
 * Replaces every function of `modules` with one that records its direct caller, as fs mocks and
 * stubs do, until `restore` is called.
 *
 * @param {Record<string, object>} modules
 */
function recordCalls (modules) {
  const callers = []
  const restores = []
  for (const [label, object] of Object.entries(modules)) {
    for (const name of Object.keys(object)) {
      const original = object[name]
      if (typeof original !== 'function' || /^[A-Z]/.test(name)) continue
      const replacement = function () {
        const call = {}
        Error.captureStackTrace(call, replacement)
        callers.push({ name: `${label}.${name}`, caller: call.stack.split('\n')[1] ?? '' })
        return original.apply(this, arguments)
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
  it('runs code loaded while fs and path functions are replaced', () => {
    const calls = recordCalls({ fs, path })
    let lazy
    try {
      lazy = require('./lazy')
    } finally {
      calls.restore()
    }
    expect(lazy.double(21)).toBe(42)
    expect(calls.fromLineCoverage()).toEqual([])
  })

  it('runs instrumented code with every timer faked', async () => {
    jest.useFakeTimers()
    try {
      // Code that runs after a resumption makes line coverage schedule its work again.
      await null
      expect(require('./lazy').double(2)).toBe(4)
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })
})
