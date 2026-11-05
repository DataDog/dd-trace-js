import type { Plugin } from 'vite'

/**
 * Instruments the dependencies bundled by a Vite build producing Node.js code, such as an SSR server, a library or an
 * Electron main process. Client builds are left untouched. Requires Vite 6 or newer.
 */
export function datadogVite (): Plugin
