export const carrierFieldsFilePatterns = ['packages/*/src/**/*.{js,mjs,cjs}']

const strictCarrierFieldsFilePatterns = [
  'packages/dd-trace/src/datastreams/pathway.js',
  'packages/dd-trace/src/opentracing/propagation/text_map.js',
]

export const carrierFieldsConfig = [
  {
    name: 'dd-trace/propagation/managed-header-fields',
    files: carrierFieldsFilePatterns,
    ignores: ['packages/dd-trace/src/carrier.js'],
    rules: {
      'eslint-rules/eslint-carrier-fields': 'error',
    },
  },
  {
    name: 'dd-trace/propagation/carrier-fields',
    files: strictCarrierFieldsFilePatterns,
    rules: {
      'eslint-rules/eslint-carrier-fields': ['error', {
        strictCarrierIdentifiers: true,
      }],
    },
  },
]
