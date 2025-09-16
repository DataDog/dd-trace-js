'use strict'

// UFC (Universal Flag Configuration) payloads for testing
module.exports = {
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
