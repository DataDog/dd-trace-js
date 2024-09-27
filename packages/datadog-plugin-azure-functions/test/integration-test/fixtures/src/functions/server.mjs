import 'dd-trace/init.js'
import { app } from '@azure/functions'

async function handlerFunction (request, context) {
  return {
    status: 200,
    body: 'Hello Datadog!'
  }
}

app.http('httpexample', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: handlerFunction
})
