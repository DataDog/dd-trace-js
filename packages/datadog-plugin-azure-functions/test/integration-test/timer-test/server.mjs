import 'dd-trace/init.js'
import { app } from '@azure/functions'

// Non-HTTP, non-messaging trigger: this should result in extractTraceContext() returning null
// and therefore the invoke span being a root span (childOf: null).
app.timer('timertest', {
  schedule: '*/15 * * * * *',
  runOnStartup: true,
  handler: async () => {
    // no-op
  },
})

