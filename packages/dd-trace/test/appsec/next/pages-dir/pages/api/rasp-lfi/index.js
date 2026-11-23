import fs from 'fs'

export default function handler (req, res) {
  try {
    res.status(200).json({ length: fs.readFileSync(req.query.file).length })
  } catch (error) {
    if (req.query.rethrow !== undefined) throw error

    res.status(200).json({ error: error.name })
  }
}
