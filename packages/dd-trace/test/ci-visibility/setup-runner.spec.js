'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  cleanupDeferredCommandOutputs,
} = require('../../../../ci/test-optimization-validation/command-output-policy')
const { runCommand } = require('../../../../ci/test-optimization-validation/command-runner')
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
    assert.strictEqual(setup.failure.status, 'blocked')
    assert.match(setup.failure.diagnosis, /blocked by required project setup/)
    assert.match(setup.failure.diagnosis, /No Test Optimization conclusion was reached/)
    assert.strictEqual(setup.failure.evidence.blockedByProjectSetup, true)
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

  it('omits missing artifacts when setup fails before command execution', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-setup-'))
    const framework = {
      id: 'jest:package',
      setup: {
        commands: [{
          id: 'missing-runner',
          cwd: out,
          argv: ['definitely-missing-dd-validation-runner'],
          required: true,
        }],
      },
    }

    try {
      const setup = await runSetupCommands({
        framework,
        out,
        options: { verbose: false },
      })

      assert.strictEqual(setup.ok, false)
      assert.deepStrictEqual(setup.artifacts, [])
      assert.deepStrictEqual(setup.failure.artifacts, [])
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  for (const exitCode of [0, 2]) {
    it(`keeps declared setup outputs until validation-wide cleanup after exit ${exitCode}`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-setup-'))
      const out = path.join(root, 'results')
      const outputPath = path.join(root, 'dist')
      const framework = {
        id: 'vitest:package',
        setup: {
          commands: [{
            id: 'build',
            cwd: root,
            argv: [
              process.execPath,
              '-e',
              `require('node:fs').mkdirSync(${JSON.stringify(outputPath)}); process.exit(${exitCode})`,
            ],
            outputPaths: [outputPath],
            required: true,
          }],
        },
      }

      try {
        fs.mkdirSync(out)
        const setup = await runSetupCommands({
          framework,
          out,
          options: { repositoryRoot: root, verbose: false },
        })

        assert.strictEqual(setup.ok, exitCode === 0)
        assert.strictEqual(fs.existsSync(outputPath), true)
        assert.strictEqual(setup.outputCleanupHandles.length, 1)
        cleanupDeferredCommandOutputs(setup.outputCleanupHandles[0])
        assert.strictEqual(fs.existsSync(outputPath), false)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  }

  it('keeps a setup artifact available to Basic Reporting and generated-scenario consumers', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-setup-consumer-'))
    const out = path.join(root, 'results')
    const outputPath = path.join(root, 'dist')
    const inputPath = path.join(outputPath, 'entry.js')
    const framework = {
      id: 'vitest:package',
      setup: {
        commands: [{
          id: 'build',
          cwd: root,
          argv: [
            process.execPath,
            '-e',
            `require('node:fs').mkdirSync(${JSON.stringify(outputPath)}); ` +
              `require('node:fs').writeFileSync(${JSON.stringify(inputPath)}, 'built')`,
          ],
          outputPaths: [outputPath],
          required: true,
        }],
      },
    }

    try {
      fs.mkdirSync(out)
      const setup = await runSetupCommands({
        framework,
        out,
        options: { repositoryRoot: root, verbose: false },
      })
      const consumer = exitCode => runCommand({
        cwd: root,
        argv: [
          process.execPath,
          '-e',
          `if (require('node:fs').readFileSync(${JSON.stringify(inputPath)}, 'utf8') !== 'built') process.exit(3); ` +
            `process.exit(${exitCode})`,
        ],
      }, {
        outDir: path.join(out, `consumer-${exitCode}`),
        repositoryRoot: root,
        role: 'test',
        verbose: false,
      })

      assert.strictEqual(setup.ok, true)
      assert.strictEqual((await consumer(0)).exitCode, 0)
      assert.strictEqual((await consumer(2)).exitCode, 2)
      assert.strictEqual(fs.existsSync(inputPath), true)

      cleanupDeferredCommandOutputs(setup.outputCleanupHandles[0])
      assert.strictEqual(fs.existsSync(outputPath), false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('cleans earlier setup outputs when a later setup command throws', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-test-optimization-setup-throw-'))
    const out = path.join(root, 'results')
    const createdOutput = path.join(root, 'dist')
    const preExistingOutput = path.join(root, 'existing')
    const framework = {
      id: 'vitest:package',
      setup: {
        commands: [
          {
            id: 'build',
            cwd: root,
            argv: [
              process.execPath,
              '-e',
              `require('node:fs').mkdirSync(${JSON.stringify(createdOutput)})`,
            ],
            outputPaths: [createdOutput],
          },
          {
            id: 'unsafe-output',
            cwd: root,
            argv: [process.execPath, '-e', 'throw new Error("must not run")'],
            outputPaths: [preExistingOutput],
          },
        ],
      },
    }

    fs.mkdirSync(out)
    fs.mkdirSync(preExistingOutput)
    try {
      await assert.rejects(runSetupCommands({
        framework,
        out,
        options: { repositoryRoot: root, verbose: false },
      }), /already exists and will not be moved or overwritten/)
      assert.strictEqual(fs.existsSync(createdOutput), false)
      assert.strictEqual(fs.existsSync(preExistingOutput), true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
