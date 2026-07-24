const LocalRunner = class {
  async run (workerOptions) {
    return workerOptions
  }

  async shutdown () {}
}

export { LocalRunner }
