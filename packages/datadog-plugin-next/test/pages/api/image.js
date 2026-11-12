const { readFileSync } = require('node:fs')
const path = require('node:path')

/**
 * @param {import('next').NextApiRequest} req
 * @param {import('node:http').ServerResponse} res
 */
export default function image (req, res) {
  if (req.query.error === 'true') {
    res.statusCode = 500
    res.setHeader('content-type', 'text/plain')
    res.write('Image source failed')
  } else {
    res.setHeader('content-type', 'image/png')
    res.write(readFileSync(path.join(process.cwd(), 'public/test.png')))
  }
  // Next.js 11's image response mock does not finish when end receives the body.
  res.end()
}
