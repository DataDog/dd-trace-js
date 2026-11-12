export default class ThrowingReporter {
  async onTestRunEnd () {
    throw new Error('custom Vitest reporter failed')
  }
}
