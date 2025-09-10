'use strict'

/**
 * Complete File Specifications for APM Integration Scaffolding
 *
 * This file codifies EXACTLY what files need to be created/modified for each integration
 * and WHERE in each file the changes should be made. This prevents missing critical files.
 */

const REQUIRED_FILES = {
  // 1. CI/CD Integration
  CI_WORKFLOW: {
    path: '.github/workflows/apm-integrations.yml',
    type: 'yaml_job_insertion',
    description: 'Add CI test job for the integration',
    insertionPoint: 'alphabetical_job_insertion',
    required: true
  },

  // 2. Documentation Files
  API_DOCS: {
    path: 'docs/API.md',
    type: 'html_anchor_insertion',
    description: 'Add HTML anchor for integration documentation',
    insertionPoint: 'alphabetical_in_h5_list',
    required: true
  },

  REDIRECT_SCRIPT: {
    path: 'docs/add-redirects.sh',
    type: 'array_insertion',
    description: 'Add integration to redirect script array',
    insertionPoint: 'plugins_array_alphabetical',
    required: true
  },

  TEST_DEFINITIONS: {
    path: 'docs/test.ts',
    type: 'tracer_use_insertion',
    description: 'Add TypeScript test usage example',
    insertionPoint: 'before_winston_tracer_use',
    required: true
  },

  // 3. TypeScript Definitions
  MAIN_TYPES: {
    path: 'index.d.ts',
    type: 'dual_interface_insertion',
    description: 'Add TypeScript interface definitions',
    insertionPoints: {
      plugins_interface: 'alphabetical_in_plugins_interface',
      tracer_namespace: 'alphabetical_in_tracer_namespace'
    },
    required: true
  },

  // 4. Hook Registration
  HOOKS_REGISTRY: {
    path: 'packages/datadog-instrumentations/src/helpers/hooks.js',
    type: 'module_exports_insertion',
    description: 'Register instrumentation hook loader',
    insertionPoint: 'alphabetical_in_module_exports',
    required: true
  },

  // 5. Plugin Registry (already working)
  PLUGIN_REGISTRY: {
    path: 'packages/dd-trace/src/plugins/index.js',
    type: 'getter_insertion',
    description: 'Register plugin in main registry',
    insertionPoint: 'alphabetical_in_module_exports',
    required: true,
    status: 'implemented'
  },

  // 6. Instrumentation File (already working)
  INSTRUMENTATION_FILE: {
    path: 'packages/datadog-instrumentations/src/{integration}.js',
    type: 'new_file_creation',
    description: 'Create instrumentation hooks file',
    required: true,
    status: 'implemented'
  },

  // 7. Plugin Package (already working)
  PLUGIN_PACKAGE: {
    path: 'packages/datadog-plugin-{integration}/',
    type: 'directory_creation',
    description: 'Create complete plugin package',
    required: true,
    status: 'implemented'
  }
}

/**
 * Integration Type Specifications
 * Different integration types need different CI services and TypeScript interfaces
 */
const INTEGRATION_TYPES = {
  messaging: {
    services: ['redis'],
    typescript_interface: 'Instrumentation', // Could be MessagingClient/MessagingServer
    description_template: 'message queue library'
  },
  database: {
    services: [], // Most DBs don't need services in CI
    typescript_interface: 'Instrumentation',
    description_template: 'database client library'
  },
  cache: {
    services: ['redis'],
    typescript_interface: 'Instrumentation',
    description_template: 'caching library'
  },
  'http-client': {
    services: [],
    typescript_interface: 'HttpClient',
    description_template: 'HTTP client library'
  },
  'http-server': {
    services: [],
    typescript_interface: 'WebFramework',
    description_template: 'web framework'
  },
  web: {
    services: [],
    typescript_interface: 'WebFramework',
    description_template: 'web framework'
  },
  cloud: {
    services: [],
    typescript_interface: 'Instrumentation',
    description_template: 'cloud service client'
  },
  library: {
    services: [],
    typescript_interface: 'Instrumentation',
    description_template: 'library'
  }
}

/**
 * File Content Templates and Insertion Logic
 */
const FILE_GENERATORS = {

  /**
   * Generate CI workflow job (matches exact format from undici commit)
   */
  generateCIJob (integrationName, category) {
    const typeSpec = INTEGRATION_TYPES[category] || INTEGRATION_TYPES.library
    const services = typeSpec.services

    let job = `  ${integrationName}:
    runs-on: ubuntu-latest
    env:
      PLUGINS: ${integrationName}`

    if (services.length > 0) {
      job += `
      SERVICES: ${services.join(',')}`

      job += `
    services:`

      services.forEach(service => {
        if (service === 'redis') {
          job += `
      redis:
        image: redis:6.2-alpine
        ports:
          - 6379:6379`
        }
        // Add other services as needed
      })
    }

    job += `
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/testagent/start
      - uses: ./.github/actions/node/setup
      - run: yarn install
      - uses: ./.github/actions/node/oldest
      - run: yarn test:plugins:ci
      - uses: ./.github/actions/node/latest
      - run: yarn test:plugins:ci
      - if: always()
        uses: ./.github/actions/testagent/logs
      - uses: codecov/codecov-action@v3

`
    return job
  },

  /**
   * Generate API docs anchor and plugin list entry
   */
  generateAPIAnchor (integrationName) {
    return `<h5 id="${integrationName}"></h5>`
  },

  generateAPIPluginListEntry (integrationName) {
    return `* [${integrationName}](./interfaces/export_.plugins.${integrationName.replace(/-/g, '_')}.html)`
  },

  /**
   * Generate redirect script entry
   */
  generateRedirectEntry (integrationName) {
    return `  "${integrationName}"`
  },

  /**
   * Generate TypeScript test usage
   */
  generateTestUsage (integrationName) {
    return `tracer.use('${integrationName}');`
  },

  /**
   * Generate TypeScript interface definitions
   */
  generateTypeScriptInterfaces (integrationName, category, packageName) {
    const typeSpec = INTEGRATION_TYPES[category] || INTEGRATION_TYPES.library
    const interfaceType = typeSpec.typescript_interface
    const description = typeSpec.description_template

    return {
      pluginsInterface: `  "${integrationName}": tracer.plugins.${integrationName.replace(/-/g, '_')};`,
      tracerNamespace: `    /**
     * This plugin automatically instruments the
     * [${integrationName}](https://github.com/npmjs/package/${packageName}) ${description}.
     */
    interface ${integrationName.replace(/-/g, '_')} extends ${interfaceType} {}`
    }
  },

  /**
   * Generate hooks registry entry
   */
  generateHooksEntry (integrationName) {
    return `  ${integrationName}: () => require('../${integrationName}'),`
  }
}

/**
 * File Insertion Points - WHERE to add content in each file
 */
const INSERTION_POINTS = {

  /**
   * Find insertion point in CI workflow (before bunyan job, alphabetical)
   */
  findCIInsertionPoint (content, integrationName) {
    // Find jobs section and insert alphabetically
    const jobsMatch = content.match(/^jobs:\s*$/m)
    if (!jobsMatch) throw new Error('Could not find jobs section in CI workflow')

    const lines = content.split('\n')
    const jobsLineIndex = lines.findIndex(line => line.trim() === 'jobs:')

    // Find alphabetical insertion point
    for (let i = jobsLineIndex + 1; i < lines.length; i++) {
      const line = lines[i]
      const jobMatch = line.match(/^ {2}([a-z-]+):$/)
      if (jobMatch && jobMatch[1] > integrationName) {
        return { lineIndex: i, indent: '  ' }
      }
    }

    // If not found, insert before last job (usually 'when:')
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].match(/^ {2}[a-z-]+:$/)) {
        return { lineIndex: i, indent: '  ' }
      }
    }

    throw new Error('Could not find insertion point in CI workflow')
  },

  /**
   * Find insertion points in API docs (alphabetical in both h5 list and plugin list)
   */
  findAPIDocsInsertionPoints (content, integrationName) {
    const lines = content.split('\n')
    const points = {}

    // Find h5 anchor insertion point
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const h5Match = line.match(/^<h5 id="([^"]+)"><\/h5>$/)
      if (h5Match && h5Match[1] > integrationName) {
        points.h5Anchor = { lineIndex: i, indent: '' }
        break
      }
    }

    // Find plugin list insertion point (in "Available Plugins" section)
    let inPluginsList = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      if (line.includes('Available Plugins')) {
        inPluginsList = true
        continue
      }

      if (inPluginsList) {
        const pluginMatch = line.match(/^\* \[([^\]]+)\]/)
        if (pluginMatch && pluginMatch[1] > integrationName) {
          points.pluginList = { lineIndex: i, indent: '' }
          break
        }
      }
    }

    if (!points.h5Anchor || !points.pluginList) {
      throw new Error('Could not find insertion points in API docs')
    }

    return points
  },

  /**
   * Find insertion point in redirect script (alphabetical in plugins array)
   */
  findRedirectInsertionPoint (content, integrationName) {
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const pluginMatch = line.match(/^ {2}"([^"]+)"$/)
      if (pluginMatch && pluginMatch[1] > integrationName) {
        return { lineIndex: i, indent: '  ' }
      }
    }

    throw new Error('Could not find insertion point in redirect script')
  },

  /**
   * Find insertion point in TypeScript test file
   */
  findTestInsertionPoint (content, integrationName) {
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const tracerMatch = line.match(/^tracer\.use\('([^']+)'\);$/)
      if (tracerMatch && tracerMatch[1] > integrationName) {
        return { lineIndex: i, indent: '' }
      }
    }

    throw new Error('Could not find insertion point in TypeScript test file')
  },

  /**
   * Find insertion points in main TypeScript definitions
   */
  findTypeScriptInsertionPoints (content, integrationName) {
    const lines = content.split('\n')
    const points = {}

    // Find Plugins interface insertion point
    let inPluginsInterface = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      if (line.includes('interface Plugins {')) {
        inPluginsInterface = true
        continue
      }

      if (inPluginsInterface && line.includes('}')) {
        points.pluginsInterface = { lineIndex: i, indent: '  ' }
        inPluginsInterface = false
        break
      }

      if (inPluginsInterface) {
        const pluginMatch = line.match(/^ {2}"([^"]+)":/)
        if (pluginMatch && pluginMatch[1] > integrationName) {
          points.pluginsInterface = { lineIndex: i, indent: '  ' }
          inPluginsInterface = false
          break
        }
      }
    }

    // Find tracer namespace insertion point
    let inTracerNamespace = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      if (line.includes('declare namespace tracer {')) {
        inTracerNamespace = true
        continue
      }

      if (inTracerNamespace) {
        const interfaceMatch = line.match(/^ {4}interface ([a-z_]+) extends/)
        if (interfaceMatch && interfaceMatch[1] > integrationName.replace(/-/g, '_')) {
          points.tracerNamespace = { lineIndex: i, indent: '    ' }
          break
        }
      }
    }

    return points
  },

  /**
   * Find insertion point in hooks registry
   */
  findHooksInsertionPoint (content, integrationName) {
    const lines = content.split('\n')

    // Find module.exports object
    let inModuleExports = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      if (line.includes('module.exports = {')) {
        inModuleExports = true
        continue
      }

      if (inModuleExports && line.includes('}')) {
        return { lineIndex: i, indent: '  ' }
      }

      if (inModuleExports) {
        const hookMatch = line.match(/^ {2}([a-z-]+):/)
        if (hookMatch && hookMatch[1] > integrationName) {
          return { lineIndex: i, indent: '  ' }
        }
      }
    }

    throw new Error('Could not find insertion point in hooks registry')
  }
}

module.exports = {
  REQUIRED_FILES,
  INTEGRATION_TYPES,
  FILE_GENERATORS,
  INSERTION_POINTS
}
