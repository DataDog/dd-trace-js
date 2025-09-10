'use strict'

const fs = require('fs-extra')
const path = require('path')
const { lintGeneratedFile } = require('./linting')
const { detectCategory } = require('./utils')

function getCategoryExample (category, npmName) {
  switch (category) {
    case 'messaging':
      return {
        setupLines: [
          '// Example producer/consumer setup (messaging)',
          'const mod = require(`../../../versions/' + npmName + '@${' + 'version' + '}`).get()',
          "const queueName = 'dd-trace-test'",
          "const connection = { connection: { url: process.env.REDIS_URL || 'redis://127.0.0.1:6379' } }",
          'const queue = new Queue(queueName, connection)',
          'const queueEvents = new QueueEvents(queueName, connection)',
          'await queueEvents.waitUntilReady()'
        ],
        actionsLines: [
          'if (!process.env.DD_EXAMPLE_RUN) return',
          'const worker = new Worker(queueName, async job => 1, connection)',
          'await worker.waitUntilReady()',
          "const waitCompleted = () => new Promise(resolve => worker.once('completed', resolve))",
          "const job = await queue.add('test', { n: 1 })",
          'await waitCompleted()',
          'await worker.close()',
          'await queueEvents.close()',
          'await queue.close()'
        ]
      }
    case 'db':
      return {
        setupLines: [
          '// Example DB setup',
          'const mod = require(`../../../versions/' + npmName + '@${' + 'version' + '}`).get()',
          '// TODO: Set up database client',
          '// const client = new mod.Client(/* connection */)',
          '// await client.connect()'
        ],
        actionsLines: [
          '// Basic module loading test',
          "expect(mod).to.be.an('object')",
          "expect(mod.createClient || mod.Client).to.be.a('function')",
          '// TODO: Add actual database integration tests',
          '// const client = mod.createClient(/* connection config */)',
          "// await client.query('SELECT 1')"
        ]
      }
    case 'web':
      return {
        setupLines: [
          '// Example web server setup',
          'const mod = require(`../../../versions/' + npmName + '@${' + 'version' + '}`).get()',
          'const app = mod()',
          "app.get('/', (req, res) => res.send('OK'))",
          'const server = app.listen(0)',
          'const port = server.address().port'
        ],
        actionsLines: [
          '// Methods of interest (request/route handling)',
          'if (!process.env.DD_EXAMPLE_RUN) return',
          'const axios = require(\'axios\')',
          'const res = await axios.get(`http://localhost:${port}/`)',
          "expect(res.data).to.equal('OK')",
          'server.close()'
        ]
      }
    case 'http':
      return {
        setupLines: [
          '// Example outbound HTTP setup (none required)'
        ],
        actionsLines: [
          '// Methods of interest (request/get/post)',
          "// await require('node:http').request(/* ... */)"
        ]
      }
    default:
      return { setupLines: [], actionsLines: [] }
  }
}

async function writeTestStub (repoRoot, integrationId, npmName, testExamples, category) {
  const pkgId = integrationId.replace(/\./g, '-')
  const dir = path.join(repoRoot, 'packages', `datadog-plugin-${pkgId}`, 'test')
  const file = path.join(dir, 'index.spec.js')
  await fs.ensureDir(dir)
  const versionName = npmName
  // Use analyzer examples if they're substantial, otherwise use category defaults
  const hasSubstantialExamples = testExamples && testExamples.setup_lines && testExamples.action_lines &&
    testExamples.setup_lines.some(line => line.includes('require(') || line.includes('new ') || line.includes('listen(')) &&
    testExamples.action_lines.some(line => line.includes('await ') && !line.includes('TODO'))

  const ex = hasSubstantialExamples
    ? { setupLines: testExamples.setup_lines, actionsLines: testExamples.action_lines }
    : getCategoryExample(category, npmName)

  // Hoist variables declared in setup/actions to describe scope
  let setupLines = ex.setupLines.slice()
  let actionsLines = ex.actionsLines.slice()
  const declaredVars = new Set()
  const varDeclRe = /^\s*(const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:=|$)/
  const notDestructureRe = /^\s*(const|let|var)\s*\{/
  for (const line of [...setupLines, ...actionsLines]) {
    if (notDestructureRe.test(line)) continue
    const m = line.match(varDeclRe)
    if (m && m[2]) declaredVars.add(m[2])
  }
  const hoistedDecl = Array.from(declaredVars).map(v => `let ${v}`)

  const replaceVarWithAssign = (line) => {
    if (notDestructureRe.test(line)) return line
    return line.replace(varDeclRe, (_s, keyword, name) => `${name} = `)
  }
  setupLines = setupLines.map(replaceVarWithAssign).map(line => line.replace(/;+$/, ''))
  actionsLines = actionsLines.map(replaceVarWithAssign).map(line => line.replace(/;+$/, ''))

  // Clean up spacing issues and remove incomplete declarations
  const cleanSpacing = (line) => {
    return line
      .replace(/\s+$/, '') // Remove trailing spaces
      .replace(/=\s{2,}/g, ' = ') // Fix multiple spaces after =
      .replace(/\s{2,}(?![^\S\n]*$)/g, ' ') // Replace multiple spaces with single (preserve indentation)
  }

  const isIncompleteDeclaration = (line) => {
    // Detect lines like "server = " with nothing after the equals
    return /^\s*\w+\s*=\s*$/.test(line)
  }

  setupLines = setupLines.map(cleanSpacing).filter(line => !isIncompleteDeclaration(line))
  actionsLines = actionsLines.map(cleanSpacing).filter(line => !isIncompleteDeclaration(line))

  // Messaging-specific niceties: rewrite Queue/Worker class refs to mod.* when present
  if (category === 'messaging') {
    setupLines = setupLines
      .filter(l => !/^\s*(const|let|var)\s*\{\s*Queue/.test(l))
      .map(l => l
        .replace(/new\s+Queue\s*\(/g, 'new mod.Queue(')
        .replace(/new\s+QueueEvents\s*\(/g, 'new mod.QueueEvents(')
      )
    actionsLines = actionsLines.map(l => l
      .replace(/new\s+Worker\s*\(/g, 'new mod.Worker(')
    )
  }

  const setupIndent = '          '
  const setupBlock = setupLines.length
    ? setupLines.map(l => setupIndent + l).join('\n')
    : setupIndent + '// TODO: require target module/version if needed'
  const actionsBlock = actionsLines.length
    ? actionsLines.map(l => setupIndent + l).join('\n')
    : setupIndent + '// TODO: call methods of interest for this category'

  const lines = []
  lines.push('\'use strict\'')
  lines.push('')
  lines.push("const { expect } = require('chai')")
  lines.push("const { describe, it, before, after, beforeEach, afterEach } = require('mocha')")
  lines.push('')
  lines.push("const agent = require('../../dd-trace/test/plugins/agent')")
  lines.push("const { withVersions } = require('../../dd-trace/test/setup/mocha')")
  lines.push('')
  lines.push("describe('Plugin', () => {")
  lines.push(`  describe('${integrationId}', () => {`)
  lines.push(`    withVersions('${integrationId}', '${versionName}', version => {`)
  lines.push('      beforeEach(() => {')
  lines.push("        require('../../dd-trace')")
  lines.push('      })')
  lines.push('')
  lines.push("      describe('without configuration', () => {")
  if (hoistedDecl.length) {
    lines.push('        ' + hoistedDecl.join('\n        '))
    lines.push('')
  }
  lines.push('        before(() => {')
  lines.push(`          return agent.load('${integrationId}')`)
  lines.push('        })')
  lines.push('')
  lines.push('        after(() => {')
  lines.push('          return agent.close({ ritmReset: false })')
  lines.push('        })')
  lines.push('')
  lines.push('        beforeEach(async () => {')
  lines.push(setupBlock)
  lines.push('        })')
  lines.push('')
  lines.push('        afterEach(async () => {')
  if (category === 'messaging') {
    lines.push('          // TODO: cleanup if needed')
  } else {
    lines.push('          // TODO: cleanup if needed')
  }
  lines.push('        })')
  lines.push('')
  lines.push("        it('should do automatic instrumentation', done => {")
  lines.push('          agent.assertSomeTraces(traces => {')
  lines.push("            expect(traces[0][0]).to.have.property('service')")
  lines.push("            expect(traces[0][0].meta).to.have.property('component')")
  lines.push('          })')
  lines.push('            .then(done)')
  lines.push('            .catch(done)')
  lines.push('        })')
  lines.push('')
  lines.push("        it('should exercise methods of interest', async () => {")
  lines.push(actionsBlock)
  lines.push('          // TODO: add minimal assertions if desired')
  lines.push('        })')
  lines.push('      })')
  lines.push('')
  lines.push('      // TODO: add custom test cases here')
  lines.push('    })')
  lines.push('  })')
  lines.push('})')
  lines.push('')

  const content = lines.join('\n')
  await fs.writeFile(file, content)

  // Lint the generated test file
  await lintGeneratedFile(file, 'javascript')
}

module.exports = { writeTestStub }
