import { TypeSafeClient } from '@typesafe-ai/sdk'

const client = new TypeSafeClient({
  apiKey: process.env.TYPESAFE_API_KEY ?? 'not-a-real-key',
  baseURL: 'http://127.0.0.1:9126/vcr/typesafe',
  // 0.7.0 zstd-compresses request bodies of 1 KiB or more on Node.js 22.15+, which would make cassette bodies
  // unreadable and differ across Node.js versions
  compression: false,
  retry: { maxRetries: 0 },
})

await client.systemOne({
  state: 'I was charged twice for my subscription this month and want the duplicate refunded.',
  questions: {
    team: {
      type: 'choice',
      instructions: 'Which team should handle this message?',
      criteria: {
        billing: 'Charges, refunds, invoices',
        technical: 'Bugs, outages, errors',
        sales: 'Pricing, plans, buying more',
      },
    },
    refund: { type: 'noul', instructions: 'Is the customer asking for a refund?' },
    urgency: { type: 'score', instructions: 'How urgent is this message?', criteria: ['Low', 'Medium', 'High'] },
  },
  model: 'jev-1.13.0',
})
