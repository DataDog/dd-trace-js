import * as vitest from 'vitest'

const vitestRunner = vitest.TestRunner || await import('vitest/suite')
globalThis[Symbol.for('dd-trace.vitest.set-fn')] = vitestRunner.setTestFn || vitestRunner.setFn
if (globalThis.process?.env?.DD_TEST_OPT_VITEST_NO_WORKER_INIT_ACTIVE === '1') {
  const { captureDeclarations } = await import('./vitest-no-worker-init-annotations.mjs')
  captureDeclarations(vitest.test, vitestRunner.getCurrentSuite)
} else {
  trackNativeRetryOptions(vitestRunner.getCurrentSuite())
}
globalThis[Symbol.for('dd-trace.vitest.browser-context-importer')] = () => import('@vitest/browser/context')

await import('./vitest-no-worker-init-setup.mjs')

/**
 * Legacy Vitest inherits numeric retries and loses their origin during collection.
 * These collectors and their chainable callbacks are created at runtime.
 * @param {object} collector
 */
function trackNativeRetryOptions (collector) {
  const original = collector.test.fn
  collector.test.fn = function (name, optionsOrFn, fnOrOptions) {
    const options = optionsOrFn !== null && typeof optionsOrFn === 'object' ? optionsOrFn : fnOrOptions
    const length = collector.tasks.length
    const result = original.apply(this, arguments)
    if ((options?.retry !== undefined || collector.options?.retry !== undefined) && collector.tasks.length > length) {
      const task = collector.tasks.at(-1)
      task.meta = { ...task.meta, __ddTestOptNativeRetry: true }
    }
    return result
  }
  const push = collector.tasks.push
  collector.tasks.push = function (...tasks) {
    for (const task of tasks) {
      if (task.type === 'collector') trackNativeRetryOptions(task)
    }
    return push.apply(this, tasks)
  }
}
