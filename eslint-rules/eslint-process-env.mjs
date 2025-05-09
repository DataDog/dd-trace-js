export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow usage of process.env outside config.js'
    },
    schema: []
  },
  create (context) {
    const allowedFile = /[/\\]packages[/\\]dd-trace[/\\]src[/\\](config-helper|guardrails[/\\](index|log))\.js$/

    return {
      // TODO: Add support for other types like
      // const { FOO_BAR } = process.env and Object.keys(process.env)
      MemberExpression (node) {
        const isProcessEnv =
          node.object?.type === 'MemberExpression' &&
          node.object.object?.name === 'process' &&
          node.object.property?.name === 'env'

        if (isProcessEnv) {
          const filename = context.getFilename()
          if (!allowedFile.test(filename)) {
            context.report({
              node,
              message: 'Usage of process.env is only allowed in config-helper.js'
            })
          }
        }
      }
    }
  }
}
