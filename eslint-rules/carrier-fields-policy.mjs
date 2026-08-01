const carrierFieldsFilePatterns = ['packages/*/src/**/*.{js,mjs,cjs}']

const strictCarrierFieldsFilePatterns = [
  'packages/dd-trace/src/datastreams/pathway.js',
  'packages/dd-trace/src/opentracing/propagation/text_map.js',
]

/**
 * @param {string} ruleName
 * @returns {import('eslint').Linter.Config[]}
 */
export function createCarrierFieldsConfig (ruleName) {
  return [
    {
      name: 'dd-trace/propagation/managed-header-fields',
      files: carrierFieldsFilePatterns,
      ignores: ['packages/dd-trace/src/carrier.js'],
      rules: {
        [ruleName]: ['error', { requireDirectOperations: true }],
      },
    },
    {
      name: 'dd-trace/propagation/carrier-fields',
      files: strictCarrierFieldsFilePatterns,
      rules: {
        [ruleName]: ['error', {
          requireDirectOperations: true,
          strictCarrierIdentifiers: true,
        }],
      },
    },
  ]
}

export { carrierFieldsFilePatterns }
