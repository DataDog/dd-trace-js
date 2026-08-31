const BaseReporter = class {
  waitForSync () {
    return Promise.resolve(true)
  }
}

const Runner = class {
  constructor () {
    this._reporter = new BaseReporter()
    this._framework = {
      run: () => Promise.resolve(0),
    }
  }

  async run (args) {
    const failures = await this._framework.run()
    if (!args.watch) {
      await this.endSession()
    }
    return failures
  }

  async _shutdown (failures) {
    await this._reporter.waitForSync()
    this.emit('exit', failures === 0 ? 0 : 1)
    return failures
  }

  emit (event, code) {
    this.onEvent?.(event, code)
  }

  endSession () {
    this.onEvent?.('session:end')
  }
}

export { BaseReporter, Runner }
