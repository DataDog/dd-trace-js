'use strict'

const declarationMethods = new Set([
  'concurrent', 'sequential', 'skip', 'only', 'todo', 'fails', 'each', 'for', 'extend', 'skipIf', 'runIf',
])
const wrappedDeclarations = new WeakMap()

/**
 * Captures declaration metadata before Vitest replaces callbacks for fixtures, timeouts and parameterized cases.
 *
 * @param {Function} declaration
 * @param {Function} getCurrentSuite
 */
function wrapDeclaration (declaration, getCurrentSuite) {
  if (wrappedDeclarations.has(declaration)) return wrappedDeclarations.get(declaration)
  const wrapped = new Proxy(declaration, {
    apply (target, receiver, args) {
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
      if (!annotations) {
        const result = Reflect.apply(target, receiver, args)
        return typeof result === 'function' ? wrapDeclaration(result, getCurrentSuite) : result
      }
      const collector = getCurrentSuite()
      const firstTask = collector.tasks.length
      const hasFrameworkRetry = options?.retry !== undefined || collector.options?.retry !== undefined
      const result = Reflect.apply(target, receiver, args)
      for (let index = firstTask; index < collector.tasks.length; index++) {
        const task = collector.tasks[index]
        task.meta = {
          ...task.meta,
          __ddTestOptAnnotations: {
            mustFail: annotations.mustFail,
            noAutoRetry: annotations.noAutoRetry,
            hasFrameworkRetry,
          },
        }
      }
      return result
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

module.exports = { wrapDeclaration }
