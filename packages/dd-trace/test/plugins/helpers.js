'use strict'

const { AssertionError } = require('assert')
const { inspect } = require('util')
const { AsyncResource } = require('../../../datadog-instrumentations/src/helpers/instrument')

const Nomenclature = require('../../src/service-naming')

function resolveNaming (namingSchema) {
  return new Proxy(namingSchema, {
    get (target, prop, receiver) {
      return target[prop][Nomenclature.version]
    }
  })
}

function expectSomeSpan (agent, expected, timeout) {
  return agent.assertSomeTraces(traces => {
    const scoredErrors = []
    for (const trace of traces) {
      for (const span of trace) {
        try {
          deepInclude(expected, span)
          return
        } catch (err) {
          scoredErrors.push({ err, score: compare(expected, span) })
        }
      }
    }

    // Throw the error for the least wrong span, since it's most likely to be
    // the one we're looking for. If for whatever reason it isn't, we can
    // always debug here and look at the scoreErrors array.
    const error = scoredErrors.sort((a, b) => a.score - b.score)[0].err
    // We'll append all the spans to this error message so it's visible in test
    // output.
    error.message += '\n\nCandidate Traces:\n' + inspect(traces)
    throw error
  }, { timeoutMs: timeout })
}

// This is a bit like chai's `expect(expected).to.deep.include(actual)`, except
// that when it recurses it uses the same inclusion check, rather than deep
// equality. Some nice output is included.
function deepInclude (expected, actual, path = []) {
  for (const propName in expected) {
    path.push(propName.includes('.') ? `['${propName}']` : propName)
    if (isObject(expected[propName]) && isObject(actual[propName])) {
      if (typeof expected[propName] === 'bigint') {
        deepInclude(expected[propName].toString(), actual[propName].toString(), path)
      } else {
        deepInclude(expected[propName], actual[propName], path)
      }
    } else if (actual[propName] !== expected[propName]) {
      const pathStr = path.join('.').replace(/\.\[/g, '[')
      throw new AssertionError({
        expected: expected[propName],
        actual: actual[propName],
        message: `expected.${pathStr} !== actual.${pathStr}`
      })
    }
    path.pop()
  }
}

// How "wrong" are we? This gives the edit distance from the actual to the
// expected. Here, an edit means adding or changing a property.
function compare (expected, actual) {
  let score = 0
  for (const name in expected) {
    // If both the expected property and the actual property are objects, then
    // we can do a deeper comparison. Otherise we just compare strict equality.
    if (isObject(expected[name]) && isObject(actual[name])) {
      score += compare(expected[name], actual[name])
    } else if (expected[name] !== actual[name]) {
      score += 1
    }
  }
  return score
}

function isObject (obj) {
  // `null` is also typeof 'object'
  return obj !== null && typeof obj === 'object'
}

function withDefaults (defaults, obj) {
  const newObj = Object.assign({}, defaults, obj)
  for (const propName in defaults) {
    if (isObject(defaults[propName]) && isObject(obj[propName])) {
      newObj[propName] = withDefaults(defaults[propName], obj[propName])
    }
  }
  return newObj
}

function breakThen (promise) {
  const original = promise.then
  const asyncResource = new AsyncResource('bound-asynchronous-fn')

  promise.then = function (...args) {
    for (let i = 0; i < args.length; i++) {
      if (typeof args[i] !== 'function') continue
      args[i] = asyncResource.bind(args[i], this)
    }

    return original.apply(this, args)
  }

  promise.then._dd_original = original
}

function unbreakThen (promise) {
  if (promise.then._dd_original) {
    promise.then = promise.then._dd_original
  }
}

function getNextLineNumber () {
  return Number(new Error().stack?.split('\n')[2].match(/:(\d+):/)?.[1]) + 1
}

module.exports = {
  breakThen,
  compare,
  deepInclude,
  expectSomeSpan,
  getNextLineNumber,
  resolveNaming,
  unbreakThen,
  withDefaults
}
