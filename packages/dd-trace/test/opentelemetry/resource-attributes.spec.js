'use strict'

const assert = require('node:assert/strict')
const os = require('node:os')

const { describe, it, afterEach } = require('mocha')
const sinon = require('sinon')

const buildResourceAttributes = require('../../src/opentelemetry/resource-attributes')

describe('OpenTelemetry resource attributes', () => {
  afterEach(() => sinon.restore())

  it('uses tracer identity fields and preserves remaining tags', () => {
    const resourceAttributes = buildResourceAttributes({
      service: 'service',
      version: '1.0.0',
      env: 'prod',
      tags: {
        service: 'tag-service',
        version: 'tag-version',
        env: 'tag-env',
        'runtime-id': 'runtime-id',
      },
    })

    assert.deepStrictEqual(resourceAttributes, {
      'service.name': 'service',
      'service.version': '1.0.0',
      'deployment.environment': 'prod',
      'runtime-id': 'runtime-id',
    })
  })

  it('adds the hostname when enabled', () => {
    sinon.stub(os, 'hostname').returns('test-host')

    const resourceAttributes = buildResourceAttributes({
      service: 'service',
      version: '1.0.0',
      env: 'prod',
      tags: {},
      reportHostname: true,
    })

    assert.strictEqual(resourceAttributes['host.name'], 'test-host')
  })
})
