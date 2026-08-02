import { readFileSync } from 'node:fs'

import { parseCarrierModel } from './carrier-model.mjs'

const carrierSource = readFileSync(new URL('../packages/dd-trace/src/carrier.js', import.meta.url), 'utf8')

const { legacyBaggagePrefix, propagationHeaders } = parseCarrierModel(carrierSource)

/**
 * @typedef {object} CarrierWrite
 * @property {'write'} type
 * @property {import('eslint').Scope.Variable} variable
 * @property {import('estree').Node} expression
 * @property {boolean} preserve
 */

/**
 * @typedef {object} CarrierCheck
 * @property {'check' | 'return'} type
 * @property {import('estree').Node} expression
 * @property {import('estree').Node} node
 */

/**
 * @typedef {object} CarrierCall
 * @property {'call'} type
 * @property {import('estree').CallExpression} node
 */

/** @typedef {CarrierWrite | CarrierCheck | CarrierCall} CarrierEvent */

/**
 * @typedef {object} CodePathFrame
 * @property {import('estree').Node} node
 * @property {Set<import('eslint').CodePathSegment>} currentSegments
 * @property {Set<import('eslint').CodePathSegment>} segments
 * @property {Map<import('eslint').CodePathSegment, CarrierEvent[]>} events
 */

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
    const carrierReturningFunctions = new WeakSet()
    const codePathFrames = []
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
     * @returns {import('eslint').Scope.Variable | undefined}
     */
    function findVariable (node) {
      if (node.type !== 'Identifier') return

      let scope = sourceCode.getScope(node)
      while (scope) {
        const variable = scope.set.get(node.name)
        if (variable) return variable
        scope = scope.upper
      }
    }

    /**
     * @param {import('estree').Node} node
     * @param {Set<import('eslint').Scope.Variable>} taintedVariables
     * @returns {boolean}
     */
    function isCarrierReference (node, taintedVariables) {
      if (isCarrierIdentifier(node)) return true

      if (node.type === 'LogicalExpression') {
        return isCarrierReference(node.left, taintedVariables) ||
          isCarrierReference(node.right, taintedVariables)
      }
      if (node.type === 'ConditionalExpression') {
        return isCarrierReference(node.consequent, taintedVariables) ||
          isCarrierReference(node.alternate, taintedVariables)
      }
      const variable = findVariable(node)
      return variable !== undefined && taintedVariables.has(variable)
    }

    /**
     * @param {CarrierEvent} event
     * @returns {void}
     */
    function recordCodePathEvent (event) {
      const codePathFrame = codePathFrames[codePathFrames.length - 1]
      for (const segment of codePathFrame.currentSegments) {
        let events = codePathFrame.events.get(segment)
        if (!events) {
          events = []
          codePathFrame.events.set(segment, events)
        }
        events.push(event)
      }
    }

    /**
     * @param {import('estree').Node} expression
     * @param {import('estree').Node} node
     * @returns {void}
     */
    function recordCarrierCheck (expression, node) {
      if (strictCarrierIdentifiers) recordCodePathEvent({ type: 'check', expression, node })
    }

    /**
     * @param {CarrierWrite} event
     * @param {Set<import('eslint').Scope.Variable>} taintedVariables
     * @returns {void}
     */
    function applyCarrierWrite (event, taintedVariables) {
      const tainted = (event.preserve && taintedVariables.has(event.variable)) ||
        isCarrierReference(event.expression, taintedVariables)
      if (tainted) {
        taintedVariables.add(event.variable)
      } else {
        taintedVariables.delete(event.variable)
      }
    }

    /**
     * @param {import('eslint').CodePathSegment} segment
     * @param {Map<import('eslint').CodePathSegment, Set<import('eslint').Scope.Variable>>} outputs
     * @returns {Set<import('eslint').Scope.Variable>}
     */
    function getCodePathInput (segment, outputs) {
      const taintedVariables = new Set()
      const previousSegments = segment.reachable ? segment.prevSegments : segment.allPrevSegments
      for (const previous of previousSegments) {
        const output = outputs.get(previous)
        if (!output) continue
        for (const variable of output) taintedVariables.add(variable)
      }
      return taintedVariables
    }

    /**
     * @param {import('estree').CallExpression} node
     * @param {Set<import('eslint').Scope.Variable>} taintedVariables
     * @returns {void}
     */
    function checkCarrierCall (node, taintedVariables) {
      if (node.callee.type === 'Identifier' &&
          (carrierFunctions.has(node.callee.name) ||
            isCheckedLocalCarrierFunction(node.callee, node.arguments, taintedVariables))) return

      for (const argument of node.arguments) {
        if (argument.type !== 'SpreadElement' && isCarrierReference(argument, taintedVariables)) {
          report(argument, 'noDirectCarrierAccess')
        }
      }
    }

    /**
     * @param {CodePathFrame} frame
     * @returns {void}
     */
    function analyzeCodePath (frame) {
      const outputs = new Map()
      let changed
      do {
        changed = false
        for (const segment of frame.segments) {
          const taintedVariables = getCodePathInput(segment, outputs)
          for (const event of frame.events.get(segment) || []) {
            if (event.type === 'write') applyCarrierWrite(event, taintedVariables)
          }
          // Outputs grow monotonically, so unchanged cardinality means unchanged membership.
          if (outputs.get(segment)?.size !== taintedVariables.size) {
            outputs.set(segment, taintedVariables)
            changed = true
          }
        }
      } while (changed)

      for (const segment of frame.segments) {
        const taintedVariables = getCodePathInput(segment, outputs)
        for (const event of frame.events.get(segment) || []) {
          if (event.type === 'write') {
            applyCarrierWrite(event, taintedVariables)
          } else if (event.type === 'return' && isCarrierReference(event.expression, taintedVariables)) {
            carrierReturningFunctions.add(frame.node)
          }
        }
      }

      for (const segment of frame.segments) {
        const taintedVariables = getCodePathInput(segment, outputs)
        for (const event of frame.events.get(segment) || []) {
          if (event.type === 'write') {
            applyCarrierWrite(event, taintedVariables)
          } else if (event.type === 'check' && isCarrierReference(event.expression, taintedVariables)) {
            report(event.node, 'noDirectCarrierAccess')
          } else if (event.type === 'call') {
            checkCarrierCall(event.node, taintedVariables)
          }
        }
      }
    }

    /**
     * Local function declarations are checked by this same rule, so carriers can
     * safely pass through carrier-named parameters unless the binding is reassigned.
     *
     * @param {import('estree').Identifier} callee
     * @param {Array<import('estree').Expression | import('estree').SpreadElement>} callArguments
     * @param {Set<import('eslint').Scope.Variable>} taintedVariables
     * @returns {boolean}
     */
    function isCheckedLocalCarrierFunction (callee, callArguments, taintedVariables) {
      let scope = sourceCode.getScope(callee)
      while (scope) {
        const variable = scope.set.get(callee.name)
        if (variable) {
          if (variable.defs.length !== 1 || variable.defs[0].type !== 'FunctionName') return false
          for (const reference of variable.references) {
            if (reference.isWrite()) return false
          }

          const localFunction = variable.defs[0].node
          if (carrierReturningFunctions.has(localFunction)) return false

          const parameters = localFunction.params
          for (let index = 0; index < callArguments.length; index++) {
            const argument = callArguments[index]
            if (argument.type === 'SpreadElement' || !isCarrierReference(argument, taintedVariables)) continue
            const parameter = parameters[index]
            if (parameter?.type !== 'Identifier' || !isCarrierIdentifier(parameter)) return false
          }
          return true
        }
        scope = scope.upper
      }
      return false
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
      let handled = false
      for (const property of pattern.properties) {
        if (property.type === 'RestElement') {
          recordCarrierCheck(target, property)
          handled = strictCarrierIdentifiers
          continue
        }

        const name = getPropertyName(property, resolveString)
        if (name && isManagedHeaderAccess(name, target)) {
          report(property, 'useCarrierField')
          handled = true
        } else if (strictCarrierIdentifiers) {
          recordCarrierCheck(target, property)
          handled = true
        }
      }
      return handled
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
       * @param {import('eslint').CodePath} codePath
       * @param {import('estree').Node} node
       * @returns {void}
       */
      onCodePathStart (codePath, node) {
        codePathFrames.push({
          node,
          currentSegments: new Set(),
          segments: new Set([codePath.initialSegment]),
          events: new Map(),
        })
      },

      onCodePathEnd () {
        analyzeCodePath(codePathFrames.pop())
      },

      /**
       * @param {import('eslint').CodePathSegment} segment
       * @returns {void}
       */
      onCodePathSegmentStart (segment) {
        const codePathFrame = codePathFrames[codePathFrames.length - 1]
        codePathFrame.currentSegments.add(segment)
        codePathFrame.segments.add(segment)
      },

      /**
       * @param {import('eslint').CodePathSegment} segment
       * @returns {void}
       */
      onCodePathSegmentEnd (segment) {
        codePathFrames[codePathFrames.length - 1].currentSegments.delete(segment)
      },

      /**
       * @param {import('eslint').CodePathSegment} segment
       * @returns {void}
       */
      onUnreachableCodePathSegmentStart (segment) {
        const codePathFrame = codePathFrames[codePathFrames.length - 1]
        codePathFrame.currentSegments.add(segment)
        codePathFrame.segments.add(segment)
      },

      /**
       * @param {import('eslint').CodePathSegment} segment
       * @returns {void}
       */
      onUnreachableCodePathSegmentEnd (segment) {
        codePathFrames[codePathFrames.length - 1].currentSegments.delete(segment)
      },

      /**
       * @param {import('estree').MemberExpression} node
       * @returns {void}
       */
      'MemberExpression:exit' (node) {
        const name = getMemberName(node, resolveString)

        if (name && isManagedHeaderAccess(name, node.object)) {
          report(node, 'useCarrierField')
        } else {
          recordCarrierCheck(node.object, node)
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
      'BinaryExpression:exit' (node) {
        if (node.operator !== 'in') return

        const name = resolveString(node.left)
        if (name && isManagedHeaderAccess(name, node.right)) {
          report(node, 'useCarrierField')
        } else {
          recordCarrierCheck(node.right, node)
        }
      },

      /**
       * @param {import('estree').CallExpression} node
       * @returns {void}
       */
      'CallExpression:exit' (node) {
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
          } else {
            recordCarrierCheck(reflectiveAccess.target, node)
          }
          return
        }

        if (!strictCarrierIdentifiers || node.callee.type === 'Super') return
        if (node.callee.type === 'MemberExpression' && node.callee.object.type === 'ThisExpression') return
        recordCodePathEvent({ type: 'call', node })
      },

      /**
       * @param {import('estree').SpreadElement} node
       * @returns {void}
       */
      'SpreadElement:exit' (node) {
        recordCarrierCheck(node.argument, node)
      },

      /**
       * @param {import('estree').AssignmentExpression} node
       * @returns {void}
       */
      'AssignmentExpression:exit' (node) {
        if (node.left.type === 'ObjectPattern') {
          if (!checkObjectPattern(node.left, node.right)) recordCarrierCheck(node.right, node)
          return
        }

        const variable = findVariable(node.left)
        if (variable) {
          recordCodePathEvent({
            type: 'write',
            variable,
            expression: node.right,
            preserve: node.operator === '||=' || node.operator === '??=',
          })
        }
      },

      /**
       * @param {import('estree').VariableDeclarator} node
       * @returns {void}
       */
      'VariableDeclarator:exit' (node) {
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
          if (!checkObjectPattern(node.id, node.init)) recordCarrierCheck(node.init, node)
        } else if (node.id.type === 'Identifier' && node.init) {
          const variable = findVariable(node.id)
          if (variable) {
            recordCodePathEvent({ type: 'write', variable, expression: node.init, preserve: false })
          }
        }
      },

      /**
       * @param {import('estree').ReturnStatement} node
       * @returns {void}
       */
      'ReturnStatement:exit' (node) {
        if (node.argument) recordCodePathEvent({ type: 'return', expression: node.argument, node })
      },

      /**
       * @param {import('estree').UpdateExpression} node
       * @returns {void}
       */
      'UpdateExpression:exit' (node) {
        const variable = findVariable(node.argument)
        if (variable) {
          recordCodePathEvent({ type: 'write', variable, expression: node, preserve: false })
        }
      },
    }
  },
}
