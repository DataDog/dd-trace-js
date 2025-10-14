'use strict'

const childProcess = require('child_process')
const readline = require('readline')

function exec (...args) {
  return /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
    const proc = childProcess.spawn(...args)
    streamAddVersion(proc.stdout)
    proc.on('error', reject)
    proc.on('exit', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error('Process exited with non-zero code.'))
      }
    })
  }))
}

function streamAddVersion (input) {
  input.rl = readline.createInterface({ input })
  input.rl.on('line', function (line) {
    try {
      const json = JSON.parse(line.toString())
      json.nodeVersion = process.versions.node
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(json))
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log(line)
    }
  })
}

module.exports = {
  exec,
  stdio: ['inherit', 'pipe', 'inherit'],
  streamAddVersion
}
