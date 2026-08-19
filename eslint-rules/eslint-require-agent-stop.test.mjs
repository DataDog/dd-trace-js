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
    before(async () => { agent = await new FakeAgent().start() })
    after(async () => {
      const agentStopped = agent?.stop()
      await Promise.all([agentStopped])
    })`,
    `const state = {}
    before(() => { state.agent = new FakeAgent() })
    after(() => { return state.agent.stop() })`,
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
  ],
})
