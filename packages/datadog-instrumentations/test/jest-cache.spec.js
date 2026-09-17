'use strict'

const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')

const dc = require('dc-polyfill')

require('../src/jest')

const keyChannel = dc.tracingChannel('orchestrion:ts-jest:getCacheKey')
const hashChannel = dc.tracingChannel('orchestrion:ts-jest:cacheHash')
const sessionChannel = dc.channel('ci:jest:session:start')
const suffix = 'a'.repeat(40)
const source = 'export const value = 1'
const noop = () => {}

describe('Jest dependency cache input normalization', () => {
  let root
  let dependency
  let filename

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(tmpdir(), 'dd-jest-cache-'))
    dependency = path.join(root, 'dependency.ts')
    filename = path.join(root, 'consumer.ts')
    fs.writeFileSync(dependency, source)
    sessionChannel.subscribe(noop)
  })

  afterEach(() => {
    sessionChannel.unsubscribe(noop)
    fs.rmSync(root, { recursive: true, force: true })
  })

  function inputs () {
    return [
      JSON.stringify({ testEnvironmentOptions: { _ddTestSessionId: 'session', userOption: 'keep' } }) + suffix,
      '\0', root, '\0', 'instrument:off', '\0', 'supportsStaticESM:off', '\0', source, '\0', filename,
      '\0', dependency, '\0', '123',
    ]
  }

  function normalize (args) {
    return keyChannel.traceSync(() => {
      return hashChannel.traceSync(() => args, { arguments: args })
    }, { arguments: [source, filename] })
  }

  it('normalizes copied config and dependency contents without altering other inputs', () => {
    const args = inputs()
    const originalConfig = args[0]
    normalize(args)
    assert.deepStrictEqual(JSON.parse(args[0].slice(0, -40)), { testEnvironmentOptions: { userOption: 'keep' } })
    assert(originalConfig.includes('_ddTestSessionId'))
    assert.strictEqual(args[14], createHash('sha256').update(source).digest('hex'))
    assert.deepStrictEqual(args.slice(1, 14), inputs().slice(1, 14))
    assert.deepStrictEqual(args.slice(15), ['\0', 'dd-ts-jest-content-cache-v1'])
  })

  it('reads changed contents even when timestamps are identical', () => {
    const { atime, mtime } = fs.statSync(dependency)
    const before = normalize(inputs())[14]
    fs.writeFileSync(dependency, 'export const value = 2')
    fs.utimesSync(dependency, atime, mtime)
    assert.notStrictEqual(normalize(inputs())[14], before)
  })

  it('does not change cache inputs without Test Optimization subscribers', () => {
    sessionChannel.unsubscribe(noop)
    const args = inputs()
    assert.deepStrictEqual(normalize(args), inputs())
  })

  it('does not change hashes outside a cache-key call, including after an error', () => {
    assert.throws(() => keyChannel.traceSync(() => {
      throw new Error('fixture error')
    }, { arguments: [source, filename] }), { message: 'fixture error' })
    const args = inputs()
    hashChannel.traceSync(noop, { arguments: args })
    assert.deepStrictEqual(args, inputs())
  })

  it('leaves all original inputs intact when a dependency cannot be read', () => {
    const args = inputs()
    args.push('\0', path.join(root, 'missing.ts'), '\0', '456')
    const original = [...args]
    assert.deepStrictEqual(normalize(args), original)
  })

  it('leaves unsupported layouts and other hashes unchanged', () => {
    for (const change of [
      args => { args[0] = 'invalid JSON' + suffix },
      args => { args[0] = '{}' },
      args => { args[1] = 'unexpected separator' },
      args => { args[8] = 'different source' },
      args => { args[10] = 'different path' },
      args => { args[13] = 'unexpected separator' },
      args => { args[14] = undefined },
      args => { args.pop() },
    ]) {
      const args = inputs()
      change(args)
      const original = [...args]
      assert.deepStrictEqual(normalize(args), original)
    }
  })
})
