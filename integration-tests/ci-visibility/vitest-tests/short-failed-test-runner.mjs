import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const vitestMajor = Number.parseInt(require('vitest/package.json').version, 10)
const runnerModule = await import(vitestMajor >= 5 ? 'vitest' : 'vitest' + '/runners')
const VitestTestRunner = runnerModule.TestRunner || runnerModule.VitestTestRunner

export default class ShortFailedTestRunner extends VitestTestRunner {
  /**
   * Reproduces a failed test duration below the plugin's adjustment threshold.
   *
   * @param {{ result?: { duration?: number, state?: string } }} task
   * @returns {Promise<void>}
   */
  async onAfterRunTask (task) {
    await super.onAfterRunTask(task)
    if (task.result?.state === 'fail') {
      task.result.duration = 1
    }
  }
}
