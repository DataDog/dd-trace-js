/// <reference types="node" />

// The private subset exposed by webdriverio-video.mjs, without browser/WebCodecs types.
export function createEncoder(options: { wasmBinary: Uint8Array }): Promise<{
  encode(data: Uint8ClampedArray, width: number, height: number, options: Record<string, number>): Uint8Array | null
}>
export const defaultOptions: Record<string, number>
export function decodePng(data: Buffer, options: Record<string, never>): {
  width: number
  height: number
  data: Buffer
}

export class BufferTarget {
  buffer: ArrayBuffer | null
}
export class WebMOutputFormat {}
export class EncodedPacket {
  constructor(data: Uint8Array, type: 'key', timestamp: number, duration: number)
}
export class EncodedVideoPacketSource {
  constructor(codec: 'vp8')
  add(packet: EncodedPacket, metadata: {
    decoderConfig: { codec: 'vp8', codedWidth: number, codedHeight: number }
  }): Promise<void>
}
export class Output {
  constructor(options: { format: WebMOutputFormat, target: BufferTarget })
  target: BufferTarget
  addVideoTrack(source: EncodedVideoPacketSource, metadata: { frameRate: number }): void
  start(): Promise<void>
  finalize(): Promise<void>
}
