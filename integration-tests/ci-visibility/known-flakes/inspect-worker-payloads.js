'use strict'

const childProcess = require('node:child_process')
const { appendFileSync } = require('node:fs')
const path = require('node:path')
const { runInNewContext } = require('node:vm')
const { Worker } = require('node:worker_threads')

function inspectSends (target, method) {
  const original = target[method]
  target[method] = function (message) {
    let testPath
    let options
    if (message?.method === 'run' && typeof message.params?.[1] === 'string') {
      testPath = message.params[0]
      // Mocha sends a serialize-javascript literal and evaluates it in its worker.
      options = runInNewContext(`(${message.params[1]})`)
    } else if (Array.isArray(message)) {
      const call = message.at(-1)?.[0]
      testPath = call?.path
      options = call?.config?.testEnvironmentOptions
    }
    if (testPath && options) {
      appendFileSync(process.env.WORKER_PAYLOADS_FILE, JSON.stringify({
        suite: path.relative(process.cwd(), testPath).split(path.sep).join('/'),
        flakyTests: options._ddFlakyTests,
      }) + '\n')
    }
    return original.apply(this, arguments)
  }
}

const fork = childProcess.fork
childProcess.fork = function () {
  const child = fork.apply(this, arguments)
  inspectSends(child, 'send')
  return child
}
inspectSends(Worker.prototype, 'postMessage')
