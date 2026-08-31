'use strict'

/**
 * @param {typeof import('node:child_process').ChildProcess} ChildProcess
 */
module.exports = function installNoopSpawn (ChildProcess) {
  /**
   * @param {{ file: string, args?: string[] }} options
   */
  ChildProcess.prototype.spawn = function noopSpawn (options) {
    this.spawnfile = options.file
    this.spawnargs = options.args ?? []
    this.pid = 1
    this.stdin = null
    this.stdout = null
    this.stderr = null
    this.stdio = [null, null, null]

    process.nextTick(() => {
      this.emit('spawn')
      this.emit('exit', 0, null)
      this.emit('close', 0, null)
    })

    return 0
  }
}
