'use strict'

function generateDocs (analysis, integrationName) {
  const packageName = analysis.package.name

  return {
    [`packages/datadog-plugin-${integrationName}/index.d.ts`]: generateTypeDefinitions(integrationName, packageName)
    // TODO: Add docs/API.md updates
    // TODO: Add docs/test.ts updates
    // TODO: Add docs/add-redirects.sh updates
  }
}

function generateTypeDefinitions (integrationName, packageName) {
  const className = integrationName.split('-').map(part =>
    part.charAt(0).toUpperCase() + part.slice(1)
  ).join('')

  return `import { Instrumentation } from '../dd-trace/src/plugins/instrumentation'

declare interface ${className} extends Instrumentation {
  // TODO: Add plugin-specific type definitions
}

declare const _default: ${className}

export = _default
`
}

module.exports = { generateDocs }
