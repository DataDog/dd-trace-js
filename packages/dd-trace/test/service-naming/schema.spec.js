'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')

require('../setup/core')
const SchemaDefinition = require('../../src/service-naming/schemas/definition')
const v0 = require('../../src/service-naming/schemas/v0')
const v1 = require('../../src/service-naming/schemas/v1')

describe('Service naming', () => {
  let singleton

  describe('Version selection', () => {
    beforeEach(() => {
      singleton = require('../../src/service-naming')
    })

    afterEach(() => {
      delete require.cache[require.resolve('../../src/service-naming')]
    })

    it('Should default to v0 when required', () => {
      assert.strictEqual(singleton.version, 'v0')
    })

    it('Should grab the version given by `spanAttributeSchema`', () => {
      singleton.configure({ spanAttributeSchema: 'MyShinyNewVersion' })
      assert.strictEqual(singleton.version, 'MyShinyNewVersion')
    })

    describe('Name resolution proxy', () => {
      let singleton
      let versions
      const extra = { my: { extra: 'args' } }

      beforeEach(() => {
        versions = { v0: { getOpName: sinon.spy(), getServiceName: sinon.spy() } }
        singleton = require('../../src/service-naming')
        singleton.configure({ spanAttributeSchema: 'v0', service: 'test-service' })
        singleton.schemas = versions
      })

      it('should forward additional args to opName', () => {
        singleton.opName('messaging', 'producer', 'redis', extra)
        sinon.assert.calledWith(versions.v0.getOpName, 'messaging', 'producer', 'redis', extra)
      })

      it('should forward additional args to serviceName and add configured service', () => {
        singleton.serviceName('messaging', 'producer', 'redis', extra)
        sinon.assert.calledWith(versions.v0.getServiceName,
          'messaging',
          'producer',
          'redis',
          {
            tracerService: 'test-service',
            ...extra,
          }
        )
      })
    })
  })

  describe('Naming schema definition', () => {
    const dummySchema = {
      messaging: {
        inbound: {
          kafka: {
            opName: sinon.spy(),
            serviceName: sinon.stub().returns('kafka-service'),
            serviceSource: sinon.stub().returns('kafka'),
          },
        },
      },
    }

    const resolver = new SchemaDefinition(dummySchema)
    const extra = { my: { extra: 'args' } }

    describe('Operation name getter', () => {
      it('should passthrough operation name arguments', () => {
        resolver.getOpName('messaging', 'inbound', 'kafka', extra)
        sinon.assert.calledWith(dummySchema.messaging.inbound.kafka.opName, extra)
      })
    })

    describe('Service name getter', () => {
      it('should add service name and passthrough service name arguments', () => {
        const opts = { tracerService: 'test-service', ...extra }
        const result = resolver.getServiceName('messaging', 'inbound', 'kafka', opts)
        sinon.assert.calledWith(dummySchema.messaging.inbound.kafka.serviceName, opts)
        sinon.assert.calledWith(dummySchema.messaging.inbound.kafka.serviceSource, opts)
        assert.deepStrictEqual(result, { name: 'kafka-service', source: 'kafka' })
      })
    })
  })

  describe('AWS service resolution', () => {
    const awsName = (schema, pluginConfig, params) =>
      schema.getServiceName('web', 'client', 'aws', {
        tracerService: 'test',
        awsService: 's3',
        pluginConfig,
        params,
      })

    describe('v0', () => {
      it('appends the aws service to the default name', () => {
        assert.deepStrictEqual(awsName(v0, {}, {}), { name: 'test-aws-s3', source: 's3' })
      })

      it('lets a string service override every span', () => {
        assert.deepStrictEqual(awsName(v0, { service: 'custom' }, {}), { name: 'custom', source: 'opt.plugin' })
      })

      it('derives the name from a function service', () => {
        const service = params => (params.Bucket ? `s3-${params.Bucket}` : undefined)
        assert.deepStrictEqual(
          awsName(v0, { service }, { Bucket: 'b' }),
          { name: 's3-b', source: 'opt.plugin' }
        )
      })

      it('falls back to the default name on a nullish or non-string function result', () => {
        const nullish = awsName(v0, { service: () => undefined }, {})
        const nonString = awsName(v0, { service: () => 42 }, {})
        assert.strictEqual(nullish.name, 'test-aws-s3')
        assert.strictEqual(nonString.name, 'test-aws-s3')
      })
    })

    describe('v1', () => {
      it('uses the tracer service as the default name', () => {
        assert.deepStrictEqual(awsName(v1, {}, {}), { name: 'test', source: undefined })
      })

      it('lets a string service override every span', () => {
        assert.deepStrictEqual(awsName(v1, { service: 'custom' }, {}), { name: 'custom', source: 'opt.plugin' })
      })

      it('derives the name from a function service', () => {
        const service = params => (params.Bucket ? `s3-${params.Bucket}` : undefined)
        assert.deepStrictEqual(
          awsName(v1, { service }, { Bucket: 'b' }),
          { name: 's3-b', source: 'opt.plugin' }
        )
      })

      it('falls back to the tracer service on a nullish or non-string function result', () => {
        const nullish = awsName(v1, { service: () => undefined }, {})
        const nonString = awsName(v1, { service: () => 42 }, {})
        assert.strictEqual(nullish.name, 'test')
        assert.strictEqual(nonString.name, 'test')
      })
    })
  })
})
