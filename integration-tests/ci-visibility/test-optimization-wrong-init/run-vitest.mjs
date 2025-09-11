import tracer from 'dd-trace'
import { startVitest } from 'vitest/node'

// The tracer needs to be initialized both in the main process and in the worker process.
// This is normally taken care of by using NODE_OPTIONS, but we can't set
// flushInterval through an env var
tracer.init({
  flushInterval: 0
})

async function main () {
  return startVitest(
    'test',
    [],
    { watch: false },
    {},
    {}
  )
}

main().catch(() => {
  process.exit(1)
})
