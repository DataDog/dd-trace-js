import type { Plugin } from 'vite'

/**
 * Instruments the dependencies bundled by a Vite build producing Node.js code, such as an SSR server, a library or an
 * Electron main process. Client builds are left untouched.
 */
export function datadogVite (options?: Record<string, never>): Plugin
