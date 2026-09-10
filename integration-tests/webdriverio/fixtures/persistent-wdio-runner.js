'use strict'

const path = require('node:path')

const baseEnvironment = { ...process.env }
let activeOutput
let previousEnvironmentKeys = []
let runQueue = Promise.resolve()

captureOutput(process.stdout)
captureOutput(process.stderr)

process.on('message', message => {
  if (message.type === 'shutdown') {
    runQueue.finally(() => process.exit())
    return
  }
  if (message.type !== 'run') return

  runQueue = runQueue.then(() => run(message))
})

process.send?.({ type: 'ready' })

/**
 * Runs one WebdriverIO launcher while keeping its Node.js process warm.
 *
 * @param {{ cwd: string, environment: Record<string, string>, id: number }} message
 * @returns {Promise<void>}
 */
async function run ({ cwd, environment, id }) {
  activeOutput = []
  setEnvironment(environment)
  process.chdir(cwd)

  try {
    const configPath = path.join(cwd, 'wdio.conf.js')
    const { getConfig } = require(configPath)
    // Installed only in the integration-test sandbox.
    // eslint-disable-next-line n/no-missing-import
    const { Launcher } = await import('@wdio/cli')
    const exitCode = await new Launcher('./wdio.conf.js', getConfig()).run()
    process.send?.({
      exitCode,
      id,
      output: activeOutput.join(''),
      type: 'result',
    })
  } catch (error) {
    process.send?.({
      error: {
        message: error.message,
        stack: error.stack,
      },
      id,
      output: activeOutput.join(''),
      type: 'result',
    })
  } finally {
    activeOutput = undefined
  }
}

/**
 * Restores the launcher's startup environment, then applies one run's overrides.
 *
 * @param {Record<string, string>} environment
 * @returns {void}
 */
function setEnvironment (environment) {
  for (const key of previousEnvironmentKeys) {
    if (baseEnvironment[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = baseEnvironment[key]
    }
  }
  for (const [key, value] of Object.entries(environment)) {
    process.env[key] = value
  }
  previousEnvironmentKeys = Object.keys(environment)
}

/**
 * Captures output synchronously so the parent receives all run output with the result message.
 *
 * @param {import('node:stream').Writable} stream
 * @returns {void}
 */
function captureOutput (stream) {
  const write = stream.write
  stream.write = function (chunk, ...args) {
    if (activeOutput) {
      activeOutput.push(Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk))
    }
    return write.call(this, chunk, ...args)
  }
}
