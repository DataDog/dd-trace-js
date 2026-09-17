'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { promisify } = require('node:util')

const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { getCiVisAgentlessConfig, sandboxCwd, useSandbox } = require('../helpers')

const execFileAsync = promisify(execFile)

describe('ts-jest persistent transform cache', function () {
  this.timeout(120_000)
  useSandbox(['jest@30.4.0', 'ts-jest@29.4.5', 'typescript@5.9.3', '@types/jest@30.0.0'], false, [])

  let receiver
  let cwd
  let checkout
  let cache
  let log
  const events = []
  const sessions = new Set()

  before(async () => {
    cwd = sandboxCwd()
    checkout = path.join(cwd, 'checkout')
    cache = path.join(cwd, 'cache')
    log = path.join(cwd, 'transforms.jsonl')
    receiver = await new FakeCiVisIntake().start()
    receiver.setSettings({
      code_coverage: false,
      tests_skipping: false,
      itr_enabled: false,
      require_git: false,
      early_flake_detection: { enabled: false },
      flaky_test_retries_enabled: false,
      known_tests_enabled: false,
      test_management: { enabled: false },
      impacted_tests_enabled: false,
    })
    receiver.on('message', ({ url, payload }) => {
      if (url.endsWith('/api/v2/citestcycle')) events.push(...payload.events)
    })
    fs.writeFileSync(path.join(cwd, 'transformer.cjs'), `
      const fs = require('node:fs')
      exports.createTransformer = options => {
        const transformer = require('ts-jest').default.createTransformer(options)
        const process = transformer.process
        transformer.process = function (source, filename, options) {
          fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(filename) + '\\n')
          return process.call(this, source, filename, options)
        }
        return transformer
      }
    `)
  })

  after(async () => {
    await receiver?.stop()
  })

  function writeFixture () {
    fs.mkdirSync(checkout, { recursive: true })
    fs.writeFileSync(path.join(checkout, 'jest.config.json'), JSON.stringify({
      rootDir: checkout,
      cacheDirectory: cache,
      testEnvironment: 'node',
      testMatch: ['**/*.test.ts'],
      transform: {
        '^.+\\.ts$': [path.join(cwd, 'transformer.cjs'), {
          tsconfig: { target: 'ES2020', module: 'CommonJS', types: ['jest', 'node'], skipLibCheck: true },
        }],
      },
    }))
    fs.writeFileSync(path.join(checkout, 'enum.ts'), 'export const enum Mode { Value = 1 }\n')
    fs.writeFileSync(path.join(checkout, 'consumer.ts'),
      "import { Mode } from './enum'\nexport const value = Mode.Value\n")
    fs.writeFileSync(path.join(checkout, 'consumer.test.ts'), `
      import { value } from './consumer'
      test('uses the current dependency', () => expect(value).toBe(Number(process.env.EXPECTED_VALUE)))
    `)
    fs.writeFileSync(path.join(checkout, 'unrelated.ts'), 'export const value = 99\n')
    fs.writeFileSync(path.join(checkout, 'unrelated.test.ts'), `
      import { value } from './unrelated'
      test('unrelated module is unchanged', () => expect(value).toBe(99))
    `)
  }

  function snapshot () {
    const entries = {}
    if (!fs.existsSync(cache)) return entries
    for (const folder of fs.readdirSync(cache)) {
      if (!folder.startsWith('jest-transform-cache-')) continue
      const root = path.join(cache, folder)
      // Traverse explicitly to remain compatible with Node.js 18.
      for (const bucket of fs.readdirSync(root)) {
        for (const name of fs.readdirSync(path.join(root, bucket))) {
          const filename = path.join(root, bucket, name)
          entries[path.relative(cache, filename)] = {
            mtime: fs.statSync(filename).mtimeMs,
            digest: createHash('sha256').update(fs.readFileSync(filename)).digest('hex'),
          }
        }
      }
    }
    return entries
  }

  async function run (expectedCompiles, expectedValue = 1, parallel = false) {
    const configFile = path.join(checkout, 'jest.config.json')
    const before = snapshot()
    const eventStart = events.length
    fs.writeFileSync(log, '')
    const args = [path.join(cwd, 'node_modules/jest/bin/jest.js'), '--config', configFile, '--ci', '--watchman=false']
    args.push(...(parallel ? ['--maxWorkers=2', '--workerIdleMemoryLimit=512MB'] : ['--runInBand']))
    await execFileAsync(process.execPath, args, {
      cwd,
      env: {
        ...getCiVisAgentlessConfig(receiver.port),
        DD_CIVISIBILITY_GIT_UPLOAD_ENABLED: 'false',
        DD_REMOTE_CONFIGURATION_ENABLED: 'false',
        EXPECTED_VALUE: String(expectedValue),
      },
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    })
    const compiled = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
      .map(line => path.basename(JSON.parse(line))).sort()
    assert.deepStrictEqual(compiled, [...expectedCompiles].sort())
    if (!expectedCompiles.length) assert.deepStrictEqual(snapshot(), before)
    const current = events.slice(eventStart)
    const expectedEvents = { test: 2, test_suite_end: 2, test_module_end: 1, test_session_end: 1 }
    for (const [type, count] of Object.entries(expectedEvents)) {
      const matches = current.filter(event => event.type === type)
      assert.strictEqual(matches.length, count, type)
      assert(matches.every(event => event.content.meta['test.status'] === 'pass'))
    }
    const session = current.find(event => event.type === 'test_session_end').content.test_session_id.toString()
    assert(!sessions.has(session))
    sessions.add(session)
  }

  it('reuses restored transforms across timestamps and recompiles changed dependencies', async () => {
    writeFixture()
    await run(['consumer.test.ts', 'consumer.ts', 'unrelated.test.ts', 'unrelated.ts'])
    await run([])
    const archive = path.join(cwd, 'archive')
    fs.cpSync(cache, archive, { recursive: true, preserveTimestamps: true })
    fs.rmSync(checkout, { recursive: true })
    fs.rmSync(cache, { recursive: true })
    writeFixture()
    for (const name of fs.readdirSync(checkout)) {
      fs.utimesSync(path.join(checkout, name), new Date(0), new Date(0))
    }
    fs.cpSync(archive, cache, { recursive: true, preserveTimestamps: true })
    await run([])
    const filename = path.join(checkout, 'enum.ts')
    const { atime, mtime } = fs.statSync(filename)
    fs.writeFileSync(filename, 'export const enum Mode { Value = 2 }\n')
    fs.utimesSync(filename, atime, mtime)
    await run(['consumer.test.ts', 'consumer.ts'], 2)
    await run([], 2)
    await run([], 2, true)

    const configFile = path.join(checkout, 'jest.config.json')
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'))
    config.transform['^.+\\.ts$'][1].tsconfig.target = 'ES2019'
    fs.writeFileSync(configFile, JSON.stringify(config))
    await run(['consumer.test.ts', 'consumer.ts', 'unrelated.test.ts', 'unrelated.ts'], 2)

    // Adjacent uninspected versions must retain native behavior. Without the
    // normalization, distinct tracer sessions still produce different keys.
    const packageFile = path.join(cwd, 'node_modules/ts-jest/package.json')
    const manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8'))
    manifest.version = '29.4.6'
    fs.writeFileSync(packageFile, JSON.stringify(manifest))
    await run(['consumer.test.ts', 'consumer.ts', 'unrelated.test.ts', 'unrelated.ts'], 2)
    await run(['consumer.test.ts', 'consumer.ts', 'unrelated.test.ts', 'unrelated.ts'], 2)
  })
})
