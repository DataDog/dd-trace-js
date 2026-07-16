import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)

const agentJsPath = path.resolve(
  path.dirname(__filename),
  '../packages/dd-trace/test/plugins/agent.js'
)

// `agent.js` is the source of truth for which non-prefixed envs the test
// rebuild gate tracks. Extracting the Set from its source (rather than
// `require()`ing the module) avoids pulling the test harness and the tracer
// into the lint process; the file structure is stable enough that a regex
// over the single-quoted entries is both cheap and clear when it breaks.
const SET_PATTERN = /const TRACKED_NON_PREFIX_ENV_NAMES = new Set\(\[([\s\S]*?)\]\)/

function readTrackedNames () {
  const source = fs.readFileSync(agentJsPath, 'utf8')
  const match = source.match(SET_PATTERN)
  if (!match) {
    throw new Error(
      `eslint-non-prefix-env-names: could not extract TRACKED_NON_PREFIX_ENV_NAMES from ${agentJsPath}. ` +
      'Update the regex in eslint-rules/eslint-non-prefix-env-names.mjs to match the new shape.'
    )
  }
  const names = new Set()
  for (const line of match[1].split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('//')) continue
    const entry = trimmed.match(/^'([^']+)',?$/)
    if (entry) names.add(entry[1])
  }
  return names
}

const tracked = readTrackedNames()

const SINGLE_NAME_FUNCTIONS = new Set(['getEnvironmentVariable', 'getValueFromEnvSources'])

function isPrefixed (name) {
  return name.startsWith('DD_') || name.startsWith('OTEL_') || name.startsWith('_DD_')
}

function getCalleeName (callee) {
  if (callee.type === 'Identifier') return callee.name
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
    return callee.property.name
  }
  return null
}

function literalName (node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) {
    return node.quasis[0].value.cooked
  }
  return null
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require every non-prefixed environment variable read in `src/` to be registered in ' +
        '`TRACKED_NON_PREFIX_ENV_NAMES` (packages/dd-trace/test/plugins/agent.js) so the test rebuild gate ' +
        'observes value changes across `agent.load()` calls.',
    },
    schema: [],
    messages: {
      missing:
        "Non-prefixed environment variable '{{name}}' is read via {{source}} but is missing from " +
        'TRACKED_NON_PREFIX_ENV_NAMES in packages/dd-trace/test/plugins/agent.js. Add it there so the ' +
        'agent.load gate rebuilds the tracer when its value changes between specs.',
    },
  },
  create (context) {
    function isKnown (name) {
      return isPrefixed(name) || tracked.has(name)
    }

    function checkLiteralArgument (callExpression, calleeName) {
      const name = literalName(callExpression.arguments[0])
      if (name === null || isKnown(name)) return
      context.report({
        node: callExpression.arguments[0],
        messageId: 'missing',
        data: { name, source: `${calleeName}()` },
      })
    }

    function checkDestructuredVariables (declarator) {
      // Only fires for: `const { FOO } = getEnvironmentVariables(...)` where the call does
      // not pass `internalOnly = true`. With `internalOnly = true`, the helper strips all
      // non-prefixed envs from the return value, so the destructure cannot read one even
      // if the developer wrote it.
      if (declarator.id.type !== 'ObjectPattern' || declarator.init?.type !== 'CallExpression') return
      if (getCalleeName(declarator.init.callee) !== 'getEnvironmentVariables') return
      const internalOnly = declarator.init.arguments[1]
      if (internalOnly?.type === 'Literal' && internalOnly.value === true) return
      for (const property of declarator.id.properties) {
        if (property.type !== 'Property' || property.computed) continue
        const key = property.key.type === 'Identifier' ? property.key.name : property.key.value
        if (typeof key !== 'string' || isKnown(key)) continue
        context.report({
          node: property.key,
          messageId: 'missing',
          data: { name: key, source: 'getEnvironmentVariables() destructure' },
        })
      }
    }

    return {
      CallExpression (node) {
        const calleeName = getCalleeName(node.callee)
        if (calleeName && SINGLE_NAME_FUNCTIONS.has(calleeName)) {
          checkLiteralArgument(node, calleeName)
        }
      },
      VariableDeclarator: checkDestructuredVariables,
    }
  },
}
