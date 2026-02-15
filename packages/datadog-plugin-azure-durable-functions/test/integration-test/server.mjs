import 'dd-trace/init.js'
import { app } from '@azure/functions'

import df from 'durable-functions'

df.app.entity('Counter', (context) => {
  const current = context.df.getState(() => 0)

  switch (context.df.operationName) {
    case 'add_n': {
      const n = context.df.getInput() ?? 0
      context.df.setState(current + n)
      break
    }
    case 'get_count': {
      context.df.return(current)
      break
    }
    default:
      break
  }
})

df.app.activity('hola', {
  handler: async (name, _ctx) => {
    return `hola ${name}`
  },
})

/**
 * Orchestrator: testOrchestrator
 * - calls activity
 * - updates entity
 */
df.app.orchestration('testOrchestrator', function * (context) {
  const input = context.df.getInput()

  // 1) Do work (activity)
  const greeting = yield context.df.callActivity('hola', input.name)

  // 2) Update state (entity)
  const counterId = new df.EntityId('Counter', 'global')
  const increment = input.increment
  yield context.df.callEntity(counterId, 'add_n', increment)

  // 3) Read state back (entity)
  const total = yield context.df.callEntity(counterId, 'get_count')

  return { greeting, total }
})

app.http('httptest', {
  methods: ['GET'],
  extraInputs: [df.input.durableClient()],

  handler: async (req, context) => {
    const client = df.getClient(context)
    const params = await req.query
    const name = params?.name || 'world'
    const increment = params?.increment || 1

    const instanceId = await client.startNew('testOrchestrator', { input: { name, increment } })
    return client.createCheckStatusResponse(req, instanceId)
  },
})
