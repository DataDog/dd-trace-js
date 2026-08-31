import { RuleTester } from 'eslint'

import rule from './eslint-no-pending-assertion-before-await.mjs'

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
})

ruleTester.run(
  'eslint-no-pending-assertion-before-await',
  /** @type {import('eslint').Rule.RuleModule} */ (rule),
  {
    valid: [
      {
        code: `
        async function test () {
          await agent.assertSomeTraces(check)
          await request()
        }
      `,
      },
      {
        code: `
        async function test () {
          const tracePromise = agent.assertSomeTraces(check)
          await tracePromise
          await request()
        }
      `,
      },
      {
        code: `
        async function test () {
          const tracePromise = agent.assertSomeTraces(check)
          await Promise.all([tracePromise, request()])
        }
      `,
      },
      {
        code: `
        async function test () {
          const tracePromise = agent.assertSomeTraces(check)
          tracePromise.catch(onError)
          await request()
        }
      `,
      },
      {
        code: `
        async function test () {
          const tracePromise = agent.assertSomeTraces(check)
          tracePromise.then(onSuccess, onError)
          await request()
        }
      `,
      },
      {
        code: `
        async function test () {
          const tracePromise = agent.assertSomeTraces(check)
          Promise.allSettled([tracePromise])
          await request()
        }
      `,
      },
      {
        code: `
        async function test () {
          const tracePromise = agent.assertSomeTraces(check)
          return tracePromise
        }
      `,
      },
      {
        code: `
        async function test () {
          const tracePromise = agent.assertSomeTraces(check)
          const alias = tracePromise
          await alias
          await request()
        }
      `,
      },
      {
        code: `
        async function test () {
          agent.assertSomeTraces(check)
          await agent.close()
        }
      `,
      },
      {
        code: `
        async function test () {
          const tracePromise = agent.assertSomeTraces(check)
          tracePromise.cancel()
          await request()
        }
      `,
      },
      {
        code: `
        async function test () {
          const tracePromise = agent.waitForTrace(check)
          await request()
          await tracePromise
        }
      `,
      },
      {
        code: `
        async function test () {
          const tracePromise = agent.waitForTrace(check)
          await Promise.all([tracePromise, request()])
        }
      `,
        options: [{ promiseMethods: ['waitForTrace'] }],
      },
      {
        code: `
        async function test (condition) {
          const tracePromise = agent.assertSomeTraces(check)
          if (condition) {
            tracePromise.catch(onError)
          } else {
            await tracePromise
          }
          await request()
        }
      `,
      },
      {
        code: `
        async function test (condition) {
          if (condition) {
            agent.assertSomeTraces(check)
          } else {
            await request()
          }
        }
      `,
      },
      {
        code: `
        async function test (condition) {
          const tracePromise = agent.assertSomeTraces(check)
          await (condition ? tracePromise : tracePromise)
          await request()
        }
      `,
      },
      {
        code: `
        async function test () {
          const tracePromise = agent.assertSomeTraces(check)
          for await (const trace of [tracePromise]) consume(trace)
          await request()
        }
      `,
      },
    ],
    invalid: [
      {
        code: `
        async function test () {
          const tracePromise = agent.assertSomeTraces(check)
          await request()
          await tracePromise
        }
      `,
        errors: [{
          messageId: 'pendingAssertion',
          data: { method: 'assertSomeTraces' },
          line: 4,
        }],
      },
      {
        code: `
        async function test () {
          const tracePromise = agent.assertFirstTraceSpan(check)
          const response = await fetch.fetch(url)
          await Promise.all([tracePromise, response.text()])
        }
      `,
        errors: [{
          messageId: 'pendingAssertion',
          data: { method: 'assertFirstTraceSpan' },
          line: 4,
        }],
      },
      {
        code: `
        async function test () {
          const tracePromise = agent.assertSomeTraces(check)
          const { body } = await fetch.request(url)
          await Promise.all([body.text(), tracePromise])
        }
      `,
        errors: [{
          messageId: 'pendingAssertion',
          data: { method: 'assertSomeTraces' },
          line: 4,
        }],
      },
      {
        code: `
        async function test () {
          const tracePromise = agent.assertSomeTraces(check)
          await request()
          tracePromise.catch(onError)
        }
      `,
        errors: [{ messageId: 'pendingAssertion', line: 4 }],
      },
      {
        code: `
        async function test () {
          const tracePromise = agent.assertSomeTraces(check)
          tracePromise.catch()
          await request()
        }
      `,
        errors: [{ messageId: 'pendingAssertion', line: 5 }],
      },
      {
        code: `
        async function test () {
          const tracePromise = agent.assertSomeTraces(check)
          tracePromise.then(onSuccess)
          await request()
        }
      `,
        errors: [{ messageId: 'pendingAssertion', line: 5 }],
      },
      {
        code: `
        async function test () {
          const tracePromise = agent.assertSomeTraces(check)
          tracePromise.finally(cleanup)
          await request()
        }
      `,
        errors: [{ messageId: 'pendingAssertion', line: 5 }],
      },
      {
        code: `
        async function test () {
          const tracePromise = agent.assertSomeTraces(check)
          const aggregate = Promise.all([tracePromise, request()])
          await unrelated()
          await aggregate
        }
      `,
        errors: [{ messageId: 'pendingAssertion', line: 5 }],
      },
      {
        code: `
        async function test () {
          const tracePromise = agent.assertSomeTraces(check)
          function attachHandler () {
            tracePromise.catch(onError)
          }
          await request()
          attachHandler()
        }
      `,
        errors: [{ messageId: 'pendingAssertion', line: 7 }],
      },
      {
        code: `
        async function test () {
          agent.assertSomeTraces(check)
          await request()
        }
      `,
        errors: [{ messageId: 'pendingAssertion', line: 4 }],
      },
      {
        code: `
        async function test () {
          const first = agent.assertSomeTraces(checkFirst)
          const second = agent.assertFirstTraceSpan(checkSecond)
          await request()
          await Promise.all([first, second])
        }
      `,
        errors: [
          {
            messageId: 'pendingAssertion',
            data: { method: 'assertSomeTraces' },
            line: 5,
          },
          {
            messageId: 'pendingAssertion',
            data: { method: 'assertFirstTraceSpan' },
            line: 5,
          },
        ],
      },
      {
        code: `
        async function test () {
          const tracePromise = agent.waitForTrace(check)
          await request()
          await tracePromise
        }
      `,
        options: [{ promiseMethods: ['waitForTrace'] }],
        errors: [{
          messageId: 'pendingAssertion',
          data: { method: 'waitForTrace' },
          line: 4,
        }],
      },
      {
        code: `
        async function test () {
          const tracePromise = agent.assertSomeTraces(check)
          await otherAgent.close()
          await tracePromise
        }
      `,
        errors: [{ messageId: 'pendingAssertion', line: 4 }],
      },
      {
        code: `
        async function test () {
          const tracePromise = agent.assertSomeTraces(check)
          observe(tracePromise)
          await request()
        }
      `,
        errors: [{ messageId: 'pendingAssertion', line: 5 }],
      },
      {
        code: `
        async function test (condition) {
          const tracePromise = agent.assertSomeTraces(check)
          if (condition) tracePromise.catch(onError)
          await request()
        }
      `,
        errors: [{ messageId: 'pendingAssertion', line: 5 }],
      },
      {
        code: `
        async function test (condition) {
          const tracePromise = agent.assertSomeTraces(check)
          await (condition ? tracePromise : request())
        }
      `,
        errors: [{ messageId: 'pendingAssertion', line: 4 }],
      },
      {
        code: `
        async function test () {
          const tracePromise = agent.assertSomeTraces(check)
          tracePromise.catch(false)
          await request()
        }
      `,
        errors: [{ messageId: 'pendingAssertion', line: 5 }],
      },
      {
        code: `
        async function test () {
          const tracePromise = agent.assertSomeTraces(check)
          tracePromise.then(onSuccess, false)
          await request()
        }
      `,
        errors: [{ messageId: 'pendingAssertion', line: 5 }],
      },
      {
        code: `
        async function test () {
          const tracePromise = agent.assertSomeTraces(check)
          tracePromise.toString()
          await request()
        }
      `,
        errors: [{ messageId: 'pendingAssertion', line: 5 }],
      },
      {
        code: `
        async function test () {
          const Promise = { all () { return globalThis.Promise.resolve() } }
          const tracePromise = agent.assertSomeTraces(check)
          await Promise.all([tracePromise])
        }
      `,
        errors: [{ messageId: 'pendingAssertion', line: 5 }],
      },
      {
        code: `
        async function test (condition) {
          const tracePromise = agent.assertSomeTraces(check)
          let awaited
          if (condition) {
            tracePromise.catch(onError)
            awaited = tracePromise
          } else {
            awaited = request()
          }
          await awaited
        }
      `,
        errors: [{ messageId: 'pendingAssertion', line: 11 }],
      },
      {
        code: `
        async function test () {
          const notAHandler = false
          const tracePromise = agent.assertSomeTraces(check)
          tracePromise.catch(notAHandler)
          await request()
        }
      `,
        errors: [{ messageId: 'pendingAssertion', line: 6 }],
      },
      {
        code: `
        async function test (stream) {
          const tracePromise = agent.assertSomeTraces(check)
          for await (const chunk of stream) consume(chunk)
          await tracePromise
        }
      `,
        errors: [{ messageId: 'pendingAssertion', line: 4 }],
      },
    ],
  }
)
