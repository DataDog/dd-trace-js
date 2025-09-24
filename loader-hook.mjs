import * as iitm from 'import-in-the-middle/hook.mjs'
import hooks from './packages/datadog-instrumentations/src/helpers/hooks.js'
import { getEnvironmentVariables } from './packages/dd-trace/src/config-helper.js'

const { DD_IAST_SECURITY_CONTROLS_CONFIGURATION } = getEnvironmentVariables()

function initialize (data = {}) {
  const instrumentations = Object.keys(hooks)
  const securityControls = (DD_IAST_SECURITY_CONTROLS_CONFIGURATION || '')
    .split(';')
    .map(sc => sc.trim().split(':')[2])
    .filter(Boolean)
    .map(sc => sc.trim())

  data.include ??= []
  data.exclude ??= []
  data.exclude.push(
    /middle/,
    /langsmith/,
    /openai\/_shims/,
    /openai\/resources\/chat\/completions\/messages/,
    /openai\/agents-core\/dist\/shims/,
    /@anthropic-ai\/sdk\/_shims/
  )

  for (const moduleName of instrumentations) {
    data.include.push(new RegExp(`node_modules/${moduleName}`), moduleName)
    data.exclude.push(new RegExp(`node_modules/${moduleName}/node_modules`))
  }

  for (const subpath of securityControls) {
    data.include.push(new RegExp(subpath))
  }

  return iitm.initialize(data)
}

export { initialize }
export { load, getFormat, resolve, getSource } from 'import-in-the-middle/hook.mjs'
