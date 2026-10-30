'use strict'

require('dd-trace').init({
  service: 'sum-service-tests',
})

const MochaPackage = require('mocha')
const Mocha = MochaPackage.default ?? MochaPackage

async function main () {
  const mocha = new Mocha()

  mocha.addFile(require.resolve('./sum-wrong-init-test.js'))

  await new Promise((resolve, reject) => {
    mocha.run(failures => {
      if (failures > 0) {
        reject(new Error(`${failures} test(s) failed.`))
      } else {
        resolve()
      }
    })
  })
}

main().catch(() => {
  process.exit(1)
})
