'use strict'

const { loadConfiguration, runCucumber } = require('@cucumber/cucumber/api')

const completedMessage = 'programmatic Cucumber run completed'

async function main () {
  const { runConfiguration } = await loadConfiguration({
    file: false,
    provided: {
      paths: ['ci-visibility/cucumber-programmatic/features/pass.feature'],
      require: ['ci-visibility/cucumber-programmatic/features/support/steps.js'],
    },
  })
  const { success } = await runCucumber(runConfiguration)

  process.stdout.write(`${completedMessage}\n`)
  if (!success) process.exitCode = 1
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`)
  process.exitCode = 1
})
