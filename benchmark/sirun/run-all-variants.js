'use strict'

const childProcess = require('child_process')
const path = require('path')
const readline = require('readline')

function exec (...args) {
  return new Promise((resolve, reject) => {
    const proc = childProcess.spawn(...args)
    streamAddVersion(proc.stdout)
    proc.on('error', reject)
    proc.on('exit', resolve)
  })
}

const metaJson = require(path.join(process.cwd(), 'meta.json'))

const env = Object.assign({}, process.env, { SIRUN_NO_STDIO: '1' })

const interval = setInterval(() => {
  // eslint-disable-next-line no-console
  console.error('This test is still running one minute later...')
}, 60000)

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

function getStdio () {
  return ['inherit', 'pipe', 'inherit']
}

(async () => {
  if (metaJson.variants) {
    const variants = metaJson.variants
    const len = Object.keys(variants).length
    let count = 0
    for (const variant in variants) {
      const variantEnv = Object.assign({}, env, { SIRUN_VARIANT: variant })
      await exec('sirun', ['meta.json'], { env: variantEnv, stdio: getStdio() })
      if (++count === len) {
        clearInterval(interval)
      }
    }
  } else {
    await exec('sirun', ['meta.json'], { env, stdio: getStdio() })
    clearInterval(interval)
  }
})()
