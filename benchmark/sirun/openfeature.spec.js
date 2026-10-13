'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { devNull, tmpdir } = require('node:os')
const path = require('node:path')

const { describe, it } = require('mocha')

describe('OpenFeature benchmark output', function () {
  this.timeout(60000)

  for (const consent of [false, true]) {
    for (const sirun of [false, true]) {
      it(`separates ${consent ? 'full' : 'protected'} diagnostics from ${sirun ? 'Sirun' : 'standalone'} output`,
        () => {
          const env = {
            ...process.env,
            CONSENT: String(consent),
            VARIANT: 'typical',
            OPERATIONS: '100',
            WARMUP: '0',
            STARTUP_GUARD_REPORT: devNull,
          }
          delete env.SIRUN_READY_FD
          delete env.SIRUN_VARIANT
          delete env.DD_BENCH_SOURCE_ROOT
          delete env.DD_BENCH_PROVIDER_MODULE
          delete env.SATURATED
          if (sirun) env.SIRUN_VARIANT = consent ? 'typical-full' : 'typical'

          const result = spawnSync(process.execPath, ['index.js'], {
            cwd: path.join(__dirname, 'openfeature'),
            env,
            encoding: 'utf8',
            timeout: 45000,
          })
          assert.strictEqual(result.status, 0, result.stderr)

          if (sirun) {
            // Sirun inherits benchmark stdout and appends its own measurement record.
            const measurement = {
              name: 'openfeature',
              variant: env.SIRUN_VARIANT,
              iterations: [{ instructions: 42, 'system.time': 1 }],
            }
            const directory = mkdtempSync(path.join(tmpdir(), 'openfeature-sirun-output-'))
            try {
              copyFileSync(path.join(__dirname, 'strip-unwanted-results.js'),
                path.join(directory, 'strip-unwanted-results.js'))
              writeFileSync(path.join(directory, 'results.ndjson'),
                result.stdout + JSON.stringify(measurement) + '\n')
              const processed = spawnSync(process.execPath, ['strip-unwanted-results.js'], {
                cwd: directory,
                encoding: 'utf8',
              })
              assert.strictEqual(processed.status, 0, processed.stderr)
              assert.deepStrictEqual(JSON.parse(readFileSync(path.join(directory, 'results.ndjson'), 'utf8')), {
                name: 'openfeature',
                variant: env.SIRUN_VARIANT,
                iterations: [{ instructions: 42 }],
              })
            } finally {
              rmSync(directory, { recursive: true, force: true })
            }
            assert.strictEqual(result.stdout, '')
          }

          const output = sirun ? result.stderr : result.stdout
          const summaries = output.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
          assert.strictEqual(summaries.length, 1)
          const summary = summaries[0]
          assert.strictEqual(summary.consent, consent)
          assert.strictEqual(summary.evaluationConsentMetadata, consent)
          assert.strictEqual(summary.measuredCollected, 100)
          assert.strictEqual(summary.delivery, 'worker')
          assert.deepStrictEqual(summary.dropped, {})
        })
    }
  }
})
