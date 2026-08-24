const LocalRunner = class {
  async run (workerOptions) {
    return workerOptions
  }

  async shutdown (error) {
    if (error) {
      throw error
    }
  }
}

export { LocalRunner }
