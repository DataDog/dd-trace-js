'use strict'

const fs = require('fs-extra')
const path = require('path')
const { deriveIdsFromNpmName } = require('./lib/utils')
const { lintGeneratedFile } = require('./lib/linting')
const { generateInstrumentationFile } = require('./lib/instrumentation')
const { updateHooksRegistry } = require('./lib/hooks')
const { updateDocsAndTypes } = require('./lib/docs')
const { scaffoldPluginPackage, updateDdTracePluginsIndex } = require('./lib/plugin')
const { addSimpleCIJob } = require('./lib/ci')
const { writeTestStub } = require('./lib/tests')

// Core method verbs we prioritize when scaffolding wrappers, category-aware
const CATEGORY_CORE_METHODS = {
  db: new Set([
    'connect', 'disconnect', 'query', 'execute', 'send', 'sendcommand', 'sendCommand', 'multi', 'pipeline'
  ]),
  web: new Set([
    'request', 'listen', 'handle', 'render'
  ]),
  http: new Set([
    'request', 'fetch', 'get', 'post', 'use', 'method'
  ]),
  messaging: new Set([
    'produce', 'publish', 'send', 'enqueue', 'add', 'consume', 'subscribe', 'on', 'process', 'run'
  ]),
  cache: new Set([
    'command', 'get', 'set', 'del'
  ]),
  other: new Set([
    'request', 'execute', 'send'
  ])
}

// moved to ./lib/utils

function selectTargets (report) {
  const seen = new Set()
  const out = []
  const category = report.category || 'other'
  const core = CATEGORY_CORE_METHODS[category] || CATEGORY_CORE_METHODS.other
  for (const t of report.targets || []) {
    if (!t || !t.function_name) continue
    const key = `${t.module || report.library_name}|${t.export_name}|${t.function_name}`
    if (seen.has(key)) continue
    const verb = t.function_name.toLowerCase()
    if (!core.has(verb)) continue
    seen.add(key)
    out.push({ ...t })
  }
  return out
}

async function scaffoldProject (reportPath, integrationNameArg, language, outputDir) {
  console.log(`Scaffolding ${integrationNameArg} integration using report: ${reportPath}`)

  const repoRoot = path.resolve(path.join(__dirname, '..', '..', '..'))

  const reportContent = await fs.readFile(path.resolve(reportPath), 'utf8')
  const report = JSON.parse(reportContent)
  if (!report.targets || !Array.isArray(report.targets)) {
    throw new Error('Invalid analysis report: missing or invalid targets array')
  }

  const npmName = report.library_name
  const testExamples = report.test_examples
    ? { ...report.test_examples, similar_integration: report.similar_integration || null }
    : null
  const { integrationId, typesId } = deriveIdsFromNpmName(npmName)
  const selected = selectTargets(report)
  const moduleNames = new Set([npmName])
  for (const t of selected) if (t.module) moduleNames.add(t.module)

  // 1) Create instrumentation file under repo
  const instrDir = path.join(repoRoot, 'packages', 'datadog-instrumentations', 'src')
  await fs.ensureDir(instrDir)
  const instrFile = path.join(instrDir, `${integrationId}.js`)
  if (!await fs.pathExists(instrFile)) {
    const content = generateInstrumentationFile({
      npmName,
      integrationId,
      selected,
      category: report.category,
      versionAnalysis: report.version_analysis,
      report
    })
    await fs.writeFile(instrFile, content)
    await lintGeneratedFile(instrFile, 'javascript')
  }

  // 2) Update hooks registry
  const hooksFile = path.join(instrDir, 'helpers', 'hooks.js')
  await updateHooksRegistry(hooksFile, integrationId, Array.from(moduleNames))

  // 3) Update docs and types
  await updateDocsAndTypes(repoRoot, { integrationId, typesId })

  // 4) Create plugin package and update dd-trace registry
  await scaffoldPluginPackage(repoRoot, integrationId, {
    category: report.category,
    subcategory: report.subcategory,
    report,
    capabilities: report.capabilities || null
  })
  await updateDdTracePluginsIndex(repoRoot, integrationId)

  // 5) Add simple CI job
  const ciFile = path.join(repoRoot, '.github', 'workflows', 'apm-integrations.yml')
  const needsServices = report.category === 'messaging' || report.category === 'db'
  await addSimpleCIJob(ciFile, integrationId, { needsServices })

  // 6) Add basic test stub under plugin package
  await writeTestStub(repoRoot, integrationId, npmName, testExamples, report.category)

  return repoRoot
}

function generateIndexFile (report, integrationName) {
  const targets = report.targets

  const imports = targets.map(target => {
    // TODO: Generate proper import statements based on target analysis
    return `// TODO: Import ${target.export_name} from the target library`
  }).filter((v, i, a) => a.indexOf(v) === i) // Remove duplicates

  const wrappers = targets.map(target => {
    const methodName = target.function_name
    const exportName = target.export_name

    return `
function wrap${methodName.charAt(0).toUpperCase() + methodName.slice(1)} (original) {
  return function wrapped${methodName.charAt(0).toUpperCase() + methodName.slice(1)} () {
    // TODO: AI - Add tracing logic here
    console.log('Calling ${methodName} on ${exportName}')
    return original.apply(this, arguments)
  }
}`
  })

  const hooks = targets.map(target => {
    const methodName = target.function_name
    const exportName = target.export_name

    return `
addHook({ name: '${report.library_name}' }, ${report.library_name} => {
  // TODO: AI - Instrument ${methodName} on ${exportName}
  // shimmer.wrap(${exportName}, '${methodName}', wrap${methodName.charAt(0).toUpperCase() + methodName.slice(1)})
  return ${report.library_name}
})`
  })

  return `'use strict'

const { addHook } = require('./helpers/instrument')
const shimmer = require('datadog-shimmer')

${imports.join('\n')}

${wrappers.join('\n')}

${hooks.join('\n')}
`
}

function generateTestFile (report, integrationName) {
  const targets = report.targets

  const testCases = targets.map(target => {
    const methodName = target.function_name
    const exportName = target.export_name

    return `
  describe('${methodName} method', () => {
    it('should create a span for ${methodName}', (done) => {
      // TODO: AI - Implement test for ${methodName} on ${exportName}
      done()
    })
  })`
  })

  return `'use strict'

const { expect } = require('chai')

describe('Plugin | ${integrationName}', () => {
  let tracer

  beforeEach(() => {
    tracer = require('dd-trace').init()
  })

  afterEach(() => {
    tracer.scope().active()?.finish()
  })

  ${testCases.join('\n')}
})
`
}

function generatePackageFile (report, integrationName) {
  return `{
  "name": "@datadog/plugin-${integrationName}",
  "version": "1.0.0",
  "description": "APM integration for ${report.library_name}",
  "main": "index.js",
  "scripts": {
    "test": "mocha test/**/*.spec.js"
  },
  "keywords": ["datadog", "apm", "tracing", "${integrationName}"],
  "author": "Datadog",
  "license": "Apache-2.0",
  "dependencies": {
    "dd-trace": "^6.0.0",
    "datadog-shimmer": "^1.0.0"
  },
  "devDependencies": {
    "mocha": "^10.0.0",
    "chai": "^4.0.0"
  }
}`
}

function generateReadmeFile (report, integrationName) {
  return `# Datadog APM Integration for ${report.library_name}

This integration provides automatic tracing for ${report.library_name}.

## Installation

\`\`\`bash
npm install @datadog/plugin-${integrationName}
\`\`\`

## Usage

The integration is automatically enabled when dd-trace is initialized:

\`\`\`javascript
const tracer = require('dd-trace').init()
\`\`\`

## Traced Operations

This integration traces the following operations:

${report.targets.map(target => `- \`${target.export_name}.${target.function_name}\``).join('\n')}

## Configuration

No additional configuration is required. The integration automatically instruments the library when it's loaded.
`
}

module.exports = { scaffoldProject }
