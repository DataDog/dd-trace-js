import { generateText } from 'ai'
import { useLoaderData } from 'react-router'

import model from '../model.js'

export async function loader () {
  const { text } = await generateText({ model, prompt: 'Say ok', experimental_telemetry: { isEnabled: true } })
  return { text }
}

export default function Home () {
  const { text } = useLoaderData()
  return <p id='text'>{text}</p>
}
