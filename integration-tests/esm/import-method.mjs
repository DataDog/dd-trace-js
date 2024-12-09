import dc from 'diagnostics_channel'
import { execFileSync } from 'node:child_process'

const tracingChannel = dc.tracingChannel('datadog:child_process:execution')
tracingChannel.subscribe({
  start: () => {
    // eslint-disable-next-line no-console
    console.log('METHOD_INSTRUMENTED')
  }
})

execFileSync('ls')
