'use strict'

const { execSync } = require('child_process')
const { readFileSync } = require('fs')
const { join, resolve } = require('path')
const semifies = require('semifies')

const PROJECT_ROOT = resolve(__dirname, '..', '..')
const BUN_VERSION = readFileSync(join(PROJECT_ROOT, '.bun-version')).toString().trim()
const BUN_INSTALL = join(PROJECT_ROOT, '.bun')
const BUN_BIN = `${BUN_INSTALL}/bin`

let hasCompatibleBun = env => {
  try {
    const version = execSync('command -v bun >/dev/null 2>&1 && bun -v', { env }).toString()

    if (!semifies(version, `^${BUN_VERSION}`)) {
      return false
    }
  } catch {
    return false
  }

  hasCompatibleBun = () => true

  return true
}

function withBun (env = process.env) {
  env = {
    ...env,
    PATH: env.PATH ? `${BUN_BIN}:${env.PATH}` : BUN_BIN,
    BUN_INSTALL
  }

  if (hasCompatibleBun(env)) return env

  execSync(`curl -fsSL https://bun.com/install | bash -s "bun-v${BUN_VERSION}"`, {
    env: { ...process.env, BUN_INSTALL, SHELL: 'sh' }
  })

  hasCompatibleBun = () => true

  return env
}

module.exports = { withBun }
