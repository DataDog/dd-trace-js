export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow usage of process.env outside config.js'
    },
    schema: []
  },
  create (context) {
    const isProcessEnvObject = (node) => {
      return node?.type === 'MemberExpression' &&
             node.object?.name === 'process' &&
             node.property?.name === 'env'
    }

    const report = (node) => {
      context.report({
        node,
        message: 'Usage of process.env is only allowed in config-helper.js'
      })
    }

    return {
      // Handle direct member expressions: process.env.FOO
      MemberExpression (node) {
        if (node.object?.type === 'MemberExpression' &&
            isProcessEnvObject(node.object)) {
          report(node)
        }
      },

      // Handle destructuring: const { FOO } = process.env
      VariableDeclarator (node) {
        if (isProcessEnvObject(node.init)) {
          report(node)
        }
      },

      // Handle spread operator: { ...process.env }
      SpreadElement (node) {
        if (isProcessEnvObject(node.argument)) {
          report(node)
        }
      },

      // Handle any function call with process.env as an argument
      CallExpression (node) {
        for (const arg of node.arguments) {
          if (isProcessEnvObject(arg)) {
            report(node)
            break
          }
        }
      }
    }
  }
}
