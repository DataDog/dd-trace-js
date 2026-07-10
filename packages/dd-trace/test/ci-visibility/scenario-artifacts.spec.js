'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  runInstrumentedCommand,
} = require('../../../../ci/test-optimization-validation/scenarios/helpers')

const PROBE_FILE_ENV = 'DD_TEST_OPTIMIZATION_INIT_PROBE_FILE'
const PROBE_PRELOAD = path.resolve(__dirname, '../../../../ci/test-optimization-validation/init-probe-preload.js')

describe('test optimization validation scenario artifacts', () => {
  it('redacts secret-like event data in direct-initialization events artifacts', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-scenario-artifacts-'))
    const intake = {
      port: 8126,
      requests: [
        testIntakeRequest({
          API_KEY: 'direct-event-api-key-secret',
          command: 'TOKEN=direct-event-token-secret npm test',
          message: 'SECRET=direct-event-secret',
        }),
      ],
      resetRequests () {},
    }

    try {
      await runInstrumentedCommand({
        framework: {
          id: 'jest:root',
          framework: 'jest',
        },
        intake,
        out,
        scenarioName: 'basic-reporting',
        command: {
          cwd: out,
          argv: [process.execPath, '-e', 'console.log("1 passing")'],
          timeoutMs: 10_000,
        },
        options: { verbose: false },
      })

      const events = fs.readFileSync(path.join(out, 'runs', 'jest-root', 'basic-reporting', 'events.ndjson'), 'utf8')
      assert.match(events, /<redacted>/)
      for (const secret of [
        'direct-event-api-key-secret',
        'direct-event-token-secret',
        'direct-event-secret',
      ]) {
        assert.doesNotMatch(events, new RegExp(secret))
      }
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('redacts secret-like argv and execArgv values in initialization probe records', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-init-probe-'))
    const recordsPath = path.join(tmpDir, 'records.ndjson')

    fs.writeFileSync(recordsPath, '')

    try {
      execFileSync(process.execPath, [
        '-r',
        PROBE_PRELOAD,
        '-e',
        '"TOKEN=probe-exec-secret";',
        'API_KEY=probe-argv-secret',
      ], {
        cwd: tmpDir,
        env: {
          ...process.env,
          [PROBE_FILE_ENV]: recordsPath,
          NODE_OPTIONS: '',
        },
      })

      const records = fs.readFileSync(recordsPath, 'utf8')
      assert.match(records, /API_KEY=<redacted>/)
      assert.match(records, /TOKEN=<redacted>/)
      assert.doesNotMatch(records, /probe-argv-secret/)
      assert.doesNotMatch(records, /probe-exec-secret/)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('detects Playwright CLI paths in initialization probe records', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-init-probe-'))
    const recordsPath = path.join(tmpDir, 'records.ndjson')
    const playwrightCli = path.join(tmpDir, 'node_modules', 'playwright', 'cli.js')

    fs.mkdirSync(path.dirname(playwrightCli), { recursive: true })
    fs.writeFileSync(playwrightCli, 'process.exit(0)\n')
    fs.writeFileSync(recordsPath, '')

    try {
      execFileSync(process.execPath, [
        '-r',
        PROBE_PRELOAD,
        playwrightCli,
      ], {
        cwd: tmpDir,
        env: {
          ...process.env,
          [PROBE_FILE_ENV]: recordsPath,
          NODE_OPTIONS: '',
        },
      })

      const records = fs.readFileSync(recordsPath, 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line))
      const processStart = records.find(record => record.type === 'process-start')

      assert.deepStrictEqual(processStart.detectedTools, [
        { name: 'playwright', kind: 'test-runner' },
      ])
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

function testIntakeRequest (meta) {
  return {
    method: 'POST',
    url: '/api/v2/citestcycle',
    payload: {
      events: [
        {
          type: 'test',
          content: {
            name: 'example test',
            meta: {
              'test.name': 'example test',
              'test.status': 'pass',
              ...meta,
            },
            metrics: {},
          },
        },
      ],
    },
  }
}
