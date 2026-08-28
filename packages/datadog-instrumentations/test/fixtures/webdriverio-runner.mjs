const BaseReporter = class {
  waitForSync () {
    return Promise.resolve(true)
  }
}

const Runner = class {
  constructor () {
    this._reporter = new BaseReporter()
  }

  async _shutdown (failures) {
    await this._reporter.waitForSync()
    this.emit('exit', failures === 0 ? 0 : 1)
    return failures
  }

  emit (event, code) {
    this.onEvent?.(event, code)
  }
}

export { BaseReporter, Runner }
