import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ConfigCommentParser } from '@eslint/plugin-kit'

const PROCESS_ENV_RULE = 'eslint-rules/eslint-process-env'
const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url))
const commentParser = new ConfigCommentParser()

function isProcessEnvDisable (directive) {
  return directive.type !== 'enable' && Object.hasOwn(commentParser.parseListConfig(directive.value), PROCESS_ENV_RULE)
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
      staleAllowFile: 'Remove the stale process.env suppression allowlist entry for this file.',
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
    const filename = path.relative(
      REPOSITORY_ROOT,
      context.filename || context.getFilename?.() || ''
    ).replaceAll('\\', '/')
    const allowFiles = context.options[0]?.allowFiles ?? []
    let allowanceAvailable = allowFiles.includes(filename)

    return {
      Program (node) {
        for (const directive of context.sourceCode.getDisableDirectives().directives) {
          if (!isProcessEnvDisable(directive)) continue

          if (allowanceAvailable) {
            allowanceAvailable = false
            continue
          }

          context.report({
            node: directive.node,
            messageId: 'noProcessEnvDisable',
          })
        }

        if (allowanceAvailable) {
          context.report({
            node,
            messageId: 'staleAllowFile',
          })
        }
      },
    }
  },
}
