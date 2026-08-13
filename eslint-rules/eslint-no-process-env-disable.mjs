import path from 'node:path'

const PROCESS_ENV_RULE = 'eslint-rules/eslint-process-env'

function isProcessEnvDisable (comment) {
  const match = comment.value.trim().match(/^eslint-disable(?:-next-line|-line)?(?:\s+([\s\S]*))?$/u)
  if (!match?.[1]) return false

  const [ruleList] = match[1].split(/\s+--(?:\s|$)/u, 1)
  return ruleList.split(',').some(rule => rule.trim() === PROCESS_ENV_RULE)
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description: `Disallow directives that disable ${PROCESS_ENV_RULE}`,
    },
    messages: {
      noProcessEnvDisable:
        'Do not disable the process.env guardrail. Use getEnvironmentVariable() or add a reviewed lint exception.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowFiles: {
            type: 'array',
            items: { type: 'string' },
            uniqueItems: true,
          },
        },
        additionalProperties: false,
      },
    ],
  },

  create (context) {
    const filename = path.relative(context.cwd, context.filename || context.getFilename?.() || '').replaceAll('\\', '/')
    const allowFiles = context.options[0]?.allowFiles ?? []
    let remainingAllowedDirectives = allowFiles.includes(filename) ? 1 : 0

    return {
      Program () {
        for (const comment of context.sourceCode.getAllComments()) {
          if (!isProcessEnvDisable(comment)) continue

          if (remainingAllowedDirectives > 0) {
            remainingAllowedDirectives--
            continue
          }

          context.report({
            node: comment,
            messageId: 'noProcessEnvDisable',
          })
        }
      },
    }
  },
}
