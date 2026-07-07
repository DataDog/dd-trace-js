'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { describe, it, beforeEach } = require('mocha')

const { OTEL_API_PACKAGES, otelApiPackagesToExternalize } = require('../src/helpers/otel-api-externals')

describe('otel-api-externals', () => {
  let workingDir

  beforeEach(() => {
    workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-otel-externals-'))
  })

  /**
   * @param {object} manifest
   */
  function writeManifest (manifest) {
    fs.writeFileSync(path.join(workingDir, 'package.json'), JSON.stringify(manifest))
  }

  it('externalizes only the packages the application declares', () => {
    writeManifest({ name: 'app', dependencies: { '@opentelemetry/api': '^1.9.0' } })

    assert.deepStrictEqual(otelApiPackagesToExternalize(workingDir), ['@opentelemetry/api'])
  })

  it('bundles every package the application does not declare', () => {
    writeManifest({ name: 'app', dependencies: { express: '^4.0.0' } })

    assert.deepStrictEqual(otelApiPackagesToExternalize(workingDir), [])
  })

  it('detects the packages across every dependency field', () => {
    writeManifest({
      name: 'app',
      devDependencies: { '@opentelemetry/api': '^1.9.0' },
      peerDependencies: { '@opentelemetry/api-logs': '<1.0.0' },
    })

    assert.deepStrictEqual(otelApiPackagesToExternalize(workingDir), OTEL_API_PACKAGES)
  })

  it('errs toward external when the manifest cannot be read', () => {
    // No package.json written: sharing the application copy is the correctness-preserving default.
    assert.deepStrictEqual(otelApiPackagesToExternalize(workingDir), OTEL_API_PACKAGES)
  })
})
