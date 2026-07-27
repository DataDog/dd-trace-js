import { VitestTestRunner } from 'vitest/runners'

export default class ShortFailedTestRunner extends VitestTestRunner {
  /**
   * Reproduces a failed test duration below the plugin's adjustment threshold.
   *
   * @param {import('@vitest/runner').TaskPopulated} task
   * @returns {Promise<void>}
   */
  async onAfterRunTask (task) {
    await super.onAfterRunTask(task)
    if (task.result?.state === 'fail') {
      task.result.duration = 1
    }
  }
}
