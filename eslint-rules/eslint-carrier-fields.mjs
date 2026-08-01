import { readFileSync } from 'node:fs'

// Read the runtime declarations so adding or renaming a field cannot make the verifier's header list drift.
const carrierSource = readFileSync(new URL('../packages/dd-trace/src/carrier.js', import.meta.url), 'utf8')
const propagationHeaders = new Set(
  [...carrierSource.matchAll(/\bdefineField\('([^']+)'/g)].map(([, name]) => name)
)
const fieldNames = new Set(
  [...carrierSource.matchAll(/\bconst (\w+) = defineField\(/g)].map(([, name]) => name)
)
const legacyBaggagePrefix = /\bconst legacyBaggagePrefix = '([^']+)'/.exec(carrierSource)?.[1]

if (propagationHeaders.size === 0 || legacyBaggagePrefix === undefined) {
  throw new Error('Unable to discover the propagation fields declared by packages/dd-trace/src/carrier.js')
}

/**
 * @param {import('estree').Identifier | import('estree').Expression | import('estree').Super} node
 * @returns {boolean}
 */
function isCarrierIdentifier (node) {
  return node.type === 'Identifier' && node.name.toLowerCase().endsWith('carrier')
}

/**
 * @param {import('estree').Identifier | import('estree').Expression | import('estree').Super} node
 * @returns {boolean}
 */
function isHeaderContainer (node) {
  if (isCarrierIdentifier(node)) return true
  let name
  if (node.type === 'Identifier') {
    name = node.name.toLowerCase()
  } else if (!node.computed && node.type === 'MemberExpression' && node.property.type === 'Identifier') {
    name = node.property.name.toLowerCase()
  } else {
    return false
  }
  return name.endsWith('header') || name.endsWith('headers') || name.endsWith('attributes') || name.endsWith('attrs')
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function isPropagationHeader (name) {
  return propagationHeaders.has(name) || name.startsWith(legacyBaggagePrefix)
}

/**
 * @param {import('estree').MemberExpression} node
 * @returns {string | undefined}
 */
function getMemberName (node, resolveString) {
  if (!node.computed && node.property.type === 'Identifier') return node.property.name
  if (node.computed) return resolveString(node.property)
}

/**
 * @param {import('estree').Property} node
 * @returns {string | undefined}
 */
function getPropertyName (node, resolveString) {
  if (!node.computed && node.key.type === 'Identifier') return node.key.name
  return resolveString(node.key)
}

/**
 * @param {import('estree').CallExpression['callee']} node
 * @param {Set<string>} carrierFieldIdentifiers
 * @returns {boolean}
 */
function isAttachedFieldCall (node, carrierFieldIdentifiers) {
  if (node.type !== 'MemberExpression') return false
  if (node.object.type === 'Identifier') return carrierFieldIdentifiers.has(node.object.name)
  return node.object.type === 'MemberExpression' && node.object.property.type === 'Identifier' &&
    (fieldNames.has(node.object.property.name) || node.object.property.name === 'legacyBaggage')
}

/**
 * @param {import('estree').Node} node
 * @returns {boolean}
 */
function isCarrierModuleRequire (node) {
  if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier' || node.callee.name !== 'require') {
    return false
  }
  const [source] = node.arguments
  return source?.type === 'Literal' && typeof source.value === 'string' &&
    /(?:^|\/)carrier(?:\.js)?$/.test(source.value)
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require propagation carrier fields to own their wire name and repeat-value policy.',
    },
    messages: {
      useCarrierField: 'Use the matching named operation from carrier.js instead of accessing this header directly.',
      noDirectCarrierAccess: 'Pass the carrier through a named carrier operation instead of accessing it directly.',
      useDirectCarrierOperation: 'Import the named carrier operation directly from carrier.js.',
      aliasCarrierOperation: 'Use the carrier operation\'s exported name without a local alias.',
    },
    schema: [{
      type: 'object',
      properties: {
        requireDirectOperations: { type: 'boolean' },
        strictCarrierIdentifiers: { type: 'boolean' },
      },
      additionalProperties: false,
    }],
  },

  /**
   * @param {import('eslint').Rule.RuleContext} context
   * @returns {import('eslint').Rule.RuleListener}
   */
  create (context) {
    const sourceCode = context.sourceCode
    const carrierFunctions = new Set()
    const carrierFieldIdentifiers = new Set()
    const carrierModuleIdentifiers = new Set()
    const requireDirectOperations = context.options[0]?.requireDirectOperations === true
    const strictCarrierIdentifiers = context.options[0]?.strictCarrierIdentifiers === true

    /**
     * @param {import('estree').Node} node
     * @returns {boolean}
     */
    function isCarrierModuleReference (node) {
      return isCarrierModuleRequire(node) ||
        (node.type === 'Identifier' && carrierModuleIdentifiers.has(node.name))
    }

    /**
     * @param {import('estree').Node} node
     * @param {Set<import('estree').Node>} [seen]
     * @returns {string | undefined}
     */
    function resolveString (node, seen = new Set()) {
      if (node.type === 'Literal' && typeof node.value === 'string') return node.value
      if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked
      if (node.type !== 'Identifier' || seen.has(node)) return

      seen.add(node)
      let scope = sourceCode.getScope(node)
      while (scope) {
        const variable = scope.set.get(node.name)
        const definition = variable?.defs.find(def => def.type === 'Variable' && def.node.init)
        if (definition) return resolveString(definition.node.init, seen)
        scope = scope.upper
      }
    }

    /**
     * @param {import('estree').VariableDeclarator} node
     * @returns {void}
     */
    function recordCarrierFunctions (node) {
      if (node.id.type !== 'ObjectPattern' || !node.init) return

      const fromFields = isCarrierModuleReference(node.init)
      const fromField = (node.init.type === 'Identifier' && carrierFieldIdentifiers.has(node.init.name)) ||
        (node.init.type === 'MemberExpression' && node.init.property.type === 'Identifier' &&
          (fieldNames.has(node.init.property.name) || node.init.property.name === 'legacyBaggage'))
      if (!fromFields && !fromField) return

      for (const property of node.id.properties) {
        if (property.type !== 'Property' || property.key.type !== 'Identifier') continue
        if (fromFields && (fieldNames.has(property.key.name) || property.key.name === 'legacyBaggage')) {
          if (property.value.type === 'Identifier') carrierFieldIdentifiers.add(property.value.name)
          if (property.value.type === 'ObjectPattern') {
            for (const method of property.value.properties) {
              if (method.type === 'Property' && method.value.type === 'Identifier') {
                carrierFunctions.add(method.value.name)
              }
            }
          }
        } else if (property.value.type === 'Identifier') {
          carrierFunctions.add(property.value.name)
        }
      }
    }

    /**
     * @param {import('estree').ObjectExpression} node
     * @returns {boolean}
     */
    function isCarrierObject (node) {
      const parent = node.parent
      if (parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
        return isHeaderContainer(parent.id)
      }
      if (parent.type === 'Property') {
        const name = getPropertyName(parent, resolveString)
        return name !== undefined && /(?:carrier|headers?|attributes?|attrs)$/i.test(name)
      }
      if (parent.type !== 'CallExpression' || parent.callee.type !== 'MemberExpression') return false
      const name = getMemberName(parent.callee, resolveString)
      return (name === 'inject' || name === 'extract') && parent.arguments.includes(node)
    }

    /**
     * @param {import('estree').Node} node
     * @param {'useCarrierField' | 'noDirectCarrierAccess'} messageId
     * @returns {void}
     */
    function report (node, messageId) {
      context.report({ node, messageId })
    }

    return {
      /**
       * @param {import('estree').MemberExpression} node
       * @returns {void}
       */
      MemberExpression (node) {
        const name = getMemberName(node, resolveString)
        const carrierObject = isCarrierIdentifier(node.object)

        if (name && isPropagationHeader(name) && (node.computed || isHeaderContainer(node.object))) {
          report(node, 'useCarrierField')
        } else if (strictCarrierIdentifiers && carrierObject) {
          report(node, 'noDirectCarrierAccess')
        }
      },

      /**
       * @param {import('estree').Property} node
       * @returns {void}
       */
      'ObjectExpression > Property' (node) {
        const name = getPropertyName(node, resolveString)
        if (name && isPropagationHeader(name) && (name.includes('-') || isCarrierObject(node.parent))) {
          report(node, 'useCarrierField')
        }
      },

      /**
       * @param {import('estree').BinaryExpression} node
       * @returns {void}
       */
      BinaryExpression (node) {
        if (node.operator === 'in') {
          if (node.left.type === 'Literal' && typeof node.left.value === 'string' &&
              isPropagationHeader(node.left.value)) {
            report(node, 'useCarrierField')
          } else if (strictCarrierIdentifiers && isCarrierIdentifier(node.right)) {
            report(node, 'noDirectCarrierAccess')
          }
        }
      },

      /**
       * @param {import('estree').CallExpression} node
       * @returns {void}
       */
      CallExpression (node) {
        const callsCarrierModuleMember = node.callee.type === 'MemberExpression' &&
          isCarrierModuleReference(node.callee.object)
        if (requireDirectOperations &&
            (callsCarrierModuleMember || isAttachedFieldCall(node.callee, carrierFieldIdentifiers))) {
          report(node, 'useDirectCarrierOperation')
          return
        }
        if (!strictCarrierIdentifiers || node.callee.type === 'Super') return
        if (node.callee.type === 'MemberExpression' && node.callee.object.type === 'ThisExpression') return
        if (node.callee.type === 'Identifier' && carrierFunctions.has(node.callee.name)) return

        for (const argument of node.arguments) {
          if (argument.type !== 'SpreadElement' && isCarrierIdentifier(argument)) {
            report(argument, 'noDirectCarrierAccess')
          }
        }
      },

      /**
       * @param {import('estree').SpreadElement} node
       * @returns {void}
       */
      SpreadElement (node) {
        if (strictCarrierIdentifiers && isCarrierIdentifier(node.argument)) {
          report(node, 'noDirectCarrierAccess')
        }
      },

      /**
       * @param {import('estree').VariableDeclarator} node
       * @returns {void}
       */
      VariableDeclarator (node) {
        if (node.id.type === 'Identifier' && node.init && isCarrierModuleRequire(node.init)) {
          carrierModuleIdentifiers.add(node.id.name)
        }
        if (node.id.type === 'ObjectPattern' && node.init && isCarrierModuleReference(node.init)) {
          for (const property of node.id.properties) {
            if (property.type === 'Property' && property.key.type === 'Identifier' &&
                property.value.type === 'Identifier' && property.key.name !== property.value.name) {
              context.report({ node: property, messageId: 'aliasCarrierOperation' })
            }
          }
        }
        if (node.id.type === 'Identifier' && node.init?.type === 'MemberExpression' &&
            isCarrierModuleReference(node.init.object)) {
          context.report({ node, messageId: 'aliasCarrierOperation' })
        }
        if (node.id.type === 'Identifier' && node.init?.type === 'MemberExpression' &&
            node.init.property.type === 'Identifier' &&
            (fieldNames.has(node.init.property.name) || node.init.property.name === 'legacyBaggage')) {
          carrierFieldIdentifiers.add(node.id.name)
        }
        recordCarrierFunctions(node)
        if (strictCarrierIdentifiers && node.id.type === 'ObjectPattern' && node.init &&
            isCarrierIdentifier(node.init)) {
          report(node, 'noDirectCarrierAccess')
        }
      },
    }
  },
}
