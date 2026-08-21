import { RuleTester } from 'eslint'

import rule from './eslint-require-agent-stop.mjs'

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022 },
})

ruleTester.run('eslint-require-agent-stop', /** @type {import('eslint').Rule.RuleModule} */ (rule), {
  valid: [
    `let agent
    beforeEach(async () => { agent = await new FakeAgent().start() })
    afterEach(() => agent.stop())`,
    `let agent
    beforeEach(async () => { agent = await new FakeAgent().start() })
    afterEach(async () => { await agent.stop() })`,
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
