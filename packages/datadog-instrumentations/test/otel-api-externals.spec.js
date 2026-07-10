'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { describe, it, beforeEach, afterEach } = require('mocha')

const { otelApiPackagesToExternalize } = require('../src/helpers/otel-api-externals')

const OTEL_API_PACKAGES = ['@opentelemetry/api', '@opentelemetry/api-logs']

describe('otel-api-externals', () => {
  let workingDirectory

  beforeEach(() => {
    workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-otel-externals-'))
  })

  afterEach(() => {
    fs.rmSync(workingDirectory, { recursive: true, force: true })
  })

  /**
   * @param {Record<string, string | Record<string, string>>} manifest
   * @returns {void}
   */
  function writeManifest (manifest) {
    fs.writeFileSync(path.join(workingDirectory, 'package.json'), JSON.stringify(manifest))
  }

  it('externalizes only the packages the application declares', () => {
    writeManifest({ name: 'app', dependencies: { '@opentelemetry/api': '^1.9.0' } })

    assert.deepStrictEqual(otelApiPackagesToExternalize(workingDirectory), ['@opentelemetry/api'])
  })

  it('bundles every package the application does not declare', () => {
    writeManifest({ name: 'app', dependencies: { express: '^4.0.0' } })

    assert.deepStrictEqual(otelApiPackagesToExternalize(workingDirectory), [])
  })

  for (const dependencyField of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    it(`detects packages in ${dependencyField}`, () => {
      writeManifest({
        name: 'app',
        [dependencyField]: { '@opentelemetry/api': '^1.9.0' },
      })

      assert.deepStrictEqual(otelApiPackagesToExternalize(workingDirectory), ['@opentelemetry/api'])
    })
  }

  it('errs toward external when the manifest cannot be read', () => {
    // No package.json written: sharing the application copy is the correctness-preserving default.
    assert.deepStrictEqual(otelApiPackagesToExternalize(workingDirectory), OTEL_API_PACKAGES)
  })

  it('errs toward external when the manifest is malformed', () => {
    fs.writeFileSync(path.join(workingDirectory, 'package.json'), '{')

    assert.deepStrictEqual(otelApiPackagesToExternalize(workingDirectory), OTEL_API_PACKAGES)
  })
})
