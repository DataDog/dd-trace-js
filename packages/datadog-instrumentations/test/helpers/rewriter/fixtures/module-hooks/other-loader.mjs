// Another vendor's asynchronous loader, such as tsx or OpenTelemetry, that passes every module through.
import { register } from 'node:module'

register('data:text/javascript,export async function load (url, context, nextLoad) { return nextLoad(url, context) }')
