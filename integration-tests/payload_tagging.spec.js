'use strict'

const {
  createSandbox,
  FakeAgent,
  spawnProc
} = require('../helpers')

describe('Payload tagging redaction',  ()=> {
    let axios, sandbox, cwd, appFile, agent, proc

    before(async () => {
        sandbox = await createSandbox(['express'])
        cwd = sandbox.folder
        appFile = path.join(cwd, 'payload-tagging/index.js')
    })

    after(async () => {
        await sandbox.remove()
    })

    function startTestServer(env) {
        beforeEach(async () => {
            agent = await new FakeAgent().start()

            proc = await spawnProc(appFile, { cwd, env, execArgv: [] })
            axios = Axios.create({ baseURL: proc.url })
        })

        afterEach(async () => {
            proc.kill()
            await agent.stop
        })
    }
    it('receives a trace for GET /sampled', async () => {
        await axios.get('/sampled')
    
        await agent.assertMessageReceived(({ headers, payload }) => {
          assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
          assert.isArray(payload)
        
          // Ensures we get a trace from the the tracer
          const root = payload[0][0]
          assert.strictEqual(root.service, 'test-service')
          assert.strictEqual(root.type, 'web')
          assert.property(root, 'trace_id')
          assert.property(root, 'span_id')
        })
      })
})