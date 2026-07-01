'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const executionEnvironment = require('../../../../ci/test-optimization-validation/execution-environment')
const { writeReport } = require('../../../../ci/test-optimization-validation/report-writer')

const { buildExecutionEnvironmentBlockerResult } = executionEnvironment

describe('test optimization validation report writer', () => {
  it('prints rerun remediation and preserves execution-environment blockers in report payloads', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-validation-report-'))
    const out = path.join(tmpDir, 'results')
    const manifestPath = path.join(tmpDir, 'dd-test-optimization-validation-manifest.json')
    const packageJsonPath = path.join(tmpDir, 'package.json')
    const staticDiagnosisPath = path.join(out, 'static-diagnosis.json')
    const error = Object.assign(new Error('listen EPERM: operation not permitted 127.0.0.1'), {
      address: '127.0.0.1',
      code: 'EPERM',
      syscall: 'listen',
    })
    const results = [
      buildExecutionEnvironmentBlockerResult({
        framework: { id: 'jest:root' },
        error,
        rerunCommand: 'node /repo/node_modules/dd-trace/ci/validate-test-optimization.js --manifest manifest.json',
      }),
    ]
    const manifest = {
      __path: manifestPath,
      repository: {
        root: tmpDir,
      },
      frameworks: [
        {
          id: 'jest:root',
          framework: 'jest',
          frameworkVersion: '30.1.3',
          project: {
            name: 'example',
            root: tmpDir,
            packageJson: packageJsonPath,
          },
        },
      ],
    }
    const intake = {
      requests: [],
      writeArtifacts () {
        const intakeDir = path.join(out, 'intake')
        fs.mkdirSync(intakeDir, { recursive: true })
        const requestsPath = path.join(intakeDir, 'requests.ndjson')
        fs.writeFileSync(requestsPath, '')
        return { requestsPath }
      },
    }
    const originalLog = console.log
    const logs = []

    fs.mkdirSync(out, { recursive: true })
    fs.writeFileSync(packageJsonPath, `${JSON.stringify({ name: 'example' }, null, 2)}\n`)
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    fs.writeFileSync(staticDiagnosisPath, '{}\n')
    console.log = message => logs.push(message)

    try {
      writeReport({
        manifest,
        results,
        out,
        intake,
        staticDiagnosis: {
          reportPath: staticDiagnosisPath,
        },
      })

      const summary = logs.join('\n')
      assert.match(summary, /BLOCKED jest:root/)
      assert.match(summary, /not evidence that Test Optimization is misconfigured/)
      assert.match(summary, /manifest and generated artifacts may still be useful/)
      assert.match(summary, /Rerun the validator outside the restricted sandbox/)
      assert.match(summary, /Rerun the validator command shown below from the host shell/)
      assert.match(summary, /Rerun in CI/)
      assert.match(summary, /Command: node \/repo\/node_modules\/dd-trace\/ci\/validate-test-optimization\.js/)

      const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'))
      assert.strictEqual(report.results[0].status, 'blocked')
      assert.strictEqual(report.results[0].evidence.blockedByExecutionEnvironment, true)
      assert.strictEqual(report.results[0].evidence.manifestMayBeReused, true)
      assert.deepStrictEqual(report.results[0].evidence.remediation, [
        'Rerun the validator command shown below from the host shell',
        'In Codex, approve running that single validator command outside the sandbox',
        'Rerun in CI',
      ])

      const validationPayloads = JSON.parse(fs.readFileSync(path.join(out, 'validation-payloads.json'), 'utf8'))
      const check = validationPayloads[0].payload.checks[0]
      assert.strictEqual(validationPayloads[0].payload.status, 'unknown')
      assert.strictEqual(check.id, 'execution-environment')
      assert.strictEqual(check.status, 'unknown')
      assert.notStrictEqual(check.id, 'basic-reporting')
    } finally {
      console.log = originalLog
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
