'use strict'
import { startVitest } from 'vitest/node'

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
