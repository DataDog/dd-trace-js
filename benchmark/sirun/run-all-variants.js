'use strict'

const childProcess = require('child_process')
const path = require('path')

function exec (...args) {
  return new Promise((resolve, reject) => {
    const proc = childProcess.spawn(...args)
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

;(async () => {
  if (metaJson.variants) {
    const variants = metaJson.variants
    const len = Object.keys(variants).length
    let count = 0
    for (const variant in variants) {
      const variantEnv = Object.assign({}, env, { SIRUN_VARIANT: variant })
      await exec('sirun', ['meta.json'], { env: variantEnv, stdio: 'inherit' })
      if (++count === len) {
        clearInterval(interval)
      }
    }
  } else {
    await exec('sirun', ['meta.json'], { env, stdio: 'inherit' })
    clearInterval(interval)
  }
})()
