/**
 * Enforce use of private class fields (#prop) over underscore-prefixed properties (_prop)
 * when the property is only accessed within a single class in the same file.
 *
 * Private fields (#prop) are enforced by the runtime (SyntaxError if accessed externally),
 * while underscore convention (_prop) is advisory only.
 *
 * The rule is intentionally conservative:
 * - Only flags when an explicit class field declaration (`_foo = value`) exists.
 *   Constructor-only assignments (`this._foo = 1`) and method definitions (`_foo() {}`)
 *   are not flagged. For constructor-only assignments, the auto-fix would produce invalid
 *   JavaScript without also synthesizing a new `#foo` field declaration. For methods,
 *   test files often use sinon.stub(instance, '_methodName') which cannot stub private
 *   methods — privatizing methods would break test stubs.
 * - Only flags when ALL accesses to that name in the file are within the body of exactly
 *   one class. Any external access, access in a different class, or destructuring use
 *   (incompatible with private fields) suppresses the warning for that property name.
 * - Never flags fields in exported classes. Exported classes may be subclassed in other
 *   files, or their fields may be set/read directly by test code (e.g., `instance._field = x`
 *   or `sinon.stub(instance, '_field')`). Cross-file access is invisible to this single-file
 *   analysis rule, so exported classes are skipped entirely.
 *
 * Each occurrence (definition + every access) is reported as a separate problem, each with
 * its own single-node fix. This lets ESLint apply all fixes in one pass without range conflicts.
 */

/**
 * @typedef {{ enclosingClass: import('eslint').Rule.Node | null, node: import('eslint').Rule.Node }} PropSource
 */

export default {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Prefer private class fields (#prop) over underscore-prefixed properties (_prop) ' +
        'when the property is only accessed within a single class',
      recommended: false,
    },
    fixable: 'code',
    messages: {
      preferPrivate:
        'Property "{{name}}" is only used within class "{{className}}". ' +
        'Use private field "#{{privateName}}" instead of the underscore convention.',
    },
    schema: [],
  },

  create (context) {
    /** @type {Map<string, PropSource[]>} */
    const propSources = new Map()

    /** @type {Set<string>} Property names that cannot be privatized (e.g. destructured) */
    const blocked = new Set()

    /**
     * Class names exported from this module (CJS module.exports or ESM export).
     * Exported classes may be subclassed or have their fields accessed externally
     * (e.g. from test files), so we skip privatization for their fields.
     *
     * @type {Set<string>}
     */
    const exportedClassNames = new Set()

    /**
     * Class nodes exported anonymously (e.g. `module.exports = class { ... }`
     * or `export default class { ... }`).
     *
     * @type {Set<import('eslint').Rule.Node>}
     */
    const exportedClassNodes = new Set()

    /**
     * Walk up the parent chain to find the nearest enclosing ClassDeclaration or ClassExpression.
     *
     * @param {import('eslint').Rule.Node} node
     * @returns {import('eslint').Rule.Node | null}
     */
    function getEnclosingClass (node) {
      let current = node.parent
      while (current) {
        if (current.type === 'ClassBody') {
          return current.parent
        }
        current = current.parent
      }
      return null
    }

    /**
     * @param {string} propName
     * @param {import('eslint').Rule.Node} node
     * @param {import('eslint').Rule.Node | null} enclosingClass
     */
    function recordSource (propName, node, enclosingClass) {
      if (!propSources.has(propName)) {
        propSources.set(propName, [])
      }
      propSources.get(propName).push({ enclosingClass, node })
    }

    return {
      /**
       * Track all member-expression accesses: this._foo, obj._foo, etc.
       *
       * @param {import('eslint').Rule.Node} node
       */
      MemberExpression (node) {
        if (node.computed) return
        if (node.property.type !== 'Identifier') return
        const { name } = node.property
        if (!name.startsWith('_') || name === '_') return

        // `super._foo` means this property is defined on the parent class.
        // Converting it to `super.#foo` is syntactically invalid — private fields
        // cannot be accessed via `super`. Block the property entirely.
        if (node.object.type === 'Super') {
          blocked.add(name)
          return
        }

        const enclosingClass = getEnclosingClass(node)
        recordSource(name, node, enclosingClass)
      },

      /**
       * Track class field declarations: _foo = value.
       * These are `PropertyDefinition` nodes in the class body.
       *
       * @param {import('eslint').Rule.Node} node
       */
      PropertyDefinition (node) {
        if (node.computed) return
        if (node.key.type !== 'Identifier') return
        const { name } = node.key
        if (!name.startsWith('_') || name === '_') return

        const enclosingClass = getEnclosingClass(node)
        recordSource(name, node, enclosingClass)
      },

      /**
       * Block properties that appear as destructuring keys.
       * Private fields cannot be destructured, so `const { _foo } = this` cannot be
       * automatically fixed to `const { #foo } = this`.
       *
       * @param {import('eslint').Rule.Node} node
       */
      Property (node) {
        if (node.parent?.type !== 'ObjectPattern') return
        if (node.computed) return
        if (node.key.type !== 'Identifier') return
        const { name } = node.key
        if (!name.startsWith('_') || name === '_') return

        blocked.add(name)
      },

      /**
       * Track CJS exports: `module.exports = ClassName` or `module.exports = class { ... }`.
       * Exported classes may be subclassed or have fields accessed externally (tests, other
       * modules), so their fields must not be privatized.
       *
       * @param {import('eslint').Rule.Node} node
       */
      AssignmentExpression (node) {
        const { left, right } = node
        if (
          left.type !== 'MemberExpression' ||
          left.computed ||
          left.object.type !== 'Identifier' ||
          left.object.name !== 'module' ||
          left.property.type !== 'Identifier' ||
          left.property.name !== 'exports'
        ) return

        if (right.type === 'Identifier') {
          exportedClassNames.add(right.name)
        } else if (right.type === 'ClassExpression' || right.type === 'ClassDeclaration') {
          if (right.id) {
            exportedClassNames.add(right.id.name)
          } else {
            exportedClassNodes.add(right)
          }
        }
      },

      /**
       * Track ESM default exports: `export default ClassName` or `export default class { ... }`.
       *
       * @param {import('eslint').Rule.Node} node
       */
      ExportDefaultDeclaration (node) {
        const { declaration } = node
        if (declaration.type === 'Identifier') {
          exportedClassNames.add(declaration.name)
        } else if (declaration.type === 'ClassDeclaration' || declaration.type === 'ClassExpression') {
          if (declaration.id) {
            exportedClassNames.add(declaration.id.name)
          } else {
            exportedClassNodes.add(declaration)
          }
        }
      },

      /**
       * Track ESM named exports: `export class ClassName { ... }` or `export { ClassName }`.
       *
       * @param {import('eslint').Rule.Node} node
       */
      ExportNamedDeclaration (node) {
        if (node.declaration?.type === 'ClassDeclaration' && node.declaration.id) {
          exportedClassNames.add(node.declaration.id.name)
        }
        for (const specifier of node.specifiers) {
          exportedClassNames.add(specifier.local.name)
        }
      },

      'Program:exit' () {
        for (const [propName, sources] of propSources) {
          // Cannot be privatized: appears as a destructuring key
          if (blocked.has(propName)) continue

          // Cannot be privatized: accessed outside any class body
          const hasExternalAccess = sources.some(s => !s.enclosingClass)
          if (hasExternalAccess) continue

          // Cannot be privatized: referenced in more than one class
          const classes = new Set(sources.map(s => s.enclosingClass))
          if (classes.size !== 1) continue

          // Only flag when an explicit class field declaration exists (PropertyDefinition).
          // Without a PropertyDefinition, replacing this._foo with this.#foo produces a
          // SyntaxError because private fields must be declared in the class body.
          // MethodDefinition (methods) are intentionally excluded: test files often use
          // sinon.stub(instance, '_methodName') which cannot stub private methods.
          const hasDefinition = sources.some(s => s.node.type === 'PropertyDefinition')
          if (!hasDefinition) continue

          // Only flag when there is at least one MemberExpression access (this._foo, obj._foo).
          // A definition with no accesses in this file may be a public API used from other
          // files; converting it to a private field would break external callers, and would
          // also trigger no-unused-private-class-members.
          const hasAccess = sources.some(s => s.node.type === 'MemberExpression')
          if (!hasAccess) continue

          const [classNode] = classes

          // Skip exported classes: they may be subclassed or have fields accessed externally
          // (e.g. from test files via `instance._field = x` or `sinon.stub(instance, '_field')`).
          const classIdentifier = classNode.id?.name
          if (classIdentifier && exportedClassNames.has(classIdentifier)) continue
          if (exportedClassNodes.has(classNode)) continue

          const className = classIdentifier ?? '<anonymous>'
          const privateName = propName.slice(1)

          // Report one error per occurrence. Each error has a single-node fix so ESLint
          // can apply all fixes independently in one pass without range conflicts.
          for (const { node } of sources) {
            // The identifier to rename is the key (for definitions) or the property (for accesses).
            const identifierNode = node.type === 'MemberExpression' ? node.property : node.key

            context.report({
              node: identifierNode,
              messageId: 'preferPrivate',
              data: { name: propName, className, privateName },
              fix (fixer) {
                return fixer.replaceText(identifierNode, `#${privateName}`)
              },
            })
          }
        }
      },
    }
  },
}
