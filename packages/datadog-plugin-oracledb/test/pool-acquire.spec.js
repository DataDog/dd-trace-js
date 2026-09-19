'use strict'

const assert = require('node:assert/strict')

const agent = require('../../dd-trace/test/plugins/agent')
const Nomenclature = require('../../dd-trace/src/service-naming')
const { assertObjectContains } = require('../../../integration-tests/helpers')
const { rawExpectedSchema } = require('./naming')

const poolConfig = {
  user: 'test',
  password: 'Oracle18',
  connectString: 'localhost:1521/xepdb1',
  poolMin: 0,
}

const acquireSpan = {
  name: 'oracle.pool.acquire',
  resource: 'oracle.pool.acquire',
  type: 'sql',
  meta: {
    'span.kind': 'client',
    component: 'oracledb',
    'db.instance': 'xepdb1',
    'db.name': 'xepdb1',
    'db.hostname': 'localhost',
    'out.host': 'localhost',
    'network.destination.port': '1521',
  },
}

describe('oracledb pool acquisition without a database service', () => {
  let oracledb
  let pool
  let tracer

  describe('with acquisition tracing', () => {
    before(async () => {
      await agent.load('oracledb')
      oracledb = require('../../../versions/oracledb').get()
      tracer = require('../../dd-trace')
      pool = await oracledb.createPool(poolConfig)
    })

    after(async () => {
      await pool.close(0)
      await agent.close()
    })

    it('uses normalized pool fields after the caller mutates its configuration', async () => {
      const config = {
        ...poolConfig,
        poolAlias: 'normalized-callback-pool',
      }
      let callbackPool

      try {
        await new Promise((resolve, reject) => {
          const returnValue = oracledb.createPool(config, (error, createdPool) => {
            if (error) return reject(error)
            callbackPool = createdPool
            resolve()
          })
          assert.strictEqual(returnValue, undefined)
        })
        config.connectString = 'mutated.example.invalid'

        await Promise.all([
          agent.assertFirstTraceSpan(acquireSpan, { spanResourceMatch: /^oracle\.pool\.acquire$/ }),
          assert.rejects(callbackPool.getConnection(null), { code: 'NJS-005' }),
        ])
      } finally {
        if (callbackPool !== undefined) await callbackPool.close(0)
      }
    })

    for (const protocol of ['tcp', 'tcps']) {
      it(`parses ${protocol} Easy Connect pool URLs`, async () => {
        const protocolPool = await oracledb.createPool({
          ...poolConfig,
          connectString: `${protocol}://db.example:1522/service`,
          poolAlias: `${protocol}-pool`,
        })

        try {
          await Promise.all([
            agent.assertFirstTraceSpan({
              ...acquireSpan,
              meta: {
                ...acquireSpan.meta,
                'db.instance': 'service',
                'db.name': 'service',
                'db.hostname': 'db.example',
                'out.host': 'db.example',
                'network.destination.port': '1522',
              },
            }, { spanResourceMatch: /^oracle\.pool\.acquire$/ }),
            assert.rejects(protocolPool.getConnection(null), { code: 'NJS-005' }),
          ])
        } finally {
          await protocolPool.close(0)
        }
      })
    }

    describe('pool acquisition naming', () => {
      let fullConfig

      beforeEach(() => {
        fullConfig = Nomenclature.config
      })

      afterEach(() => {
        Nomenclature.configure(fullConfig)
      })

      for (const version of ['v0', 'v1']) {
        it(`uses the ${version} naming schema`, async () => {
          Nomenclature.configure({
            spanAttributeSchema: version,
            spanRemoveIntegrationFromService: false,
            service: fullConfig.service,
          })

          await Promise.all([
            agent.assertFirstTraceSpan({
              name: rawExpectedSchema.poolAcquire[version].opName,
              service: rawExpectedSchema.poolAcquire[version].serviceName,
            }, { spanResourceMatch: /^oracle\.pool\.acquire$/ }),
            assert.rejects(pool.getConnection(null), { code: 'NJS-005' }),
          ])
        })
      }
    })

    it('traces Promise validation errors without changing the error', async () => {
      let applicationError
      const tracePromise = agent.assertFirstTraceSpan(span => {
        assertObjectContains(span, {
          ...acquireSpan,
          meta: {
            ...acquireSpan.meta,
            'error.message': applicationError.message,
            'error.type': applicationError.name,
            'error.stack': applicationError.stack,
          },
        })
      }, { spanResourceMatch: /^oracle\.pool\.acquire$/ })

      await assert.rejects(pool.getConnection(null), error => {
        applicationError = error
        return error.code === 'NJS-005'
      })
      await tracePromise
    })

    it('traces callback validation errors and restores the parent context', async () => {
      const parent = tracer.startSpan('acquire-parent')
      let applicationError
      let returnValue
      const tracePromise = agent.assertSomeTraces(traces => {
        const spans = traces.flat()
        const span = spans.find(span => span.name === 'oracle.pool.acquire')

        assert.ok(span)
        assert.strictEqual(span.parent_id.toString(), parent.context().toSpanId())
        assert.strictEqual(span.meta['error.message'], applicationError.message)
        assert.strictEqual(span.meta['error.type'], applicationError.name)
        assert.strictEqual(span.meta['error.stack'], applicationError.stack)
      })

      await tracer.scope().activate(parent, () => {
        return new Promise((resolve, reject) => {
          returnValue = pool.getConnection(null, (error, connection) => {
            try {
              applicationError = error
              assert.strictEqual(error.code, 'NJS-005')
              assert.strictEqual(connection, undefined)
              assert.strictEqual(tracer.scope().active(), parent)
              resolve()
            } catch (error) {
              reject(error)
            }
          })
          assert.strictEqual(returnValue, undefined)
        })
      })

      parent.finish()
      await tracePromise
    })

    it('does not trace top-level connection acquisition', async () => {
      const parent = tracer.startSpan('top-level-acquire-parent')
      const tracePromise = agent.assertSomeTraces(traces => {
        assert.strictEqual(traces.flat().some(span => span.name === 'oracle.pool.acquire'), false)
      })

      await tracer.scope().activate(parent, () => assert.rejects(oracledb.getConnection(null), { code: 'NJS-005' }))
      parent.finish()
      await tracePromise
    })
  })

  describe('with a dynamic acquisition service', () => {
    let service

    before(async () => {
      service = 'first'
      await agent.load('oracledb', { service: () => service })
      oracledb = require('../../../versions/oracledb').get()
      pool = await oracledb.createPool(poolConfig)
    })

    after(async () => {
      await pool.close(0)
      await agent.close()
    })

    it('caches the service for the pool', async () => {
      for (const current of ['first', 'second']) {
        service = current
        await Promise.all([
          agent.assertFirstTraceSpan({
            name: 'oracle.pool.acquire',
            service: 'first',
          }, { spanResourceMatch: /^oracle\.pool\.acquire$/ }),
          assert.rejects(pool.getConnection(null), { code: 'NJS-005' }),
        ])
      }
    })
  })

  describe('with acquisition tracing disabled', () => {
    before(async () => {
      tracer = await agent.load('oracledb', { poolAcquire: false })
      oracledb = require('../../../versions/oracledb').get()
      pool = await oracledb.createPool(poolConfig)
    })

    after(async () => {
      await pool.close(0)
      await agent.close()
    })

    it('does not trace pool acquisition errors', async () => {
      const parent = tracer.startSpan('disabled-acquire-parent')
      const tracePromise = agent.assertSomeTraces(traces => {
        assert.strictEqual(traces.flat().some(span => span.name === 'oracle.pool.acquire'), false)
      })

      await tracer.scope().activate(parent, () => assert.rejects(pool.getConnection(null), { code: 'NJS-005' }))
      parent.finish()
      await tracePromise
    })
  })
})
