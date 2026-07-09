'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { runSetupCommands } = require('../../../../ci/test-optimization-validation/setup-runner')

describe('test optimization validation setup runner', () => {
  it('stops validation when a required setup command fails', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-setup-'))
    const framework = {
      id: 'playwright:package',
      setup: {
        commands: [
          {
            id: 'build',
            description: 'Build package before Playwright tests',
            cwd: out,
            argv: [
              process.execPath,
              '-e',
              'process.stderr.write("missing build artifact\\n"); process.exit(2)',
            ],
            required: true,
          },
        ],
      },
    }

    const setup = await runSetupCommands({
      framework,
      out,
      options: { verbose: false },
    })

    assert.strictEqual(setup.ok, false)
    assert.strictEqual(setup.failure.status, 'fail')
    assert.match(setup.failure.diagnosis, /Required setup command failed/)
    assert.strictEqual(setup.failure.evidence.setupCommand.exitCode, 2)
    assert.match(setup.failure.evidence.setupCommand.stderrSummary, /missing build artifact/)
    assert.ok(setup.artifacts.some(artifact => path.basename(artifact) === 'command.json'))
    assert.ok(setup.failure.artifacts.some(artifact => path.basename(artifact) === 'command.json'))

    fs.rmSync(out, { recursive: true, force: true })
  })

  it('runs setup commands without ambient instrumentation env', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-setup-'))
    const originalNodeOptions = process.env.NODE_OPTIONS
    const originalOtelTracesExporter = process.env.OTEL_TRACES_EXPORTER
    process.env.NODE_OPTIONS = '--no-warnings'
    process.env.OTEL_TRACES_EXPORTER = 'otlp'

    try {
      const framework = {
        id: 'vitest:package',
        setup: {
          commands: [
            {
              id: 'build',
              cwd: out,
              argv: [
                process.execPath,
                '-e',
                [
                  'assert = require("node:assert/strict")',
                  'assert.strictEqual(process.env.NODE_OPTIONS, undefined)',
                  'assert.strictEqual(process.env.OTEL_TRACES_EXPORTER, undefined)',
                  'assert.strictEqual(process.env.PROJECT_SETUP_ENV, "present")',
                ].join(';'),
              ],
              env: {
                PROJECT_SETUP_ENV: 'present',
              },
              required: true,
            },
          ],
        },
      }

      const setup = await runSetupCommands({
        framework,
        out,
        options: { verbose: false },
      })

      assert.strictEqual(setup.ok, true)
    } finally {
      if (originalNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS
      } else {
        process.env.NODE_OPTIONS = originalNodeOptions
      }

      if (originalOtelTracesExporter === undefined) {
        delete process.env.OTEL_TRACES_EXPORTER
      } else {
        process.env.OTEL_TRACES_EXPORTER = originalOtelTracesExporter
      }

      fs.rmSync(out, { recursive: true, force: true })
    }
  })
})
