/**
 * Types for the offline thumbnail renderer.
 *
 * The renderer stays plain ESM so the catalog build runs under bare `node`; this
 * declaration lets the test suite exercise it directly.
 */

export interface ThumbnailMesh {
  positions: Float32Array
  normals: Float32Array
  indices: Uint32Array
  slices: Array<{ colour: number; start: number; count: number }>
}

export interface ThumbnailOptions {
  /** Output edge length in pixels. */
  size?: number
  /** Supersampling factor used before box-filtering down. */
  supersample?: number
}

export interface RenderedThumbnail {
  /** RGBA: shading in RGB, coverage in alpha. */
  rgba: Buffer
  size: number
}

export declare function renderThumbnail(mesh: ThumbnailMesh, options?: ThumbnailOptions): RenderedThumbnail | null

export declare function encodePng(rgba: Buffer, size: number): Buffer

export interface CompiledThumbnail {
  buffer: Buffer
  /** SHA-256 of `buffer`, used as the immutable asset name. */
  hash: string
  size: number
}

export declare function compileThumbnail(mesh: ThumbnailMesh, options?: ThumbnailOptions): CompiledThumbnail | null
