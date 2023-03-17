// Script example usage: node sandbox.js cypress@10.1.0 assert@3.1.0 ...
const { createSandbox } = require('../helpers')

async function run () {
  const dependencies = process.argv.slice(2)
  const { folder } = await createSandbox(dependencies, true)
  console.log(folder)
}

run()
