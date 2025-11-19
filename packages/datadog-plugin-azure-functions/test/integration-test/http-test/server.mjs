import 'dd-trace/init.js'
import { app } from '@azure/functions'

async function handlerFunction (request, context) {
  return {
    status: 200,
    body: 'Hello Datadog!'
  }
}

app.http('httptest', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: handlerFunction
})

app.http('httptest2', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    await fetch('http://127.0.0.1:7071/api/httptest')
    return {
      status: 200,
      body: 'Hello Datadog 2!'
    }
  }
})
