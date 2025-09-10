'use strict'

const fs = require('fs-extra')
const path = require('path')
const { spawn } = require('child_process')
const { lintGeneratedFile } = require('./linting')

const { detectCategory, toPascalCase, getOperationForCategory } = require('./utils')

/**
 * Generate data extraction code for plugin that reads from context
 */
function generatePluginDataExtractionCode (target, integrationType) {
  if (!target.data_requirements || !target.data_requirements.breakdown) {
    return {
      extractionCode: '// TODO: Add data extraction logic',
      spanTags: []
    }
  }

  const { breakdown } = target.data_requirements
  const extractionLines = []
  const spanTags = []

  extractionLines.push('    // Set up args for the parent HttpClientPlugin to use')
  extractionLines.push('    const options = {}')
  extractionLines.push('    ')

  // Process critical and important data requirements
  for (const [priority, dataTypes] of Object.entries(breakdown)) {
    if (priority === 'optional') continue // Skip optional for now

    for (const [dataType, info] of Object.entries(dataTypes)) {
      if (!info.available || !info.dataSources || info.dataSources.length === 0) continue

      // Map data types to HttpClientPlugin expected option names
      let optionName = dataType
      if (dataType === 'host') {
        optionName = 'hostname'
      } else if (dataType === 'url') {
        optionName = 'url'
      } else if (dataType === 'method') {
        optionName = 'method'
      }

      extractionLines.push(`    // Extract ${dataType} (${priority}) from context`)
      extractionLines.push(`    if (ctx.${dataType}) {`)
      extractionLines.push(`      options.${optionName} = ctx.${dataType}`)
      extractionLines.push('    }')
      extractionLines.push('')

      spanTags.push({
        dataType,
        priority,
        optionName,
        source: info.dataSources[0]
      })
    }
  }

  extractionLines.push('    ctx.args = { options }')
  extractionLines.push('    ')
  extractionLines.push('    return super.bindStart(ctx)')

  return {
    extractionCode: extractionLines.length > 0
      ? extractionLines.join('\n')
      : '// TODO: Add data extraction logic based on analysis',
    spanTags
  }
}

/**
 * Generate data extraction code based on data requirements from analysis (DEPRECATED)
 */
function generateDataExtractionCode (target, integrationType) {
  if (!target.data_requirements || !target.data_requirements.breakdown) {
    return {
      extractionCode: '// TODO: Add data extraction logic',
      spanTags: []
    }
  }

  const { breakdown } = target.data_requirements
  const extractionLines = []
  const spanTags = []

  // Process critical and important data requirements
  for (const [priority, dataTypes] of Object.entries(breakdown)) {
    if (priority === 'optional') continue // Skip optional for now

    for (const [dataType, info] of Object.entries(dataTypes)) {
      if (!info.available || !info.dataSources || info.dataSources.length === 0) continue

      const primarySource = info.dataSources[0]
      const spanFields = info.spanFields || []

      if (spanFields.length === 0) continue

      const extractionCode = generateExtractionCodeForSource(primarySource, dataType)
      const spanField = spanFields[0] // Use primary span field

      if (extractionCode) {
        extractionLines.push(`    // Extract ${dataType} (${priority})`)
        extractionLines.push(`    ${extractionCode.declaration}`)
        extractionLines.push(`    if (${extractionCode.variable}) {`)
        extractionLines.push(`      span.setTag('${spanField}', ${extractionCode.variable})`)
        extractionLines.push('    }')
        extractionLines.push('')

        spanTags.push({
          dataType,
          priority,
          spanField,
          source: primarySource,
          extraction: extractionCode
        })
      }
    }
  }

  return {
    extractionCode: extractionLines.length > 0
      ? extractionLines.join('\n')
      : '// TODO: Add data extraction logic based on analysis',
    spanTags
  }
}

/**
 * Generate extraction code for a specific data source
 */
function generateExtractionCodeForSource (source, dataType) {
  switch (source.type) {
    case 'argument':
      return {
        declaration: `const ${dataType} = args[${source.position}]`,
        variable: dataType
      }

    case 'argument_property':
      return {
        declaration: `const ${dataType} = args[${source.position}] && args[${source.position}].${source.property}`,
        variable: dataType
      }

    case 'function_name':
      if (dataType === 'method') {
        return {
          declaration: `const ${dataType} = '${source.examples && source.examples[0] ? source.examples[0].split(' → ')[1] : 'GET'}'`,
          variable: dataType
        }
      }
      return {
        declaration: `const ${dataType} = ctx.methodName || '${dataType}'`,
        variable: dataType
      }

    case 'response_property':
      return {
        declaration: `const ${dataType} = ctx.result && ctx.result.${source.property}`,
        variable: dataType
      }

    case 'url_component':
      return {
        declaration: `const ${dataType} = args[0] && new URL(args[0]).${source.component}`,
        variable: dataType
      }

    case 'module_name':
      return {
        declaration: `const ${dataType} = '${source.examples && source.examples[0] ? source.examples[0].split(' → ')[1] : dataType}'`,
        variable: dataType
      }

    case 'constructed_url':
      return {
        declaration: `const ${dataType} = args[0] && (\`\${args[0].protocol || 'http'}://\${args[0].hostname}\${args[0].port ? ':' + args[0].port : ''}\${args[0].path || ''}\`)`,
        variable: dataType
      }

    default:
      return {
        declaration: `const ${dataType} = null // TODO: Extract from ${source.type}`,
        variable: dataType
      }
  }
}

async function scaffoldPluginPackage (repoRoot, integrationId, opts = {}) {
  const pluginPackageId = integrationId.replace(/\./g, '-')
  const dir = path.join(repoRoot, 'packages', `datadog-plugin-${pluginPackageId}`)
  const srcDir = path.join(dir, 'src')
  const indexFile = path.join(srcDir, 'index.js')
  await fs.ensureDir(srcDir)
  const className = toPascalCase(pluginPackageId)
  const category = opts.category || detectCategory(integrationId)
  const subcategory = opts.subcategory || null
  const report = opts.report || null

  if (category === 'messaging') {
    const compositeImport = 'const CompositePlugin = require(\'../../dd-trace/src/plugins/composite\')\n'
    const indexContent = `'use strict'\n\n${compositeImport}\nconst ProducerPlugin = require('./producer')\nconst ConsumerPlugin = require('./consumer')\n\nclass ${className}Plugin extends CompositePlugin {\n  static id = '${integrationId}'\n  static get plugins () {\n    return {\n      producer: ProducerPlugin,\n      consumer: ConsumerPlugin\n    }\n  }\n}\n\nmodule.exports = ${className}Plugin\n`
    await fs.writeFile(indexFile, indexContent)
    await lintGeneratedFile(indexFile, 'javascript')

    const producerFile = path.join(srcDir, 'producer.js')
    if (!await fs.pathExists(producerFile)) {
      const baseImport = 'const ProducerPlugin = require(\'../../dd-trace/src/plugins/producer\')\n'
      const producerContent = `'use strict'\n\n${baseImport}\nclass ${className}ProducerPlugin extends ProducerPlugin {\n  static id = '${integrationId}'\n  static operation = 'produce'\n}\n\nmodule.exports = ${className}ProducerPlugin\n`
      await fs.writeFile(producerFile, producerContent)
    }

    const consumerFile = path.join(srcDir, 'consumer.js')
    if (!await fs.pathExists(consumerFile)) {
      const baseImport = 'const ConsumerPlugin = require(\'../../dd-trace/src/plugins/consumer\')\n'
      const consumerContent = `'use strict'\n\n${baseImport}\nclass ${className}ConsumerPlugin extends ConsumerPlugin {\n  static id = '${integrationId}'\n  static operation = 'receive'\n}\n\nmodule.exports = ${className}ConsumerPlugin\n`
      await fs.writeFile(consumerFile, consumerContent)
    }

    return
  }
  // Determine base plugin based on category and subcategory
  let baseImport
  if (category === 'http') {
    if (subcategory === 'server') {
      baseImport = '../../datadog-plugin-router/src'
    } else {
      // Default to client for http category (subcategory === 'client' or null)
      baseImport = '../../datadog-plugin-http/src/client'
    }
  } else {
    const baseMap = {
      db: '../../dd-trace/src/plugins/database',
      web: '../../datadog-plugin-router/src',
      messaging: '../../dd-trace/src/plugins/producer',
      cache: '../../dd-trace/src/plugins/cache',
      other: '../../dd-trace/src/plugins/plugin'
    }
    baseImport = baseMap[category] || baseMap.other
  }
  let baseName
  if (baseImport.endsWith('/plugin')) {
    baseName = 'Plugin'
  } else if (baseImport.includes('datadog-plugin-router')) {
    baseName = 'RouterPlugin'
  } else if (baseImport.includes('datadog-plugin-http/src/client')) {
    baseName = 'HttpClientPlugin'
  } else {
    baseName = path.basename(baseImport)
  }

  const operation = getOperationForCategory(category)
  let body
  if (category === 'web') {
    // Web frameworks extend RouterPlugin and use addSub for request handling
    body = `\nclass ${className}Plugin extends ${baseName} {\n  static id = '${integrationId}'\n\n  constructor (...args) {\n    super(...args)\n\n    this.addSub('apm:${integrationId}:request:handle', ({ req }) => {\n      this.setFramework(req, '${integrationId}', this.config)\n    })\n  }\n}\n\nmodule.exports = ${className}Plugin\n`
  } else if (category === 'http') {
    if (subcategory === 'server') {
      // HTTP server plugins extend RouterPlugin and use addSub for request handling
      body = `\nclass ${className}Plugin extends ${baseName} {\n  static id = '${integrationId}'\n\n  constructor (...args) {\n    super(...args)\n\n    this.addSub('apm:${integrationId}:request:handle', ({ req }) => {\n      this.setFramework(req, '${integrationId}', this.config)\n    })\n  }\n}\n\nmodule.exports = ${className}Plugin\n`
    } else {
      // HTTP client plugins extend HttpClientPlugin and need custom prefix and bindStart
      let bindStartContent = `    // TODO: Convert ${integrationId} config to http client format\n    // const { args } = ctx\n    // const config = args[0] || {}\n    // ctx.args = { options: convertToHttpOptions(config) }`

      // Use data extraction if available from analysis
      if (report && report.targets && report.targets.length > 0) {
        const primaryTarget = report.targets[0]
        const dataExtraction = generatePluginDataExtractionCode(primaryTarget, 'http-client')
        if (dataExtraction.extractionCode && !dataExtraction.extractionCode.includes('TODO')) {
          bindStartContent = dataExtraction.extractionCode
        }
      }

      body = `\nclass ${className}Plugin extends ${baseName} {\n  static id = '${integrationId}'\n  static prefix = 'apm:${integrationId}:request'\n\n  bindStart (ctx) {\n${bindStartContent}\n  }\n}\n\nmodule.exports = ${className}Plugin\n`
    }
  } else {
    body = `\nclass ${className}Plugin extends ${baseName} {\n  static id = '${integrationId}'\n  static operation = '${operation}'\n}\n\nmodule.exports = ${className}Plugin\n`
  }
  const header = `'use strict'\n\nconst ${baseName} = require('${baseImport}')\n`
  let content = header + body

  // Enhance with LLM if available
  if (process.env.DD_AI_GATEWAY || process.env.OPENAI_API_KEY) {
    console.log(`Enhancing ${integrationId} plugin with LLM assistance...`)
    const enhancedContent = await enhancePluginWithLLM(integrationId, category, content, repoRoot)
    if (enhancedContent) {
      content = enhancedContent
      console.log('✅ Plugin enhanced with LLM assistance')
    }
  }

  await fs.writeFile(indexFile, content)
  await lintGeneratedFile(indexFile, 'javascript')
}

async function updateDdTracePluginsIndex (repoRoot, integrationId) {
  const file = path.join(repoRoot, 'packages', 'dd-trace', 'src', 'plugins', 'index.js')
  if (!await fs.pathExists(file)) return
  const src = await fs.readFile(file, 'utf8')
  if (src.includes(`get '${integrationId}'`)) return
  const start = src.indexOf('module.exports = {')
  const end = src.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return
  const before = src.slice(0, start)
  const inner = src.slice(start + 'module.exports = {'.length, end)
  const after = src.slice(end)
  const lines = inner.split('\n')
  const normalize = (key) => key.replace(/^["']|["']$/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')
  const getters = []
  for (let idx = 0; idx < lines.length; idx++) {
    const l = lines[idx]
    const m = l.match(/^\s*get\s+([^\s]+)\s*\(\)\s*\{\s*return\s+require\(([^)]+)\)\s*\}\s*,?\s*$/)
    if (m) getters.push({ idx, rawKey: m[1], req: m[2] })
  }
  const targetNorm = integrationId.toLowerCase()
  let insertIdx = -1
  for (const g of getters) {
    if (normalize(g.rawKey) > targetNorm) { insertIdx = g.idx; break }
  }
  const pluginPackageId = integrationId.replace(/\./g, '-')
  const reqPath = `'../../../datadog-plugin-${pluginPackageId}/src'`
  const newLine = `  get '${integrationId}' () { return require(${reqPath}) },`
  if (insertIdx === -1) lines.push(newLine)
  else lines.splice(insertIdx, 0, newLine)
  await fs.writeFile(file, before + 'module.exports = {' + lines.join('\n') + after)
}

async function enhancePluginWithLLM (integrationId, category, pluginCode, repoRoot) {
  try {
    // Get examples of similar plugins for context
    const similarExamples = await getSimilarPluginExamples(category, repoRoot)

    const system = `You are an expert Node.js APM instrumentation engineer. Your task is to enhance and fix generated plugin code for dd-trace integrations.

CONTEXT:
- Integration: ${integrationId}
- Category: ${category}
- This is a dd-trace plugin that extends existing base classes

REQUIREMENTS:
1. Fix any incorrect base class imports or extends
2. Ensure the plugin follows dd-trace patterns
3. Add proper methods if needed (bindStart, error, finish, etc.)
4. Use correct static properties (id, prefix, operation)
5. Follow the patterns shown in similar plugins
6. Remove any TODOs if you can implement them properly
7. Ensure imports are correct and classes exist

Similar plugin examples:
${similarExamples}

Return ONLY the corrected JavaScript code, no markdown or explanations.`

    const user = `Please fix and enhance this ${category} plugin code:

${pluginCode}`

    const response = await callLLMViaPython([
      { role: 'system', content: system },
      { role: 'user', content: user }
    ], 'openai/gpt-4o-mini', 800, 0.1)

    if (response && response.trim() && !response.includes('```')) {
      // Verify the enhanced code is valid
      if (await verifyPluginCode(response, repoRoot)) {
        return response.trim()
      }
    }
  } catch (error) {
    console.warn('LLM plugin enhancement failed:', error.message)
  }

  return null
}

async function getSimilarPluginExamples (category, repoRoot) {
  const examples = {
    http: ['fetch', 'undici'],
    web: ['express', 'fastify', 'koa'],
    db: ['mysql', 'pg', 'mongodb'],
    messaging: ['kafkajs', 'amqplib'],
    cache: ['redis', 'memcached']
  }

  const similarPlugins = examples[category] || []
  const exampleCode = []

  for (const pluginName of similarPlugins.slice(0, 2)) { // Limit to 2 examples
    try {
      const pluginPath = path.join(repoRoot, 'packages', `datadog-plugin-${pluginName}`, 'src', 'index.js')
      if (await fs.pathExists(pluginPath)) {
        const code = await fs.readFile(pluginPath, 'utf8')
        exampleCode.push(`// ${pluginName} plugin example:\n${code}`)
      }
    } catch (error) {
      // Skip if can't read
    }
  }

  return exampleCode.join('\n\n')
}

async function verifyPluginCode (code, repoRoot) {
  try {
    // Create a context with mock require and module for syntax checking
    const context = {
      require: (id) => {
        // Mock require - return empty objects/functions for syntax checking
        if (id.includes('router') || id.includes('http')) {
          return class MockPlugin {}
        }
        return {}
      },
      module: { exports: {} },
      exports: {},
      console: { log: () => {}, warn: () => {}, error: () => {} }
    }

    // Basic syntax check
    require('vm').runInNewContext(code, context, { timeout: 1000 })

    // Check for required patterns
    if (!code.includes('class ') || !code.includes('extends ') || !code.includes('module.exports')) {
      return false
    }

    return true
  } catch (error) {
    console.warn('Plugin code verification failed:', error.message)
    return false
  }
}

async function callLLMViaPython (messages, model, maxTokens = 600, temperature = 0.2) {
  return new Promise((resolve) => {
    const pythonScript = path.join(__dirname, '..', '..', '..', 'dd-apm-analyze', 'src', 'llm_bridge.py')
    const python = spawn('python3', [pythonScript], {
      stdio: ['pipe', 'pipe', 'pipe']
    })

    const input = JSON.stringify({
      messages,
      model,
      max_tokens: maxTokens,
      temperature
    })
    let output = ''
    let error = ''

    python.stdout.on('data', (data) => {
      output += data.toString()
    })

    python.stderr.on('data', (data) => {
      error += data.toString()
    })

    python.on('close', (code) => {
      if (code !== 0) {
        console.warn('Python LLM bridge failed:', error)
        resolve(null)
        return
      }

      try {
        const result = JSON.parse(output)
        if (result.success && result.content) {
          resolve(result.content)
        } else {
          console.warn('LLM call failed:', result.error)
          resolve(null)
        }
      } catch (parseError) {
        console.warn('Failed to parse LLM response:', parseError.message)
        resolve(null)
      }
    })

    python.stdin.write(input)
    python.stdin.end()
  })
}

module.exports = { scaffoldPluginPackage, updateDdTracePluginsIndex }
