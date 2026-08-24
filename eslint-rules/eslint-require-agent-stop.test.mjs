import { RuleTester } from 'eslint'

import rule from './eslint-require-agent-stop.mjs'

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022 },
})

ruleTester.run('eslint-require-agent-stop', /** @type {import('eslint').Rule.RuleModule} */ (rule), {
  valid: [
    'after()',
    'afterEach()',
    `let agent
    beforeEach(async () => { agent = await new FakeAgent().start() })
    afterEach(() => agent.stop())`,
    `let agent
    beforeEach(async () => { agent = await new FakeAgent().start() })
    afterEach(async () => { await agent.stop() })`,
    `let agent
    beforeEach(async () => { agent = await new FakeAgent().start() })
    async function cleanup () { await agent.stop() }
    afterEach(cleanup)`,
    `let agent
    beforeEach(async () => { agent = await new FakeAgent().start() })
    afterEach(cleanup)
    async function cleanup () { await agent.stop() }`,
    `let agent
    beforeEach(async () => { agent = await new FakeAgent().start() })
    async function cleanup () { await agent.stop() }
    const teardown = cleanup
    afterEach(teardown)`,
    `let agent
    beforeEach(async () => { agent = await new FakeAgent().start() })
    const cleanup = () => agent.stop()
    afterEach('cleanup', cleanup)`,
    `let agent
    before(async () => { agent = await new FakeAgent().start() })
    const cleanup = async function () {
      const agentStopped = agent.stop()
      await agentStopped
    }
    after(cleanup)`,
    'afterEach(cleanup)',
    `const cleanup = createCleanup()
    afterEach(cleanup)`,
    `const cleanup = cleanup
    afterEach(cleanup)`,
    `let agent
    const cleanup = () => { agent.stop() }
    cleanup = () => {}
    afterEach(cleanup)`,
    `var cleanup = () => {}
    var cleanup = () => {}
    afterEach(cleanup)`,
    `let agent
    beforeEach(async () => { agent = await new FakeAgent().start() })
    afterEach('cleanup', () => agent.stop())`,
    `let agent
    before(async () => { agent = await new FakeAgent().start() })
    after(async () => {
      const agentStopped = agent?.stop()
      await Promise.all([agentStopped])
    })`,
    `let agent
    before(async () => { agent = await new FakeAgent().start() })
    after(async () => {
      const agentStopped = agent.stop()
      await Promise.allSettled([agentStopped])
    })`,
    `let agent
    before(async () => { agent = await new FakeAgent().start() })
    after(async () => {
      const agentStopped = shouldStop ? agent.stop() : undefined
      await Promise.resolve(agentStopped)
    })`,
    `let agent
    before(async () => { agent = await new FakeAgent().start() })
    after(() => agent.stop().finally(() => {}))`,
    `let agent
    before(async () => { agent = await new FakeAgent().start() })
    after(async () => { await (shouldStop && agent.stop()) })`,
    `let agent
    before(async () => { agent = await new FakeAgent().start() })
    after(async () => { await (agent.stop() || Promise.resolve()) })`,
    `let agent
    before(async () => { agent = await new FakeAgent().start() })
    after(async () => { await (cleanup(), agent.stop()) })`,
    `let agent, agentStopped
    before(async () => { agent = await new FakeAgent().start() })
    after(async () => {
      agentStopped = agent.stop()
      await agentStopped
    })`,
    `let agent
    before(async () => { agent = await new FakeAgent().start() })
    after(async () => {
      let agentStopped = agent.stop()
      await agentStopped
      agentStopped = stopProc(proc)
    })`,
    `let agent
    before(async () => { agent = await new FakeAgent().start() })
    after(async () => {
      const agentStopped = agent.stop()
      if (shouldStop) {
        await agentStopped
      } else {
        await agentStopped
      }
    })`,
    `let agent
    before(async () => { agent = await new FakeAgent().start() })
    after(async () => {
      const agentStopped = agent.stop()
      if (shouldStop) {
        stopProc(firstProc)
      } else {
        stopProc(secondProc)
      }
      await agentStopped
    })`,
    `let agent
    before(async () => { agent = await new FakeAgent().start() })
    after(async () => {
      for (const proc of processes) {
        const agentStopped = agent.stop()
        await agentStopped
        stopProc(proc)
      }
    })`,
    `let agent
    before(async () => { agent = await new FakeAgent().start() })
    after(async () => {
      const agentStopped = agent.stop()
      while (isStopping()) {
        await stopProc(proc)
      }
      await agentStopped
    })`,
    `const state = {}
    before(() => { state.agent = new FakeAgent() })
    after(() => { return state.agent.stop() })`,
    `describe('fake agent', () => {
      let agent
      beforeEach(async () => { agent = await new FakeAgent().start() })
      afterEach(async () => { await agent.stop() })
    })
    describe('other agent', () => {
      const agent = { stop () {} }
      afterEach(() => { agent.stop() })
    })`,
    `describe('fake agent', () => {
      const state = {}
      beforeEach(async () => { state.agent = await new FakeAgent().start() })
      afterEach(async () => { await state.agent.stop() })
    })
    describe('other agent', () => {
      const state = { agent: { stop () {} } }
      afterEach(() => { state.agent.stop() })
    })`,
    `let agent
    beforeEach(async () => { agent = await new FakeAgent().start() })
    afterEach(() => () => agent.stop())`,
    `const { agent } = state
    afterEach(() => { agent.stop() })`,
    'afterEach(() => broker.stop())',
  ],
  invalid: [
    {
      code: `let agent
      beforeEach(async () => { agent = await new FakeAgent().start() })
      afterEach(() => { agent.stop() })`,
      errors: [{ messageId: 'requireSettledStop' }],
    },
    {
      code: `let agent
      beforeEach(async () => { agent = await new FakeAgent().start() })
      function cleanup () { agent.stop() }
      afterEach(cleanup)`,
      errors: [{ messageId: 'requireSettledStop' }],
    },
    {
      code: `let agent
      beforeEach(async () => { agent = await new FakeAgent().start() })
      afterEach(cleanup)
      function cleanup () { agent.stop() }`,
      errors: [{ messageId: 'requireSettledStop' }],
    },
    {
      code: `let agent
      beforeEach(async () => { agent = await new FakeAgent().start() })
      const cleanup = () => { agent.stop() }
      afterEach('cleanup', cleanup)`,
      errors: [{ messageId: 'requireSettledStop' }],
    },
    {
      code: `let agent
      before(async () => { agent = await new FakeAgent().start() })
      const cleanup = function () { agent.stop() }
      after(cleanup)`,
      errors: [{ messageId: 'requireSettledStop' }],
    },
    {
      code: `let agent
      beforeEach(async () => { agent = await new FakeAgent().start() })
      afterEach('cleanup', () => { agent.stop() })`,
      errors: [{ messageId: 'requireSettledStop' }],
    },
    {
      code: `const state = {}
      before(() => { state.agent = new FakeAgent() })
      after(() => { state.agent.stop() })`,
      errors: [{ messageId: 'requireSettledStop' }],
    },
    {
      code: `let agent
      before(() => { agent = new FakeAgent() })
      after(() => { const stopped = agent.stop() })`,
      errors: [{ messageId: 'requireSettledStop' }],
    },
    {
      code: `let agent
      before(() => { agent = new FakeAgent() })
      after(async () => { await [agent.stop()] })`,
      errors: [{ messageId: 'requireSettledStop' }],
    },
    {
      code: `let agent
      before(() => { agent = new FakeAgent() })
      after(() => [agent.stop()])`,
      errors: [{ messageId: 'requireSettledStop' }],
    },
    {
      code: `let agent
      before(() => { agent = new FakeAgent() })
      after(() => { return { stopped: agent.stop() } })`,
      errors: [{ messageId: 'requireSettledStop' }],
    },
    {
      code: `let agent
      before(() => { agent = new FakeAgent() })
      after(async () => {
        const agentStopped = agent.stop()
        await [agentStopped]
      })`,
      errors: [{ messageId: 'requireSettledStop' }],
    },
    {
      code: `let agent
      before(() => { agent = new FakeAgent() })
      after(async () => {
        let agentStopped = agent.stop()
        agentStopped = stopProc(proc)
        await agentStopped
      })`,
      errors: [{ messageId: 'requireSettledStop' }],
    },
    {
      code: `let agent
      before(() => { agent = new FakeAgent() })
      after(async () => {
        const state = {}
        state.agentStopped = agent.stop()
        state.agentStopped = stopProc(proc)
        await state.agentStopped
      })`,
      errors: [{ messageId: 'requireSettledStop' }],
    },
    {
      code: `let agent
      before(() => { agent = new FakeAgent() })
      after(async () => {
        let state = {}
        state.agentStopped = agent.stop()
        state = {}
        await state.agentStopped
      })`,
      errors: [{ messageId: 'requireSettledStop' }],
    },
    {
      code: `let agent
      before(() => { agent = new FakeAgent() })
      after(async () => {
        const state = { cleanup: {} }
        state.cleanup.agentStopped = agent.stop()
        state.cleanup = {}
        await state.cleanup.agentStopped
      })`,
      errors: [{ messageId: 'requireSettledStop' }],
    },
    {
      code: `let agent
      before(() => { agent = new FakeAgent() })
      after(async () => {
        const agentStopped = agent.stop()
        if (shouldStop) await agentStopped
      })`,
      errors: [{ messageId: 'requireSettledStop' }],
    },
    {
      code: `let agent
      before(() => { agent = new FakeAgent() })
      after(async () => {
        let agentStopped
        while (shouldStop) {
          agentStopped = agent.stop()
        }
        await agentStopped
      })`,
      errors: [{ messageId: 'requireSettledStop' }],
    },
    {
      code: `let agent
      before(() => { agent = new FakeAgent() })
      after(async () => {
        let agentStopped
        await agentStopped
        agentStopped = agent.stop()
      })`,
      errors: [{ messageId: 'requireSettledStop' }],
    },
    {
      code: `let agent
      before(() => { agent = new FakeAgent() })
      after(async () => { await (agent.stop() && true) })`,
      errors: [{ messageId: 'requireSettledStop' }],
    },
    {
      code: `let receiver
      before(() => { receiver = new FakeCiVisIntake() })
      after(() => { receiver.stop() })`,
      errors: [{ messageId: 'requireSettledStop' }],
    },
    {
      code: `const agent = new FakeAgent()
      after(() => { agent.stop() })`,
      errors: [{ messageId: 'requireSettledStop' }],
    },
    {
      code: `const state = {}
      before(() => { state.agent = new FakeAgent() })
      after(() => { (state?.agent).stop() })`,
      errors: [{ messageId: 'requireSettledStop' }],
    },
  ],
})
