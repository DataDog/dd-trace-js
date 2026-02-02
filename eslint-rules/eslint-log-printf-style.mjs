export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Enforce printf-style formatting in log calls instead of string concatenation, template literals, or ' +
        'callbacks. Callback-style logging (e.g., log.debug(() => ...)) is ONLY allowed for expensive formatting ' +
        'operations where you need to avoid the overhead when the log level is disabled. In those rare cases, ' +
        'disable this rule with: // eslint-disable-next-line eslint-rules/eslint-log-printf-style',
    },
    messages: {
      useFormat: 'Use printf-style formatting (e.g., log.{{method}}("message %s", value)) instead of {{badPattern}}. ' +
        'Only use callback-style for expensive operations and disable this rule with a comment.',
    },
    schema: [],
  },
  create (context) {
    const LOG_METHODS = ['trace', 'debug', 'info', 'warn', 'error', 'errorWithoutTelemetry']

    const isLogCall = (node) => {
      return node.type === 'CallExpression' &&
             node.callee.type === 'MemberExpression' &&
             node.callee.object.name === 'log' &&
             LOG_METHODS.includes(node.callee.property.name)
    }

    const hasBinaryStringConcat = (node) => {
      if (node.type !== 'BinaryExpression' || node.operator !== '+') {
        return false
      }

      // Check if either side is a string literal or another concatenation
      const leftIsString = node.left.type === 'Literal' && typeof node.left.value === 'string'
      const rightIsString = node.right.type === 'Literal' && typeof node.right.value === 'string'
      const leftIsConcat = hasBinaryStringConcat(node.left)
      const rightIsConcat = hasBinaryStringConcat(node.right)

      return leftIsString || rightIsString || leftIsConcat || rightIsConcat
    }

    return {
      CallExpression (node) {
        if (!isLogCall(node)) return
        if (node.arguments.length === 0) return

        const firstArg = node.arguments[0]
        const methodName = node.callee.property.name

        // Check for callback-style logging (arrow functions or function expressions)
        // NOTE: Callback-style is only acceptable for expensive formatting operations
        // where you need to avoid overhead when the log level is disabled.
        // Use: // eslint-disable-next-line eslint-rules/eslint-log-printf-style
        if (firstArg.type === 'ArrowFunctionExpression' || firstArg.type === 'FunctionExpression') {
          context.report({
            node: firstArg,
            messageId: 'useFormat',
            data: {
              method: methodName,
              badPattern: 'callback-style logging',
            },
          })
          return
        }

        // Check for template literals with expressions
        if (firstArg.type === 'TemplateLiteral' && firstArg.expressions.length > 0) {
          context.report({
            node: firstArg,
            messageId: 'useFormat',
            data: {
              method: methodName,
              badPattern: 'template literals',
            },
          })
          return
        }

        // Check for string concatenation with +
        if (hasBinaryStringConcat(firstArg)) {
          context.report({
            node: firstArg,
            messageId: 'useFormat',
            data: {
              method: methodName,
              badPattern: 'string concatenation',
            },
          })
        }
      },
    }
  },
}
