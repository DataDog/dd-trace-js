'use strict'

const {
  FakeAgent,
  spawnAndGetURL,
  curl
} = require('./helpers')
const path = require('path')

describe('startup', () => {
  let agent
  let proc

  context('programmatic', () => {
    beforeEach(async () => {
      agent = new FakeAgent()
    })

    afterEach(() => {
      proc.kill()
      agent.close()
    })

    it('works for options.port', async () => {
      proc = await spawnAndGetURL(path.join(__dirname, 'startup/index.js'), {
        env: {
          AGENT_PORT: agent.port
        }
      })
      const resultPromise = agent.gotGoodPayload()
      await curl(proc)
      return resultPromise
    })

    it('works for options.url', async () => {
      proc = await spawnAndGetURL(path.join(__dirname, 'startup/index.js'), {
        env: {
          AGENT_URL: `http://localhost:${agent.port}`
        }
      })
      const resultPromise = agent.gotGoodPayload({ hostHeader: `localhost:${agent.port}` })
      await curl(proc)
      return resultPromise
    })
  })

  context('env var', () => {
    beforeEach(async () => {
      agent = new FakeAgent()
    })

    afterEach(() => {
      proc.kill()
      agent.close()
    })

    it('works for DD_TRACE_AGENT_PORT', async () => {
      proc = await spawnAndGetURL(path.join(__dirname, 'startup/index.js'), {
        env: {
          DD_TRACE_AGENT_PORT: agent.port
        }
      })
      const resultPromise = agent.gotGoodPayload()
      await curl(proc)
      return resultPromise
    })

    it('works for DD_TRACE_AGENT_URL', async () => {
      proc = await spawnAndGetURL(path.join(__dirname, 'startup/index.js'), {
        env: {
          DD_TRACE_AGENT_URL: `http://localhost:${agent.port}`
        }
      })
      const resultPromise = agent.gotGoodPayload({ hostHeader: `localhost:${agent.port}` })
      await curl(proc)
      return resultPromise
    })
  })

  context('default', () => {
    beforeEach(async () => {
      // Note that this test will *always* listen on the default port. If that
      // port is unavailable, the test will fail.
      agent = new FakeAgent(8126)
    })

    afterEach(() => {
      proc.kill()
      agent.close()
    })

    it('works for hostname and port', async () => {
      proc = await spawnAndGetURL(path.join(__dirname, 'startup/index.js'))
      const resultPromise = agent.gotGoodPayload()
      await curl(proc)
      return resultPromise
    })
  })
})
