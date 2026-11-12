import 'dd-trace/init.js'
import { app } from '@azure/functions'

async function handlerFunction (request, context) {
  return {
    status: 200,
    body: 'Hello Datadog!',
    headers: { 'x-sampling-priority': request.headers.get('x-datadog-sampling-priority') ?? '' },
  }
}

app.http('httptest', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: handlerFunction,
})

app.http('httptest2', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const response = await fetch('http://127.0.0.1:7071/api/httptest')
    await response.text()
    return {
      status: 200,
      body: 'Hello Datadog 2!',
      headers: { 'x-sampling-priority': response.headers.get('x-sampling-priority') },
    }
  },
})
