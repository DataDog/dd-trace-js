'use strict'

async function main() {
  const { startVitest } = await import('vitest/node')

  return startVitest(
    'test',
    [],
    { watch: false },
    {},
    {}
  )
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
