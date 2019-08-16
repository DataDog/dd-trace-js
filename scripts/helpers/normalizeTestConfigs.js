const coalesce = require('koalas')

function normalizeTestConfigs (testConfigs, defaults) {
  const configs = []

  for (let i = 0; i < testConfigs.length; ++i) {
    const testConfig = testConfigs[i]

    const config = {
      name: coalesce(testConfig.name, defaults.name),
      integration: coalesce(testConfig.integration, defaults.integration),
      repo: coalesce(testConfig.repo, defaults.repo),
      branch: coalesce(testConfig.branch, defaults.branch),
      framework: coalesce(testConfig.framework, defaults.framework),
      env: coalesce(testConfig.env, defaults.env),
      setup: coalesce(testConfig.setup, defaults.setup)
    }

    if (config.framework === 'custom') {
      config.execTests = coalesce(testConfig.execTests, defaults.execTests)
    } else {
      config.args = coalesce(testConfig.args, defaults.args, '')
    }

    configs.push(config)
  }

  return configs
}

module.exports = normalizeTestConfigs
