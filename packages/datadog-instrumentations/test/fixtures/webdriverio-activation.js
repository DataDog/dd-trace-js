'use strict'

const assert = require('node:assert/strict')
const { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { dirname, join } = require('node:path')
const { pathToFileURL } = require('node:url')

const { channel } = require('dc-polyfill')

const rewriter = require('../../src/helpers/rewriter')

const [moduleName, sourcePath, filePath, mode, expectedActivation] = process.argv.slice(2)
const isCiVisibility = mode === 'test-optimization'
const activate = expectedActivation === 'true'
const runtimePath = require.resolve('../../src/webdriverio')
const loadChannel = channel('dd-trace:instrumentation:load')
const commandChannel = channel('tracing:orchestrion:webdriver:command:end')
const runnerChannel = channel('tracing:orchestrion:@wdio/local-runner:LocalRunner_run:start')
const mochaChannel = channel('ci:mocha:test:finish')
const loads = []

async function main () {
  const directory = mkdtempSync(join(tmpdir(), 'dd-webdriverio-activation-'))
  try {
    const packageDirectory = join(directory, 'node_modules', moduleName)
    const filename = join(packageDirectory, filePath)
    mkdirSync(dirname(filename), { recursive: true })
    writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify({
      name: moduleName,
      version: moduleName === 'jasmine-core' ? '5.1.2' : '9.30.0',
      type: moduleName === 'jasmine-core' ? 'commonjs' : 'module',
    }))
    copyFileSync(sourcePath, filename)

    const source = readFileSync(filename, 'utf8')
    const rewritten = rewriter.rewrite(source, filename, moduleName === 'jasmine-core' ? 'commonjs' : 'module')
    assert.notStrictEqual(rewritten, source)

    loadChannel.subscribe(({ name }) => {
      if (name === '@wdio/local-runner') loads.push(name)
    })
    if (isCiVisibility) {
      require('../../../../ci/init')
    } else {
      require('../../../..').init({ startupLogs: false })
    }

    assert.strictEqual(require.cache[runtimePath], undefined)
    assert.strictEqual(commandChannel.hasSubscribers, false)
    assert.strictEqual(runnerChannel.hasSubscribers, false)
    assert.strictEqual(mochaChannel.hasSubscribers, false)

    await import(pathToFileURL(filename).href)

    assert.strictEqual(require.cache[runtimePath] !== undefined, activate)
    assert.strictEqual(commandChannel.hasSubscribers, activate)
    assert.strictEqual(runnerChannel.hasSubscribers, activate)
    assert.strictEqual(mochaChannel.hasSubscribers, activate && isCiVisibility)
    assert.strictEqual(loads.length > 0, activate)

    if (!activate) {
      // Shared dependencies can load first; the real runner must still activate later.
      const runnerDirectory = join(directory, 'node_modules', '@wdio', 'local-runner')
      const runnerFilename = join(runnerDirectory, 'build', 'index.js')
      mkdirSync(dirname(runnerFilename), { recursive: true })
      writeFileSync(join(runnerDirectory, 'package.json'), '{"version":"9.30.0","type":"module"}')
      copyFileSync(join(__dirname, 'webdriverio-local-runner.mjs'), runnerFilename)

      await import(pathToFileURL(runnerFilename).href)

      assert.notStrictEqual(require.cache[runtimePath], undefined)
      assert.strictEqual(commandChannel.hasSubscribers, true)
      assert.strictEqual(runnerChannel.hasSubscribers, true)
      assert.strictEqual(mochaChannel.hasSubscribers, isCiVisibility)
      assert.ok(loads.length > 0)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})
