'use strict'

const fs = require('fs').promises
const path = require('path')
const { generateMessagingInstrumentation } = require('../templates/messaging')

/**
 * Creates new instrumentation file in packages/datadog-instrumentations/src/
 * This creates a new file (not modifying existing)
 */
async function createInstrumentationFile (repoRoot, integrationId, packageName, analysis) {
  const filePath = path.join(repoRoot, 'packages', 'datadog-instrumentations', 'src', `${integrationId}.js`)

  const content = generateInstrumentationContent(packageName, integrationId, analysis)

  await fs.writeFile(filePath, content)
  console.log(`✓ Created instrumentation file: ${integrationId}.js`)

  return filePath
}

function generateInstrumentationContent (packageName, integrationId, analysis) {
  const category = analysis.category || 'library'

  // Category-aware instrumentation generation
  if (category === 'messaging') {
    return generateMessagingInstrumentation(integrationId, analysis)
  }

  // Default instrumentation for other categories
  const methods = analysis.methods || []

  return `'use strict'

const { addHook, channel } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

// TODO: Define appropriate channels for ${category} operations
const startCh = channel('apm:${integrationId}:operation:start')
const finishCh = channel('apm:${integrationId}:operation:finish')
const errorCh = channel('apm:${integrationId}:operation:error')

// Hook registration for main package
addHook({ name: '${packageName}', versions: ['>=0'] }, (mod) => {
  // TODO: Identify correct target object/prototype
  // Analysis found these methods: ${methods.map(m => m.name || m).join(', ')}
  
  ${generateMethodHooks(methods)}
  
  return mod
})

${generateMethodWrappers(methods, category)}

module.exports = {
  // Export for testing if needed
}
`
}

function generateMethodHooks (methods) {
  if (!methods.length) {
    return `// TODO: No methods found in analysis - manual investigation needed
  // Common patterns:
  // shimmer.wrap(mod.prototype, 'methodName', makeWrapMethod())
  // shimmer.wrap(mod, 'staticMethod', makeWrapMethod())`
  }

  return methods.map(method =>
    `// TODO: Hook ${method} method
  // shimmer.wrap(target, '${method}', makeWrap${capitalize(method)}())`
  ).join('\n  ')
}

function generateMethodWrappers (methods, category) {
  if (!methods.length) {
    return `// TODO: Implement wrapper functions based on ${category} patterns
// Example:
// function makeWrapMethod() {
//   return function wrapMethod(original) {
//     return function wrapped(...args) {
//       // Create span, call original, finish span
//       return original.apply(this, args)
//     }
//   }
// }`
  }

  return methods.map(method => `
// TODO: Implement ${method} wrapper
function makeWrap${capitalize(method)} () {
  return function wrap${capitalize(method)} (original) {
    return function wrapped (...args) {
      if (!startCh.hasSubscribers) {
        return original.apply(this, arguments)
      }
      
      // TODO: Extract operation details from args
      const ctx = { operation: '${method}' }
      
      return startCh.runStores(ctx, () => {
        try {
          const result = original.apply(this, arguments)
          finishCh.publish(ctx)
          return result
        } catch (error) {
          ctx.error = error
          errorCh.publish(ctx)
          throw error
        }
      })
    }
  }
}`).join('')
}

function capitalize (str) {
  return str.charAt(0).toUpperCase() + str.slice(1)
}

module.exports = { createInstrumentationFile }
