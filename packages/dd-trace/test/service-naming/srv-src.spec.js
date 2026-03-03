'use strict'

const assert = require('node:assert/strict')

describe('_dd.srv_src tracking in v0 schema', () => {
  describe('storage schemas', () => {
    let storage

    beforeEach(() => {
      storage = require('../../src/service-naming/schemas/v0/storage')
    })

    describe('pg (withSuffixFunction)', () => {
      it('should set srvSrc to integration name when using default service', () => {
        const opts = { pluginConfig: {}, tracerService: 'myapp', params: {} }
        const result = storage.client.pg.serviceName(opts)

        assert.equal(result, 'myapp-postgres')
        assert.equal(opts.srvSrc, 'pg')
      })

      it('should set srvSrc to "m" when pluginConfig.service is set by user', () => {
        const opts = { pluginConfig: { service: 'custom-pg' }, tracerService: 'myapp', params: {} }
        const result = storage.client.pg.serviceName(opts)

        assert.equal(result, 'custom-pg')
        assert.equal(opts.srvSrc, 'm')
      })

      it('should set srvSrc to "opt.mapping" when service comes from serviceMapping', () => {
        const opts = {
          pluginConfig: { service: 'mapped-pg', serviceFromMapping: true },
          tracerService: 'myapp',
          params: {},
        }
        const result = storage.client.pg.serviceName(opts)

        assert.equal(result, 'mapped-pg')
        assert.equal(opts.srvSrc, 'opt.mapping')
      })

      it('should set srvSrc to "m" when pluginConfig.service is a function', () => {
        const opts = {
          pluginConfig: { service: () => 'fn-pg' },
          tracerService: 'myapp',
          params: {},
        }
        const result = storage.client.pg.serviceName(opts)

        assert.equal(result, 'fn-pg')
        assert.equal(opts.srvSrc, 'm')
      })
    })

    describe('aerospike', () => {
      it('should set srvSrc to "aerospike" when using default service', () => {
        const opts = { pluginConfig: {}, tracerService: 'myapp' }
        const result = storage.client.aerospike.serviceName(opts)

        assert.equal(result, 'myapp-aerospike')
        assert.equal(opts.srvSrc, 'aerospike')
      })

      it('should set srvSrc to "m" when pluginConfig.service is set', () => {
        const opts = { pluginConfig: { service: 'custom' }, tracerService: 'myapp' }
        const result = storage.client.aerospike.serviceName(opts)

        assert.equal(result, 'custom')
        assert.equal(opts.srvSrc, 'm')
      })

      it('should set srvSrc to "opt.mapping" when service comes from mapping', () => {
        const opts = {
          pluginConfig: { service: 'mapped', serviceFromMapping: true },
          tracerService: 'myapp',
        }
        const result = storage.client.aerospike.serviceName(opts)

        assert.equal(result, 'mapped')
        assert.equal(opts.srvSrc, 'opt.mapping')
      })
    })

    describe('redis (redisConfig)', () => {
      it('should set srvSrc to "redis" when using system default', () => {
        const opts = { pluginConfig: {}, tracerService: 'myapp', system: 'redis' }
        const result = storage.client.redis.serviceName(opts)

        assert.equal(result, 'myapp-redis')
        assert.equal(opts.srvSrc, 'redis')
      })

      it('should set srvSrc to "m" when pluginConfig.service is set', () => {
        const opts = { pluginConfig: { service: 'my-redis' }, tracerService: 'myapp', system: 'redis' }
        const result = storage.client.redis.serviceName(opts)

        assert.equal(result, 'my-redis')
        assert.equal(opts.srvSrc, 'm')
      })

      it('should set srvSrc to "redis" when splitByInstance with connectionName and no service', () => {
        const opts = {
          pluginConfig: { splitByInstance: true },
          tracerService: 'myapp',
          system: 'redis',
          connectionName: 'cache',
        }
        const result = storage.client.redis.serviceName(opts)

        assert.equal(result, 'cache')
        assert.equal(opts.srvSrc, 'redis')
      })

      it('should set srvSrc to "m" when splitByInstance with service', () => {
        const opts = {
          pluginConfig: { splitByInstance: true, service: 'custom' },
          tracerService: 'myapp',
          system: 'redis',
          connectionName: 'cache',
        }
        const result = storage.client.redis.serviceName(opts)

        assert.equal(result, 'custom-cache')
        assert.equal(opts.srvSrc, 'm')
      })
    })

    describe('mysql (mysqlServiceName)', () => {
      it('should set srvSrc to "mysql" when using system default', () => {
        const opts = { pluginConfig: {}, tracerService: 'myapp', system: 'mysql', dbConfig: {} }
        const result = storage.client.mysql.serviceName(opts)

        assert.equal(result, 'myapp-mysql')
        assert.equal(opts.srvSrc, 'mysql')
      })

      it('should set srvSrc to "m" when service is a function', () => {
        const opts = {
          pluginConfig: { service: () => 'fn-mysql' },
          tracerService: 'myapp',
          system: 'mysql',
          dbConfig: {},
        }
        const result = storage.client.mysql.serviceName(opts)

        assert.equal(result, 'fn-mysql')
        assert.equal(opts.srvSrc, 'm')
      })

      it('should set srvSrc to "opt.mapping" when from mapping', () => {
        const opts = {
          pluginConfig: { service: 'mapped-mysql', serviceFromMapping: true },
          tracerService: 'myapp',
          system: 'mysql',
          dbConfig: {},
        }
        const result = storage.client.mysql.serviceName(opts)

        assert.equal(result, 'mapped-mysql')
        assert.equal(opts.srvSrc, 'opt.mapping')
      })
    })

    describe('cassandra-driver (fromSystem)', () => {
      it('should set srvSrc to "cassandra-driver" when using system default', () => {
        const opts = { pluginConfig: {}, tracerService: 'myapp', system: 'cassandra' }
        const result = storage.client['cassandra-driver'].serviceName(opts)

        assert.equal(result, 'myapp-cassandra')
        assert.equal(opts.srvSrc, 'cassandra-driver')
      })
    })

    describe('elasticsearch', () => {
      it('should set srvSrc to "elasticsearch" when using default', () => {
        const opts = { pluginConfig: {}, tracerService: 'myapp' }
        const result = storage.client.elasticsearch.serviceName(opts)

        assert.equal(result, 'myapp-elasticsearch')
        assert.equal(opts.srvSrc, 'elasticsearch')
      })
    })

    describe('mongodb-core', () => {
      it('should set srvSrc to "mongodb-core" when using default', () => {
        const opts = { pluginConfig: {}, tracerService: 'myapp' }
        const result = storage.client['mongodb-core'].serviceName(opts)

        assert.equal(result, 'myapp-mongodb')
        assert.equal(opts.srvSrc, 'mongodb-core')
      })
    })

    describe('opensearch', () => {
      it('should set srvSrc to "opensearch" when using default', () => {
        const opts = { pluginConfig: {}, tracerService: 'myapp' }
        const result = storage.client.opensearch.serviceName(opts)

        assert.equal(result, 'myapp-opensearch')
        assert.equal(opts.srvSrc, 'opensearch')
      })
    })

    describe('couchbase', () => {
      it('should set srvSrc to "couchbase" when using default', () => {
        const opts = { pluginConfig: {}, tracerService: 'myapp' }
        const result = storage.client.couchbase.serviceName(opts)

        assert.equal(result, 'myapp-couchbase')
        assert.equal(opts.srvSrc, 'couchbase')
      })
    })

    describe('oracledb (withSuffixFunction)', () => {
      it('should set srvSrc to "oracledb" when using default', () => {
        const opts = { pluginConfig: {}, tracerService: 'myapp', params: {} }
        const result = storage.client.oracledb.serviceName(opts)

        assert.equal(result, 'myapp-oracle')
        assert.equal(opts.srvSrc, 'oracledb')
      })
    })

    describe('prisma (withSuffixFunction)', () => {
      it('should set srvSrc to "prisma" when using default', () => {
        const opts = { pluginConfig: {}, tracerService: 'myapp', params: {} }
        const result = storage.client.prisma.serviceName(opts)

        assert.equal(result, 'myapp-prisma')
        assert.equal(opts.srvSrc, 'prisma')
      })
    })

    describe('tedious (fromSystem)', () => {
      it('should set srvSrc to "tedious" when using system default', () => {
        const opts = { pluginConfig: {}, tracerService: 'myapp', system: 'mssql' }
        const result = storage.client.tedious.serviceName(opts)

        assert.equal(result, 'myapp-mssql')
        assert.equal(opts.srvSrc, 'tedious')
      })
    })

    describe('valkey (valkeyConfig)', () => {
      it('should set srvSrc to "valkey" when using system default', () => {
        const opts = { pluginConfig: {}, tracerService: 'myapp', system: 'valkey' }
        const result = storage.client.iovalkey.serviceName(opts)

        assert.equal(result, 'myapp-valkey')
        assert.equal(opts.srvSrc, 'valkey')
      })
    })
  })

  describe('messaging schemas', () => {
    let messaging

    beforeEach(() => {
      messaging = require('../../src/service-naming/schemas/v0/messaging')
    })

    it('should set srvSrc to "kafkajs" for kafka producer', () => {
      const opts = { tracerService: 'myapp' }
      const result = messaging.producer.kafkajs.serviceName(opts)

      assert.equal(result, 'myapp-kafka')
      assert.equal(opts.srvSrc, 'kafkajs')
    })

    it('should set srvSrc to "kafkajs" for kafka consumer', () => {
      const opts = { tracerService: 'myapp' }
      const result = messaging.consumer.kafkajs.serviceName(opts)

      assert.equal(result, 'myapp-kafka')
      assert.equal(opts.srvSrc, 'kafkajs')
    })

    it('should set srvSrc to "amqplib" for amqp producer', () => {
      const opts = { tracerService: 'myapp' }
      const result = messaging.producer.amqplib.serviceName(opts)

      assert.equal(result, 'myapp-amqp')
      assert.equal(opts.srvSrc, 'amqplib')
    })

    it('should set srvSrc to "amqp10" for amqp10 producer', () => {
      const opts = { tracerService: 'myapp' }
      const result = messaging.producer.amqp10.serviceName(opts)

      assert.equal(result, 'myapp-amqp')
      assert.equal(opts.srvSrc, 'amqp10')
    })

    it('should set srvSrc to "bullmq" for bullmq producer', () => {
      const opts = { tracerService: 'myapp' }
      const result = messaging.producer.bullmq.serviceName(opts)

      assert.equal(result, 'myapp-bullmq')
      assert.equal(opts.srvSrc, 'bullmq')
    })

    it('should set srvSrc to "rhea" for rhea producer', () => {
      const opts = { tracerService: 'myapp' }
      const result = messaging.producer.rhea.serviceName(opts)

      assert.equal(result, 'myapp-amqp-producer')
      assert.equal(opts.srvSrc, 'rhea')
    })

    it('should set srvSrc to "azure-event-hubs" for azure event hubs producer', () => {
      const opts = { tracerService: 'myapp' }
      const result = messaging.producer['azure-event-hubs'].serviceName(opts)

      assert.equal(result, 'myapp-azure-event-hubs')
      assert.equal(opts.srvSrc, 'azure-event-hubs')
    })

    it('should set srvSrc to "google-cloud-pubsub" for pubsub producer', () => {
      const opts = { tracerService: 'myapp' }
      const result = messaging.producer['google-cloud-pubsub'].serviceName(opts)

      assert.equal(result, 'myapp-pubsub')
      assert.equal(opts.srvSrc, 'google-cloud-pubsub')
    })

    it('should NOT set srvSrc for identityService consumers (google-cloud-pubsub)', () => {
      const opts = { tracerService: 'myapp' }
      messaging.consumer['google-cloud-pubsub'].serviceName(opts)

      assert.equal(opts.srvSrc, undefined)
    })

    it('should NOT set srvSrc for identityService consumers (rhea)', () => {
      const opts = { tracerService: 'myapp' }
      messaging.consumer.rhea.serviceName(opts)

      assert.equal(opts.srvSrc, undefined)
    })

    it('should set srvSrc to "aws" for sqs producer', () => {
      const opts = { tracerService: 'myapp', awsService: 'sqs' }
      messaging.producer.sqs.serviceName(opts)

      assert.equal(opts.srvSrc, 'aws')
    })

    it('should set srvSrc to "confluentinc-kafka-javascript" for confluent kafka', () => {
      const opts = { tracerService: 'myapp' }
      const result = messaging.producer['confluentinc-kafka-javascript'].serviceName(opts)

      assert.equal(result, 'myapp-kafka')
      assert.equal(opts.srvSrc, 'confluentinc-kafka-javascript')
    })
  })

  describe('web schemas', () => {
    let web

    beforeEach(() => {
      web = require('../../src/service-naming/schemas/v0/web')
    })

    it('should NOT set srvSrc for identityService (grpc client)', () => {
      const opts = { tracerService: 'myapp' }
      web.client.grpc.serviceName(opts)

      assert.equal(opts.srvSrc, undefined)
    })

    it('should NOT set srvSrc for identityService (http server)', () => {
      const opts = { tracerService: 'myapp' }
      web.server.http.serviceName(opts)

      assert.equal(opts.srvSrc, undefined)
    })

    it('should set srvSrc to "http" for http client with splitByDomain', () => {
      const opts = {
        pluginConfig: { splitByDomain: true },
        tracerService: 'myapp',
        sessionDetails: { host: 'example.com', port: 443 },
      }
      web.client.http.serviceName(opts)

      assert.equal(opts.srvSrc, 'http')
    })

    it('should set srvSrc to "m" for http client with user service', () => {
      const opts = {
        pluginConfig: { service: 'my-http' },
        tracerService: 'myapp',
        sessionDetails: {},
      }
      web.client.http.serviceName(opts)

      assert.equal(opts.srvSrc, 'm')
    })

    it('should NOT set srvSrc for http client with default service', () => {
      const opts = {
        pluginConfig: {},
        tracerService: 'myapp',
        sessionDetails: {},
      }
      web.client.http.serviceName(opts)

      assert.equal(opts.srvSrc, undefined)
    })

    it('should set srvSrc to "aws" for aws client', () => {
      const opts = { tracerService: 'myapp', awsService: 's3' }
      web.client.aws.serviceName(opts)

      assert.equal(opts.srvSrc, 'aws')
    })

    it('should set srvSrc to "m" for apollo gateway with user service', () => {
      const opts = {
        pluginConfig: { service: 'my-apollo' },
        tracerService: 'myapp',
      }
      web.server['apollo.gateway.request'].serviceName(opts)

      assert.equal(opts.srvSrc, 'm')
    })

    it('should NOT set srvSrc for apollo gateway with default service', () => {
      const opts = {
        pluginConfig: {},
        tracerService: 'myapp',
      }
      web.server['apollo.gateway.request'].serviceName(opts)

      assert.equal(opts.srvSrc, undefined)
    })
  })

  describe('websocket schemas', () => {
    let websocket

    beforeEach(() => {
      websocket = require('../../src/service-naming/schemas/v0/websocket')
    })

    it('should set srvSrc to "m" for ws with user service', () => {
      const opts = {
        pluginConfig: { service: 'my-ws' },
        tracerService: 'myapp',
      }
      websocket.request.ws.serviceName(opts)

      assert.equal(opts.srvSrc, 'm')
    })

    it('should NOT set srvSrc for ws with default service', () => {
      const opts = {
        pluginConfig: {},
        tracerService: 'myapp',
      }
      websocket.request.ws.serviceName(opts)

      assert.equal(opts.srvSrc, undefined)
    })
  })

  describe('util helpers', () => {
    let util

    beforeEach(() => {
      util = require('../../src/service-naming/schemas/util')
    })

    describe('identityService', () => {
      it('should NOT set srvSrc', () => {
        const opts = { tracerService: 'myapp' }
        util.identityService(opts)

        assert.equal(opts.srvSrc, undefined)
      })
    })

    describe('httpPluginClientService', () => {
      it('should set srvSrc to "http" for splitByDomain', () => {
        const opts = {
          pluginConfig: { splitByDomain: true },
          tracerService: 'myapp',
          sessionDetails: { host: 'example.com', port: 443 },
        }
        util.httpPluginClientService(opts)

        assert.equal(opts.srvSrc, 'http')
      })

      it('should set srvSrc to "m" for user service', () => {
        const opts = {
          pluginConfig: { service: 'custom' },
          tracerService: 'myapp',
          sessionDetails: {},
        }
        util.httpPluginClientService(opts)

        assert.equal(opts.srvSrc, 'm')
      })

      it('should set srvSrc to "opt.mapping" for mapped service', () => {
        const opts = {
          pluginConfig: { service: 'mapped', serviceFromMapping: true },
          tracerService: 'myapp',
          sessionDetails: {},
        }
        util.httpPluginClientService(opts)

        assert.equal(opts.srvSrc, 'opt.mapping')
      })

      it('should NOT set srvSrc when returning tracerService', () => {
        const opts = {
          pluginConfig: {},
          tracerService: 'myapp',
          sessionDetails: {},
        }
        util.httpPluginClientService(opts)

        assert.equal(opts.srvSrc, undefined)
      })
    })

    describe('awsServiceV0', () => {
      it('should set srvSrc to "aws"', () => {
        const opts = { tracerService: 'myapp', awsService: 's3' }
        util.awsServiceV0(opts)

        assert.equal(opts.srvSrc, 'aws')
      })
    })
  })

  describe('SchemaManager srvSrc propagation', () => {
    let SchemaManager

    beforeEach(() => {
      delete require.cache[require.resolve('../../src/service-naming')]
      SchemaManager = require('../../src/service-naming')
      SchemaManager.configure({
        spanAttributeSchema: 'v0',
        spanRemoveIntegrationFromService: false,
        service: 'myapp',
      })
    })

    it('should propagate srvSrc from schema function back to caller opts', () => {
      const opts = { pluginConfig: {}, params: {} }
      SchemaManager.serviceName('storage', 'client', 'pg', opts)

      assert.equal(opts.srvSrc, 'pg')
    })

    it('should propagate srvSrc "m" for user service', () => {
      const opts = { pluginConfig: { service: 'custom' }, params: {} }
      SchemaManager.serviceName('storage', 'client', 'pg', opts)

      assert.equal(opts.srvSrc, 'm')
    })

    it('should propagate srvSrc "opt.mapping" for mapped service', () => {
      const opts = { pluginConfig: { service: 'mapped', serviceFromMapping: true }, params: {} }
      SchemaManager.serviceName('storage', 'client', 'pg', opts)

      assert.equal(opts.srvSrc, 'opt.mapping')
    })

    it('should not set srvSrc for identityService', () => {
      const opts = {}
      SchemaManager.serviceName('web', 'server', 'http', opts)

      assert.equal(opts.srvSrc, undefined)
    })
  })
})
