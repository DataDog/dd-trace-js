import { readFileSync } from 'node:fs'

import { parseCarrierModel } from './carrier-model.mjs'

const carrierSource = readFileSync(new URL('../packages/dd-trace/src/carrier.js', import.meta.url), 'utf8')

const { legacyBaggagePrefix, propagationHeaders } = parseCarrierModel(carrierSource)

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
 * Short standard names are meaningful outside propagation, so only treat them
 * as carrier fields when the receiver establishes that context.
 *
 * @param {string} name
 * @param {import('estree').Identifier | import('estree').Expression | import('estree').Super} target
 * @returns {boolean}
 */
function isManagedHeaderAccess (name, target) {
  return isPropagationHeader(name) && (name.includes('-') || isHeaderContainer(target))
}

/**
 * @param {import('estree').MemberExpression} node
 * @param {(node: import('estree').Node) => string | undefined} resolveString
 * @returns {string | undefined}
 */
function getMemberName (node, resolveString) {
  if (!node.computed && node.property.type === 'Identifier') return node.property.name
  if (node.computed) return resolveString(node.property)
}

/**
 * @param {import('estree').Property} node
 * @param {(node: import('estree').Node) => string | undefined} resolveString
 * @returns {string | undefined}
 */
function getPropertyName (node, resolveString) {
  if (!node.computed && node.key.type === 'Identifier') return node.key.name
  return resolveString(node.key)
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
    const carrierModuleIdentifiers = new Set()
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
      if (node.id.type !== 'ObjectPattern' || !node.init || !isCarrierModuleReference(node.init)) return

      for (const property of node.id.properties) {
        if (property.type !== 'Property' || property.key.type !== 'Identifier') continue
        if (property.value.type === 'Identifier') carrierFunctions.add(property.value.name)
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
      if ((name === 'inject' || name === 'extract') && parent.arguments.includes(node)) return true
      return (name === 'assign' || name === 'defineProperties') && parent.callee.object.type === 'Identifier' &&
        parent.callee.object.name === 'Object' && parent.arguments[0] !== node &&
        parent.arguments[0]?.type !== 'SpreadElement' && isHeaderContainer(parent.arguments[0])
    }

    /**
     * @param {import('estree').CallExpression} node
     * @returns {{ target: import('estree').Expression, key: import('estree').Expression } | undefined}
     */
    function getReflectiveAccess (node) {
      if (node.callee.type !== 'MemberExpression' || node.callee.object.type === 'Super') return
      const method = getMemberName(node.callee, resolveString)
      if (method === 'hasOwnProperty') {
        const [key] = node.arguments
        if (!key || key.type === 'SpreadElement') return
        return { target: node.callee.object, key }
      }
      if (node.callee.object.type !== 'Identifier') return

      const owner = node.callee.object.name
      const isObjectAccess = owner === 'Object' && (method === 'hasOwn' || method === 'defineProperty' ||
        method === 'getOwnPropertyDescriptor')
      const isReflectAccess = owner === 'Reflect' && (method === 'has' || method === 'get' || method === 'set' ||
        method === 'deleteProperty' || method === 'defineProperty' || method === 'getOwnPropertyDescriptor')
      if (!isObjectAccess && !isReflectAccess) return

      const [target, key] = node.arguments
      if (!target || target.type === 'SpreadElement' || !key || key.type === 'SpreadElement') return
      return { target, key }
    }

    /**
     * @param {import('estree').ObjectPattern} pattern
     * @param {import('estree').Expression} target
     * @returns {boolean}
     */
    function checkObjectPattern (pattern, target) {
      let reported = false
      for (const property of pattern.properties) {
        if (property.type === 'RestElement') {
          if (strictCarrierIdentifiers && isCarrierIdentifier(target)) {
            report(property, 'noDirectCarrierAccess')
            reported = true
          }
          continue
        }

        const name = getPropertyName(property, resolveString)
        if (name && isManagedHeaderAccess(name, target)) {
          report(property, 'useCarrierField')
          reported = true
        } else if (strictCarrierIdentifiers && isCarrierIdentifier(target)) {
          report(property, 'noDirectCarrierAccess')
          reported = true
        }
      }
      return reported
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

        if (name && isManagedHeaderAccess(name, node.object)) {
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
        if (node.operator !== 'in') return

        const name = resolveString(node.left)
        if (name && isManagedHeaderAccess(name, node.right)) {
          report(node, 'useCarrierField')
        } else if (strictCarrierIdentifiers && isCarrierIdentifier(node.right)) {
          report(node, 'noDirectCarrierAccess')
        }
      },

      /**
       * @param {import('estree').CallExpression} node
       * @returns {void}
       */
      CallExpression (node) {
        const callsCarrierModuleMember = node.callee.type === 'MemberExpression' &&
          isCarrierModuleReference(node.callee.object)
        if (callsCarrierModuleMember) {
          report(node, 'useDirectCarrierOperation')
          return
        }

        const reflectiveAccess = getReflectiveAccess(node)
        if (reflectiveAccess) {
          const name = resolveString(reflectiveAccess.key)
          if (name && isManagedHeaderAccess(name, reflectiveAccess.target)) {
            report(node, 'useCarrierField')
          } else if (strictCarrierIdentifiers && isCarrierIdentifier(reflectiveAccess.target)) {
            report(node, 'noDirectCarrierAccess')
          }
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
       * @param {import('estree').AssignmentExpression} node
       * @returns {void}
       */
      AssignmentExpression (node) {
        if (node.left.type !== 'ObjectPattern') return
        const reported = checkObjectPattern(node.left, node.right)
        if (!reported && strictCarrierIdentifiers && isCarrierIdentifier(node.right)) {
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
        recordCarrierFunctions(node)
        if (node.id.type === 'ObjectPattern' && node.init) {
          const reported = checkObjectPattern(node.id, node.init)
          if (!reported && strictCarrierIdentifiers && isCarrierIdentifier(node.init)) {
            report(node, 'noDirectCarrierAccess')
          }
        }
      },
    }
  },
}
