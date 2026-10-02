'use strict'

const assert = require('node:assert/strict')

const agent = require('../../dd-trace/test/plugins/agent')
const Nomenclature = require('../../dd-trace/src/service-naming')
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
      tracer = await agent.load('oracledb', { service: () => service })
      oracledb = require('../../../versions/oracledb').get()
      pool = await oracledb.createPool(poolConfig)
    })

    after(async () => {
      await pool.close(0)
      await agent.close()
    })

    it('caches the service for the pool until configuration changes', async () => {
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

      tracer.use('oracledb', { service: () => 'third' })
      await Promise.all([
        agent.assertFirstTraceSpan({ service: 'third' }, { spanResourceMatch: /^oracle\.pool\.acquire$/ }),
        assert.rejects(pool.getConnection(null), { code: 'NJS-005' }),
      ])
    })
  })
})
