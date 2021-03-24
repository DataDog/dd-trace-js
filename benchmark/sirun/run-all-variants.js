'use strict'

const childProcess = require('child_process')
const path = require('path')

const metaJson = require(path.join(process.cwd(), 'meta.json'))

const env = Object.assign({}, process.env, { SIRUN_NO_STDIO: '1' })

if (metaJson.variants) {
  const variants = metaJson.variants
  for (const variant in variants) {
    const variantEnv = Object.assign({}, env, { SIRUN_VARIANT: variant })
    childProcess.execSync(`sirun meta.json`, { env: variantEnv, stdio: 'inherit' })
  }
} else {
  childProcess.exec(`sirun meta.json`, { env, stdio: 'inherit' })
}
