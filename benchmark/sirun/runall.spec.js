'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')

const { describe, it } = require('mocha')

describe('Sirun variant failure diagnostics', () => {
  // Exercise the real shell function without installing dependencies or running the full benchmark matrix.
  const source = readFileSync(path.join(__dirname, 'runall.sh'), 'utf8')
  const runVariant = source.match(/^function run_variant \{[\s\S]+?^\}/m)[0]

  for (const candidatePassed of [false, true]) {
    it(`prints the underlying error when the baseline failure is ${candidatePassed ? 'skipped' : 'fatal'}`, () => {
      const directory = mkdtempSync(path.join(tmpdir(), 'sirun-failure-'))
      try {
        mkdirSync(path.join(directory, 'fixture'))
        // Stand in for the external measurement tool, preserving its stdout/stderr/exit-code contract.
        writeFileSync(path.join(directory, 'run-one-variant.js'), `
          process.stdout.write(JSON.stringify({ name: 'fixture', iterations: [] }) + '\\n')
          process.stderr.write('Underlying benchmark failure: diagnostic canary\\n')
          process.exitCode = 1
        `)
        const files = {
          CANDIDATE_PASSED_FILE: path.join(directory, 'candidate-passed'),
          SKIPPED_FILE: path.join(directory, 'skipped'),
          FAILURES_FILE: path.join(directory, 'failures'),
        }
        for (const file of Object.values(files)) writeFileSync(file, '')
        if (candidatePassed) writeFileSync(files.CANDIDATE_PASSED_FILE, 'fixture/default\n')

        const result = spawnSync('bash', ['-c', `${runVariant}\nrun_variant fixture default 1 0 test`], {
          cwd: directory,
          env: {
            ...process.env,
            ...files,
            SKIP_BASELINE_FAILURES: '1',
            RECORD_CANDIDATE_PASS: '',
          },
          encoding: 'utf8',
          timeout: 10000,
        })
        assert.strictEqual(result.status, 0, result.stderr)
        assert.match(result.stderr, /Underlying benchmark failure: diagnostic canary/)
        assert.ok(!result.stdout.includes('diagnostic canary'))
        // Logging must not change failure classification or corrupt the measurement stream.
        assert.strictEqual(readFileSync(files.SKIPPED_FILE, 'utf8'), candidatePassed ? 'fixture/default\n' : '')
        assert.strictEqual(readFileSync(files.FAILURES_FILE, 'utf8'), candidatePassed ? '' : 'fixture/default\n')
        assert.deepStrictEqual(JSON.parse(readFileSync(path.join(directory, 'results.ndjson'), 'utf8')), {
          name: 'fixture',
          iterations: [],
        })
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    })
  }
})
