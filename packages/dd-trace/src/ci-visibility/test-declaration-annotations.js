'use strict'

const declarationMethods = new Set([
  'concurrent', 'sequential', 'skip', 'only', 'todo', 'fails', 'each', 'for', 'extend', 'skipIf', 'runIf',
])
const wrappedDeclarations = new WeakMap()
const capturedCollectors = new WeakSet()
const declarationFactories = ['each', 'for', 'extend', 'skipIf', 'runIf']

/**
 * @typedef {{
 *   type: 'collector', test: Function & { fn: Function }, tasks: object[], options?: { retry?: unknown }
 * }} Collector
 */

/**
 * @param {Function & { fn: Function }} test
 * @param {() => Collector} getCurrentSuite
 */
function captureDeclarations (test, getCurrentSuite) {
  captureFactories(test, getCurrentSuite)
  captureCollector(getCurrentSuite())
}

/**
 * @param {Function & { fn: Function }} test
 * @param {() => Collector} getCurrentSuite
 */
function captureFactories (test, getCurrentSuite) {
  for (const target of [test, test.fn]) {
    for (const method of declarationFactories) {
      if (typeof target[method] === 'function') target[method] = wrapDeclaration(target[method], getCurrentSuite)
    }
  }
}

/** @param {Collector} collector */
function captureCollector (collector) {
  if (capturedCollectors.has(collector)) return
  capturedCollectors.add(collector)

  const getCollector = () => collector
  const declaration = collector.test.fn
  const wrapped = wrapDeclaration(declaration, getCollector)
  captureFactories(collector.test, getCollector)
  // Vitest's exported test dispatches through .fn.call; suite-local chains close over .fn and use .apply.
  // Intercept both invocations without replacing the callable or its non-configurable .fn property.
  Object.defineProperties(declaration, {
    call: {
      /**
       * @param {unknown} receiver
       * @param {unknown[]} args
       */
      value (receiver, ...args) { return Reflect.apply(wrapped, receiver, args) },
      writable: true,
      configurable: true,
    },
    apply: {
      /**
       * @param {unknown} receiver
       * @param {unknown[]} args
       */
      value (receiver, args) { return Reflect.apply(wrapped, receiver, args) },
      writable: true,
      configurable: true,
    },
  })
  const push = collector.tasks.push
  collector.tasks.push = function (...tasks) {
    for (const task of tasks) {
      if (task.type === 'collector') captureCollector(task)
    }
    return push.apply(this, tasks)
  }
}

/**
 * Captures declaration metadata before Vitest replaces callbacks for fixtures, timeouts and parameterized cases.
 *
 * @param {Function} declaration
 * @param {() => Collector} getCurrentSuite
 */
function wrapDeclaration (declaration, getCurrentSuite) {
  if (wrappedDeclarations.has(declaration)) return wrappedDeclarations.get(declaration)
  const wrapped = new Proxy(declaration, {
    apply (target, receiver, args) {
      const collector = getCurrentSuite()
      captureCollector(collector)
      let annotations
      let options
      for (let index = 1; index < args.length; index++) {
        const argument = args[index]
        if (typeof argument === 'function') {
          const observed = argument[Symbol.for('dd-trace:test-annotations')] || {}
          if (observed.mustFail || observed.noAutoRetry) annotations = observed
        } else if (argument && typeof argument === 'object') {
          options = argument
        }
      }
      const hasFrameworkRetry = options?.retry !== undefined || collector.options?.retry !== undefined
      if (!annotations && !hasFrameworkRetry) {
        const result = Reflect.apply(target, receiver, args)
        return typeof result === 'function' ? wrapDeclaration(result, getCurrentSuite) : result
      }
      const firstTask = collector.tasks.length
      const result = Reflect.apply(target, receiver, args)
      for (let index = firstTask; index < collector.tasks.length; index++) {
        const task = collector.tasks[index]
        if (task.type !== 'test') continue
        if (hasFrameworkRetry) task.meta = { ...task.meta, __ddTestOptNativeRetry: true }
        if (annotations) {
          task.meta = {
            ...task.meta,
            __ddTestOptAnnotations: {
              mustFail: annotations.mustFail,
              noAutoRetry: annotations.noAutoRetry,
              hasFrameworkRetry: hasFrameworkRetry || task.meta?.__ddTestOptHasFrameworkRetry === true,
            },
          }
        }
      }
      return typeof result === 'function' ? wrapDeclaration(result, getCurrentSuite) : result
    },
    get (target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      return declarationMethods.has(property) && typeof value === 'function'
        ? wrapDeclaration(value, getCurrentSuite)
        : value
    },
  })
  wrappedDeclarations.set(wrapped, wrapped)
  wrappedDeclarations.set(declaration, wrapped)
  return wrapped
}

// Browser Mode serves this dependency as ESM without CommonJS conversion in independent projects.
if (typeof module === 'undefined') {
  globalThis[Symbol.for('dd-trace.vitest.declaration-annotations')] = { captureDeclarations }
} else {
  module.exports = { wrapDeclaration, captureDeclarations }
}
