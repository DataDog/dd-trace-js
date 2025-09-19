'use strict'

require('dd-trace').init({
  service: 'sum-service-tests',
})

const { runCLI } = require('jest')

async function main () {
  const projectRoot = process.cwd()

  await runCLI(
    {
      testMatch: ['**/sum-wrong-init-test.js'],
    },
    [projectRoot]
  )
}

main()
