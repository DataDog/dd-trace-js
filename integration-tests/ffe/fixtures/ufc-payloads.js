'use strict'

// Simple UFC (Universal Flag Configuration) payloads for testing
module.exports = {
  testBooleanAndStringFlags: {
    flags: {
      'test-boolean-flag': {
        key: 'test-boolean-flag',
        enabled: true,
        variationType: 'BOOLEAN',
        variations: {
          true: { key: 'true', value: true },
          false: { key: 'false', value: false }
        },
        allocations: [
          {
            key: 'boolean-allocation',
            rules: [],
            splits: [
              {
                variationKey: 'true',
                shards: []
              }
            ],
            doLog: true
          }
        ]
      },
      'test-string-flag': {
        key: 'test-string-flag',
        enabled: true,
        variationType: 'STRING',
        variations: {
          'variant-a': { key: 'variant-a', value: 'hello' },
          'variant-b': { key: 'variant-b', value: 'world' }
        },
        allocations: [
          {
            key: 'string-allocation',
            rules: [],
            splits: [
              {
                variationKey: 'variant-a',
                shards: [
                  {
                    salt: 'test-string-flag-allocation-split',
                    totalShards: 10000,
                    ranges: [{ start: 0, end: 5000 }]
                  }
                ]
              },
              {
                variationKey: 'variant-b',
                shards: [
                  {
                    salt: 'test-string-flag-allocation-split',
                    totalShards: 10000,
                    ranges: [{ start: 5000, end: 10000 }]
                  }
                ]
              }
            ],
            doLog: true
          }
        ]
      }
    }
  },

  simpleBooleanFlag: {
    flags: {
      'removable-flag': {
        key: 'removable-flag',
        enabled: true,
        variationType: 'BOOLEAN',
        defaultVariation: 'true',
        variations: {
          true: { key: 'true', value: true },
          false: { key: 'false', value: false }
        },
        allocations: [
          {
            key: 'remove-allocation',
            percentages: { true: 100, false: 0 },
            filters: []
          }
        ]
      }
    }
  },

  simpleStringFlagForAck: {
    flags: {
      'simple-flag': {
        key: 'simple-flag',
        enabled: true,
        variationType: 'STRING',
        defaultVariation: 'control',
        variations: {
          control: { key: 'control', value: 'control-value' },
          treatment: { key: 'treatment', value: 'treatment-value' }
        },
        allocations: [
          {
            key: 'default-allocation',
            percentages: { control: 100, treatment: 0 },
            filters: []
          }
        ]
      }
    }
  },

  simpleStringFlag: {
    createdAt: '2025-02-14T00:56:56.910Z',
    format: 'SERVER',
    environment: {
      name: 'Test'
    },
    flags: {
      'example-flag-2025-02-13': {
        key: 'example-flag-2025-02-13',
        enabled: true,
        variationType: 'STRING',
        variations: {
          control: {
            key: 'control',
            value: 'control'
          },
          variant1: {
            key: 'variant1',
            value: 'variant1'
          },
          variant2: {
            key: 'variant2',
            value: 'variant2'
          }
        },
        totalShards: 10000,
        allocations: [
          {
            key: 'allocation-18297',
            rules: [
              {
                conditions: [
                  {
                    value: [
                      '12345'
                    ],
                    operator: 'ONE_OF',
                    attribute: 'userId'
                  }
                ]
              }
            ],
            splits: [
              {
                variationKey: 'variant1',
                shards: [
                  {
                    salt: 'example-flag-2025-02-13-18297-split',
                    ranges: [
                      {
                        start: 0,
                        end: 10000
                      }
                    ]
                  }
                ]
              }
            ],
            doLog: true
          },
          {
            key: 'allocation-18298',
            splits: [
              {
                variationKey: 'control',
                shards: [
                  {
                    salt: 'example-flag-2025-02-13-18298-traffic',
                    ranges: [
                      {
                        start: 0,
                        end: 6000
                      }
                    ]
                  },
                  {
                    salt: 'example-flag-2025-02-13-18298-split',
                    ranges: [
                      {
                        start: 0,
                        end: 3333
                      }
                    ]
                  }
                ]
              },
              {
                variationKey: 'variant1',
                shards: [
                  {
                    salt: 'example-flag-2025-02-13-18298-traffic',
                    ranges: [
                      {
                        start: 0,
                        end: 6000
                      }
                    ]
                  },
                  {
                    salt: 'example-flag-2025-02-13-18298-split',
                    ranges: [
                      {
                        start: 3333,
                        end: 6666
                      }
                    ]
                  }
                ]
              },
              {
                variationKey: 'variant2',
                shards: [
                  {
                    salt: 'example-flag-2025-02-13-18298-traffic',
                    ranges: [
                      {
                        start: 0,
                        end: 6000
                      }
                    ]
                  },
                  {
                    salt: 'example-flag-2025-02-13-18298-split',
                    ranges: [
                      {
                        start: 6666,
                        end: 10000
                      }
                    ]
                  }
                ]
              }
            ],
            doLog: true
          },
          {
            key: 'allocation-18280',
            splits: [
              {
                variationKey: 'control',
                shards: []
              }
            ],
            doLog: true
          }
        ]
      }
    }
  }
}
