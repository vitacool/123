// Minimal declarations for the parts of onnxruntime-web the VAD worker uses.
// (The package's own `types.d.ts` cannot resolve under `moduleResolution:
// bundler` because its `exports` map carries no `types` condition.)
declare module 'onnxruntime-web' {
  export interface Tensor {
    readonly data: Float32Array | BigInt64Array
    readonly dims: readonly number[]
    readonly type: string
  }

  export const Tensor: {
    new (type: 'float32', data: Float32Array, dims: number[]): Tensor
    new (type: 'int64', data: BigInt64Array, dims: number[]): Tensor
  }

  export interface InferenceSession {
    readonly inputNames: string[]
    readonly outputNames: string[]
    run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>
  }

  export const InferenceSession: {
    create(
      path: string,
      options?: { executionProviders?: string[] },
    ): Promise<InferenceSession>
  }

  export const env: {
    wasm: { wasmPaths?: string; numThreads?: number }
  }
}