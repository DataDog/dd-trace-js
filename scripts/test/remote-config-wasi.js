'use strict'

const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const [bundle, sourceCommit] = process.argv.slice(2)
if (bundle === undefined || !/^[0-9a-f]{40}$/.test(sourceCommit ?? '')) {
  throw new Error('Usage: npm run test:remote-config:wasi -- <bundle-directory> <libdatadog-commit>')
}

const wasm = 'libdd_remote_config_wasm.wasm'
const fixture = 'agentless-fixture.mjs'
const source = readFileSync(resolve(bundle, 'SOURCE_COMMIT'), 'utf8').trim()
if (source !== sourceCommit) {
  throw new Error('Remote Config WASI bundle source commit does not match')
}

const files = [wasm, 'abi.json', fixture, 'SOURCE_COMMIT']
let checksums = ''
for (const file of files) {
  const hash = createHash('sha256').update(readFileSync(resolve(bundle, file))).digest('hex')
  checksums += hash + '  ' + file + '\n'
}
if (readFileSync(resolve(bundle, 'SHA256SUMS'), 'utf8') !== checksums) {
  throw new Error('Remote Config WASI bundle checksums do not match')
}

const testDir = 'packages/dd-trace/test/remote_config'
const result = spawnSync(process.execPath, [
  require.resolve('mocha/bin/mocha.js'),
  '--fail-zero',
  '--forbid-pending',
  '--timeout', '30000',
  testDir + '/wasm.spec.js',
  testDir + '/wasm-agentless.spec.js',
], {
  cwd: resolve(__dirname, '../..'),
  env: {
    ...process.env,
    MOCHA_OPTIONS: '',
    DD_RC_TEST_WASM: resolve(bundle, wasm),
    DD_RC_TEST_AGENTLESS_FIXTURE: resolve(bundle, fixture),
  },
  stdio: 'inherit',
})
if (result.error !== undefined) {
  throw result.error
}
process.exitCode = result.status ?? 1
