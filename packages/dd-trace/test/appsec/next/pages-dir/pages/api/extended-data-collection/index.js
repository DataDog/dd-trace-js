// Next.js API route support: https://nextjs.org/docs/api-routes/introduction

export default async function POST (req, res) {
  res.setHeader('custom-response-header-1', 'custom-response-header-value-1')
  res.setHeader('custom-response-header-2', 'custom-response-header-value-2')
  res.setHeader('custom-response-header-3', 'custom-response-header-value-3')
  res.setHeader('custom-response-header-4', 'custom-response-header-value-4')
  res.setHeader('custom-response-header-5', 'custom-response-header-value-5')
  res.setHeader('custom-response-header-6', 'custom-response-header-value-6')
  res.setHeader('custom-response-header-7', 'custom-response-header-value-7')
  res.setHeader('custom-response-header-8', 'custom-response-header-value-8')
  res.setHeader('custom-response-header-9', 'custom-response-header-value-9')
  res.setHeader('custom-response-header-10', 'custom-response-header-value-10')
  res.end('DONE')
}
