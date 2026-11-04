'use strict'

const MochaPackage = require('mocha')
const Mocha = MochaPackage.default ?? MochaPackage

function run (index) {
  process.env.MOCHA_REVIEW_RUN = String(index)
  const mocha = new Mocha({ parallel: true, jobs: 2 })
  mocha.addFile(require.resolve('./test-management/mocha-review-repeated'))
  return new Promise(resolve => mocha.run(resolve))
}

run(1).then(async first => {
  const second = await run(2)
  process.stdout.write(`failures: ${first},${second}\n`)
  process.exitCode = first || second ? 1 : 0
})
