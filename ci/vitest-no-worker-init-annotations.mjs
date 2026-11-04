import declarations from '../packages/dd-trace/src/ci-visibility/test-declaration-annotations.js'

const { wrapDeclaration } = declarations

const capturedCollectors = new WeakSet()
const declarationFactories = ['each', 'for', 'extend', 'skipIf', 'runIf']

/**
 * @typedef {{
 *   type: 'collector', test: Function & { fn: Function }, tasks: object[], options?: { retry?: unknown }
 * }} Collector
 */

/**
 * Captures callbacks through Vitest's runtime collector without installing a Node module loader.
 * @param {Function & { fn: Function }} test
 * @param {() => Collector} getCurrentSuite
 */
export function captureDeclarations (test, getCurrentSuite) {
  // Chain modifiers copy these factories from test.fn when they create a new declaration.
  for (const target of [test, test.fn]) {
    for (const method of declarationFactories) {
      target[method] = wrapDeclaration(target[method], getCurrentSuite)
    }
  }

  captureCollector(getCurrentSuite())

  /** @param {Collector} collector */
  function captureCollector (collector) {
    if (capturedCollectors.has(collector)) return
    capturedCollectors.add(collector)

    const original = collector.test
    const declaration = wrapDeclaration(original.fn, getCurrentSuite)
    const descriptors = Object.getOwnPropertyDescriptors(original)
    // Vitest 5 makes .fn non-configurable; replace the collector's callable while preserving its chain context.
    descriptors.fn.value = function (name, optionsOrFn, fnOrOptions) {
      const options = optionsOrFn !== null && typeof optionsOrFn === 'object' ? optionsOrFn : fnOrOptions
      const length = collector.tasks.length
      const result = declaration.apply(this, arguments)
      if (options?.retry !== undefined || collector.options?.retry !== undefined) {
        for (let index = length; index < collector.tasks.length; index++) {
          const task = collector.tasks[index]
          task.meta = { ...task.meta, __ddTestOptNativeRetry: true }
        }
      }
      return result
    }
    collector.test = Object.defineProperties(function (...args) {
      return original.apply(this, args)
    }, descriptors)

    const push = collector.tasks.push
    collector.tasks.push = function (...tasks) {
      for (const task of tasks) {
        if (task.type === 'collector') captureCollector(task)
      }
      return push.apply(this, tasks)
    }
  }
}
