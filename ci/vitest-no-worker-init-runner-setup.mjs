try {
  // Vitest does not expose setFn from its public setup API; keep this optional for strict installers.
  const vitestRunner = await import('@vitest/runner')
  globalThis[Symbol.for('dd-trace.vitest.set-fn')] = vitestRunner.setFn
  trackNativeRetryOptions(vitestRunner.getCurrentSuite())
} catch {}
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
      collector.tasks.at(-1).meta.__ddTestOptNativeRetry = true
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
