import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Linter, RuleTester } from 'eslint'
import sinon from 'sinon'

import rule from './eslint-require-export-exists.mjs'

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'script',
  },
})

const fixtureConsumerFile = path.join(
  process.cwd(),
  'eslint-rules/fixtures/require-export-exists/consumer.js'
)

ruleTester.run('eslint-require-export-exists', rule, {
  valid: [
    {
      filename: fixtureConsumerFile,
      code: 'const { foo, bar } = require("./named-exports")',
    },
    {
      filename: path.join(path.dirname(fixtureConsumerFile), 'second-consumer.js'),
      code: 'const { foo, bar } = require("./named-exports")',
    },
    {
      filename: fixtureConsumerFile,
      code: 'const { foo: renamed } = require("./object-exports")',
    },
    {
      filename: fixtureConsumerFile,
      code: 'const { "foo": renamed } = require("./object-exports")',
    },
    {
      filename: fixtureConsumerFile,
      code: 'const { ...rest } = require("./object-exports")',
    },
    {
      filename: fixtureConsumerFile,
      code: 'const { foo, bar } = require("./json-exports.json")',
    },
    {
      filename: fixtureConsumerFile,
      code: 'const baz = require("./named-exports"); baz.bar',
    },
    {
      filename: fixtureConsumerFile,
      code: 'const baz = require("./unknown-exports"); baz.anything',
    },
    {
      filename: fixtureConsumerFile,
      code: 'const { nope } = require("semver")',
    },
    {
      filename: fixtureConsumerFile,
      code: 'const { nope } = require("./does-not-exist")',
    },
  ],
  invalid: [
    {
      filename: fixtureConsumerFile,
      code: 'const { qux } = require("./named-exports")',
      errors: [{
        messageId: 'missingExport',
        data: {
          moduleName: './named-exports',
          exportName: 'qux',
        },
      }],
    },
    {
      filename: fixtureConsumerFile,
      code: 'const { baz } = require("./object-exports")',
      errors: [{
        messageId: 'missingExport',
        data: {
          moduleName: './object-exports',
          exportName: 'baz',
        },
      }],
    },
    {
      filename: fixtureConsumerFile,
      code: 'const { baz } = require("./json-exports.json")',
      errors: [{
        messageId: 'missingExport',
        data: {
          moduleName: './json-exports.json',
          exportName: 'baz',
        },
      }],
    },
  ],
})

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'eslint-require-export-exists-'))

try {
  const realTemporaryDirectory = fs.realpathSync(temporaryDirectory)
  const projectDirectory = path.join(realTemporaryDirectory, 'project')
  const targetFile = path.join(projectDirectory, 'target.js')
  const indexDirectory = path.join(projectDirectory, 'directory')
  fs.mkdirSync(projectDirectory)

  const linter = new Linter({ cwd: projectDirectory })
  const config = {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
    },
    plugins: {
      local: {
        rules: {
          'require-export-exists': rule,
        },
      },
    },
    rules: {
      'local/require-export-exists': 'error',
    },
  }

  /**
   * @param {string} code
   * @param {string} filename
   * @returns {import('eslint').Linter.LintMessage[]}
   */
  function verify (code, filename) {
    return linter.verify(code, config, { filename: path.join(projectDirectory, filename) })
  }

  fs.writeFileSync(targetFile, 'exports.foo = true\n')

  const directStatSync = sinon.spy(fs, 'statSync')
  try {
    const directMessages = verify('const target = require("./target")', 'direct-consumer.js')
    assert.deepStrictEqual(directMessages, [])
    assert.strictEqual(directStatSync.withArgs(targetFile).callCount, 0)
  } finally {
    directStatSync.restore()
  }

  const initialTargetStats = fs.statSync(targetFile)
  const changedCtimeStats = fs.statSync(targetFile)
  changedCtimeStats.dev = initialTargetStats.dev
  changedCtimeStats.ino = initialTargetStats.ino
  changedCtimeStats.size = initialTargetStats.size
  changedCtimeStats.mtimeMs = initialTargetStats.mtimeMs
  changedCtimeStats.ctimeMs = initialTargetStats.ctimeMs + 1

  assert.strictEqual(changedCtimeStats.dev, initialTargetStats.dev)
  assert.strictEqual(changedCtimeStats.ino, initialTargetStats.ino)
  assert.strictEqual(changedCtimeStats.size, initialTargetStats.size)
  assert.strictEqual(changedCtimeStats.mtimeMs, initialTargetStats.mtimeMs)
  assert.strictEqual(changedCtimeStats.ctimeMs, initialTargetStats.ctimeMs + 1)

  const statSync = sinon.stub(fs, 'statSync').callThrough()
  const targetStatSync = statSync.withArgs(targetFile)
  targetStatSync.callThrough()
  targetStatSync.onFirstCall().returns(initialTargetStats)
  targetStatSync.onSecondCall().returns(initialTargetStats)
  targetStatSync.onThirdCall().returns(changedCtimeStats)

  try {
    const firstMessages = verify('const { missing } = require("./target")', 'first-consumer.js')
    assert.strictEqual(firstMessages.length, 1)
    assert.strictEqual(firstMessages[0].messageId, 'missingExport')

    const secondMessages = verify('const { foo } = require("./target")', 'second-consumer.js')
    assert.deepStrictEqual(secondMessages, [])

    fs.writeFileSync(targetFile, 'exports.bar = true\n')

    const mutatedMessages = verify('const { bar } = require("./target")', 'updated-consumer.js')
    assert.deepStrictEqual(mutatedMessages, [])
  } finally {
    statSync.restore()
  }

  fs.writeFileSync(targetFile, 'module.exports = JSON.parse("{}")\n')

  const unknownMessages = verify('const { anything } = require("./target")', 'unknown-consumer.js')
  assert.deepStrictEqual(unknownMessages, [])

  const repeatedUnknownMessages = verify(
    'const { stillAnything } = require("./target")',
    'second-unknown-consumer.js'
  )
  assert.deepStrictEqual(repeatedUnknownMessages, [])

  fs.writeFileSync(targetFile, 'exports.\n')

  const malformedMessages = verify('const { anything } = require("./target")', 'malformed-consumer.js')
  assert.deepStrictEqual(malformedMessages, [])

  fs.writeFileSync(targetFile, 'exports.final = true\n')

  const finalMessages = verify('const { final } = require("./target")', 'final-consumer.js')
  assert.deepStrictEqual(finalMessages, [])

  fs.mkdirSync(indexDirectory)
  fs.writeFileSync(path.join(indexDirectory, 'index.cjs'), 'exports.foo = true\n')

  const indexMessages = verify('const { foo } = require("./directory")', 'index-consumer.js')
  assert.deepStrictEqual(indexMessages, [])

  const absoluteMessages = verify('const { missing } = require("/directory")', 'absolute-consumer.js')
  assert.strictEqual(absoluteMessages.length, 1)
  assert.strictEqual(absoluteMessages[0].messageId, 'missingExport')

  fs.writeFileSync(path.join(realTemporaryDirectory, 'outside.js'), 'exports.foo = true\n')

  const outsideMessages = verify('const { missing } = require("../outside")', 'outside-consumer.js')
  assert.deepStrictEqual(outsideMessages, [])

  const siblingProjectDirectory = path.join(realTemporaryDirectory, 'sibling-project')
  fs.mkdirSync(siblingProjectDirectory)
  fs.writeFileSync(path.join(siblingProjectDirectory, 'target.js'), 'exports.sibling = true\n')
  const siblingLinter = new Linter({ cwd: siblingProjectDirectory })
  const siblingMessages = siblingLinter.verify(
    'const { final } = require("./target")',
    config,
    { filename: path.join(siblingProjectDirectory, 'consumer.js') }
  )
  assert.strictEqual(siblingMessages.length, 1)
  assert.strictEqual(siblingMessages[0].messageId, 'missingExport')

  const evictionTarget = path.join(projectDirectory, 'eviction-target.json')
  const evictionTargetsDirectory = path.join(projectDirectory, 'eviction-targets')
  fs.mkdirSync(evictionTargetsDirectory)
  fs.writeFileSync(evictionTarget, '{"foo":true}\n')

  const { default: evictionRule } = await import('./eslint-require-export-exists.mjs?eviction-test')
  const evictionLinter = new Linter({ cwd: projectDirectory })
  const evictionConfig = {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
    },
    plugins: {
      local: {
        rules: {
          'require-export-exists': evictionRule,
        },
      },
    },
    rules: {
      'local/require-export-exists': 'error',
    },
  }

  /**
   * @param {string} code
   * @param {string} filename
   * @returns {import('eslint').Linter.LintMessage[]}
   */
  function verifyEviction (code, filename) {
    return evictionLinter.verify(code, evictionConfig, { filename: path.join(projectDirectory, filename) })
  }

  const readFileSync = sinon.spy(fs, 'readFileSync')
  try {
    const evictionTargetMessages = verifyEviction(
      'const { foo } = require("./eviction-target.json")',
      'eviction-target-consumer.js'
    )
    assert.deepStrictEqual(evictionTargetMessages, [])

    for (let index = 0; index < 2047; index++) {
      const targetName = `target-${index}.json`
      fs.writeFileSync(path.join(evictionTargetsDirectory, targetName), '{"foo":true}\n')
      const messages = verifyEviction(
        `const { foo } = require("./eviction-targets/${targetName}")`,
        `eviction-consumer-${index}.js`
      )
      assert.deepStrictEqual(messages, [])
    }

    const cachedEvictionTargetMessages = verifyEviction(
      'const { foo } = require("./eviction-target.json")',
      'cached-eviction-target-consumer.js'
    )
    assert.deepStrictEqual(cachedEvictionTargetMessages, [])
    assert.strictEqual(readFileSync.withArgs(evictionTarget, 'utf8').callCount, 1)

    fs.writeFileSync(path.join(evictionTargetsDirectory, 'target-2047.json'), '{"foo":true}\n')
    const overflowMessages = verifyEviction(
      'const { foo } = require("./eviction-targets/target-2047.json")',
      'overflow-consumer.js'
    )
    assert.deepStrictEqual(overflowMessages, [])

    const evictedTargetMessages = verifyEviction(
      'const { foo } = require("./eviction-target.json")',
      'evicted-target-consumer.js'
    )
    assert.deepStrictEqual(evictedTargetMessages, [])
    assert.strictEqual(readFileSync.withArgs(evictionTarget, 'utf8').callCount, 2)
  } finally {
    readFileSync.restore()
  }
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true })
}
