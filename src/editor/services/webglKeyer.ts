import {
  CHROMA_KEY_DEFAULTS,
  despillParams,
  parseHexColor,
  rgbToChromaUV,
  type ChromaKey,
} from '../core/chromaKey'

/**
 * 抠像的画面处理器接口（core 只认这个接口，不直接依赖 WebGL）。
 * 返回一张「已抠像、带 alpha」的画布，尺寸由调用方决定。
 */
export interface KeyFrameProcessor {
  /**
   * 把 source 的 (sx, sy, sw, sh) 区域抠像并输出到 width×height。
   * 失败（WebGL 不可用 / 上下文丢失）时返回 null，调用方退回原画面。
   */
  keyFrame(
    source: CanvasImageSource,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    width: number,
    height: number,
    key: ChromaKey,
  ): CanvasImageSource | null
}

const VERTEX_SHADER = `
attribute vec2 a_position;
varying vec2 v_uv;
void main() {
  v_uv = vec2((a_position.x + 1.0) * 0.5, 1.0 - (a_position.y + 1.0) * 0.5);
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`

/**
 * 片元着色器 = core/chromaKey.ts 的 GLSL 翻译：
 * - RGB → U/V 用同一套 FFmpeg 定点系数（这里用浮点等价式，误差 < 1/255）。
 * - 3×3 邻域平均后按 sqrt((du²+dv²)/(255²·2)) 算 diff。
 * - alpha = clamp((diff - similarity)/blend, 0, 1)；blend≈0 时二值。
 * - despill 按 vf_despill.c：spillmap = max(g - (r·mix + b·factor), 0)，绿通道 -= spillmap。
 */
const FRAGMENT_SHADER = `
precision mediump float;
// 顶点着色器输出的插值坐标；GLSL 里 fragment 也必须显式声明才能使用
// （漏了这行会让着色器编译失败，抠像静默退回原画面）。
varying vec2 v_uv;
uniform sampler2D u_texture;
uniform vec2 u_texel;
uniform vec2 u_keyUV;
uniform float u_similarity;
uniform float u_blend;
uniform float u_spill;      // 0 = 不 despill
uniform float u_spillType;  // 0 = green, 1 = blue
uniform float u_mix;
uniform float u_expand;

vec2 rgbToUV(vec3 c) {
  float u = -0.16874 * c.r - 0.33126 * c.g + 0.50000 * c.b + 0.5;
  float v =  0.50000 * c.r - 0.41869 * c.g - 0.08131 * c.b + 0.5;
  return vec2(u, v) * 255.0;
}

float diffAt(vec2 uv) {
  vec2 d = rgbToUV(texture2D(u_texture, uv).rgb) - u_keyUV;
  return sqrt((d.x * d.x + d.y * d.y) / (255.0 * 255.0 * 2.0));
}

void main() {
  vec2 uv = v_uv;
  float diff = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      diff += diffAt(uv + vec2(float(x), float(y)) * u_texel);
    }
  }
  diff /= 9.0;

  float alpha;
  if (u_blend > 0.0001) {
    alpha = clamp((diff - u_similarity) / u_blend, 0.0, 1.0);
  } else {
    alpha = diff > u_similarity ? 1.0 : 0.0;
  }

  vec3 color = texture2D(u_texture, uv).rgb;
  if (u_spill > 0.0001) {
    float factor = (1.0 - u_mix) * (1.0 - u_expand);
    float spillmap = u_spillType > 0.5
      ? max(color.b - (color.r * u_mix + color.g * factor), 0.0)
      : max(color.g - (color.r * u_mix + color.b * factor), 0.0);
    // 默认 redscale=0 / greenscale=-1 / bluescale=0
    color.g = max(color.g - spillmap, 0.0);
  }
  gl_FragColor = vec4(color, alpha);
}
`

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader)
    return null
  }
  return shader
}

interface KeyerState {
  gl: WebGLRenderingContext
  program: WebGLProgram
  uniforms: Record<string, WebGLUniformLocation | null>
  canvas: HTMLCanvasElement
  texture: WebGLTexture
  buffer: WebGLBuffer
  vertex: WebGLShader
  fragment: WebGLShader
}

let state: KeyerState | null = null
/**
 * 上下文丢失后**保留** canvas 与 gl，等 `webglcontextrestored` 到来时复用它们重建。
 *
 * 浏览器在 `preventDefault()` 之后会把**同一个**上下文恢复可用；如果此时把引用丢掉、
 * 下一次 isKeyerAvailable() 新建 canvas + 新上下文，就等于每次 GPU 复位都泄漏一个
 * 活跃上下文（浏览器上限约 8–16 个，超了会开始回收**其它**画布的上下文 → 预览黑屏）。
 */
let lost: { canvas: HTMLCanvasElement; gl: WebGLRenderingContext } | null = null
/** 上下文是否丢失（丢失时禁用并等待 restored）。 */
let contextLost = false
/** 只提示一次「WebGL 不可用」。 */
let warnedUnavailable = false
/**
 * 失败原因。
 *
 * 确定性失败（着色器编译/链接失败、无 document）**永久缓存**——isKeyerAvailable()
 * 每帧都会被调用，不缓存就会每帧 createElement('canvas') + getContext('webgl')，
 * 既慢又把 WebGL 上下文用尽。
 *
 * 瞬时失败（拿不到上下文 / 抛异常，典型原因是页面里别的 canvas 正占着配额）
 * 只做冷却 + 次数上限的重试：否则一次偶发失败会让抠像在**整个会话**里静默失效。
 */
let failureReason: string | null = null
let failedAttempts = 0
let lastFailureAt = 0

/** 冷却时间：期间的调用继续返回 false，但不会再新建上下文。 */
const FAILURE_RETRY_MS = 3000
/** 瞬时失败最多重试这么多次，避免每 3 秒一次的无限重建。 */
const MAX_FAILED_ATTEMPTS = 8

/** 只有「可能自己好了」的失败才允许重试。 */
function isRetryableFailure(reason: string): boolean {
  return reason === 'no-context' || reason === 'exception' || reason === 'restore-failed'
}

/** 已经创建出来的 GL 对象，失败/丢失时要显式删除。 */
interface GlObjects {
  vertex?: WebGLShader | null
  fragment?: WebGLShader | null
  program?: WebGLProgram | null
  buffer?: WebGLBuffer | null
  texture?: WebGLTexture | null
}

/**
 * 释放一个 WebGL 上下文及其对象。
 *
 * 光把引用置空不够：上下文本身要显式 loseContext()，否则浏览器会一直把它算在
 * 「活跃上下文」里（同一页面能创建的上下文数量有限）。
 */
function releaseContext(gl: WebGLRenderingContext, objects: GlObjects = {}): void {
  try {
    if (objects.texture) gl.deleteTexture(objects.texture)
    if (objects.buffer) gl.deleteBuffer(objects.buffer)
    if (objects.program) gl.deleteProgram(objects.program)
    if (objects.vertex) gl.deleteShader(objects.vertex)
    if (objects.fragment) gl.deleteShader(objects.fragment)
  } catch {
    // 上下文可能已经丢失：delete* 会失效，忽略。
  }
  try {
    const ext = gl.getExtension('WEBGL_lose_context')
    ext?.loseContext()
  } catch {
    // 扩展不可用时无法主动释放，只能等 GC。
  }
}

/** 在给定上下文上（重新）搭建 program / buffer / texture。 */
function buildState(gl: WebGLRenderingContext, canvas: HTMLCanvasElement): KeyerState | null {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
  if (!vertex || !fragment) {
    if (vertex) gl.deleteShader(vertex)
    if (fragment) gl.deleteShader(fragment)
    return null
  }
  const program = gl.createProgram()
  if (!program) {
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    return null
  }
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program)
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    return null
  }
  gl.useProgram(program)

  // 全屏三角带
  const buffer = gl.createBuffer()
  if (!buffer) {
    gl.deleteProgram(program)
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    return null
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  )
  const position = gl.getAttribLocation(program, 'a_position')
  gl.enableVertexAttribArray(position)
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)

  const uniforms: Record<string, WebGLUniformLocation | null> = {}
  for (const name of [
    'u_texture',
    'u_texel',
    'u_keyUV',
    'u_similarity',
    'u_blend',
    'u_spill',
    'u_spillType',
    'u_mix',
    'u_expand',
  ]) {
    uniforms[name] = gl.getUniformLocation(program, name)
  }

  const texture = gl.createTexture()
  if (!texture) {
    gl.deleteBuffer(buffer)
    gl.deleteProgram(program)
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    return null
  }
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

  return { gl, canvas, program, uniforms, texture, buffer, vertex, fragment }
}

/**
 * 挂上上下文丢失/恢复监听（每个 canvas 只挂一次）。
 *
 * 关键：丢失时保留 canvas + gl（`lost`），恢复时**在同一个上下文上重建** program/texture，
 * 既不泄漏上下文，也不需要用户刷新页面。
 */
function attachContextListeners(canvas: HTMLCanvasElement, gl: WebGLRenderingContext): void {
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault()
    contextLost = true
    const current = state
    state = null
    // GL 对象随上下文一起失效，无需 delete；但要留下 canvas/gl 供 restored 复用。
    lost = { canvas: current?.canvas ?? canvas, gl: current?.gl ?? gl }
    console.warn('[webglKeyer] WebGL 上下文丢失，等待恢复（期间退回原画面）')
  })
  canvas.addEventListener('webglcontextrestored', () => {
    const target = lost
    lost = null
    contextLost = false
    failureReason = null
    failedAttempts = 0
    if (!target) return
    const rebuilt = buildState(target.gl, target.canvas)
    if (rebuilt) {
      state = rebuilt
      console.info('[webglKeyer] WebGL 上下文已恢复，抠像继续可用')
    } else {
      // 恢复失败：允许下一帧重新建一个上下文（次数受 MAX_FAILED_ATTEMPTS 限制）。
      failureReason = 'restore-failed'
      lastFailureAt = Date.now()
      failedAttempts += 1
    }
  })
}

/** 是否可用（不可用时调用方应退回 CPU / 原画面）。 */
export function isKeyerAvailable(): boolean {
  // 已经成功创建：直接复用（上下文只创建一次）。
  if (state) return true
  // 上下文丢失/等待恢复：期间不要新建任何上下文。
  if (contextLost || lost) return false
  if (typeof document === 'undefined') {
    failureReason = 'no-document'
    return false
  }
  if (failureReason !== null) {
    // 确定性失败（着色器编译/链接）不再重试；瞬时失败按冷却 + 次数上限重试。
    if (!isRetryableFailure(failureReason)) return false
    if (failedAttempts >= MAX_FAILED_ATTEMPTS) return false
    if (Date.now() - lastFailureAt < FAILURE_RETRY_MS) return false
    failureReason = null
  }

  let gl: WebGLRenderingContext | null = null
  const objects: GlObjects = {}
  /** 统一失败出口：缓存原因 + 释放已创建的一切。 */
  const fail = (reason: string): false => {
    failureReason = reason
    lastFailureAt = Date.now()
    failedAttempts += 1
    if (gl) releaseContext(gl, objects)
    gl = null
    return false
  }

  try {
    const canvas = document.createElement('canvas')
    gl = canvas.getContext('webgl', {
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    }) as WebGLRenderingContext | null
    if (!gl) return fail('no-context')

    const built = buildState(gl, canvas)
    if (!built) {
      // buildState 内部已删掉编译失败/链接失败的对象；这里只需保证上下文被释放。
      return fail('shader-compile')
    }
    objects.program = built.program
    objects.buffer = built.buffer
    objects.texture = built.texture
    attachContextListeners(canvas, gl)
    state = built
    failedAttempts = 0
    lastFailureAt = 0
    return true
  } catch (error) {
    // 抛异常（如浏览器限制上下文数量）同样缓存并释放，避免每帧重试。
    void error
    return fail('exception')
  }
}

/** WebGL 不可用时调用一次（用于只提示一次）。 */
export function takeKeyerUnavailableNotice(): boolean {
  if (warnedUnavailable) return false
  warnedUnavailable = true
  return true
}

/**
 * 全局唯一的 WebGL 抠像处理器：上下文只创建一次，纹理按尺寸复用。
 * 处理失败返回 null（调用方退回原画面，不崩）。
 */
export const webglKeyer: KeyFrameProcessor = {
  keyFrame(source, sx, sy, sw, sh, width, height, key) {
    if (!isKeyerAvailable() || !state) return null
    const { gl, program, uniforms, canvas, texture } = state
    if (width <= 0 || height <= 0) return null
    try {
      // 画布/纹理按尺寸复用（浏览器对上下文与显存都有限制）。
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }
      const view = gl.canvas as HTMLCanvasElement
      if (view.width !== width || view.height !== height) {
        view.width = width
        view.height = height
      }
      gl.viewport(0, 0, width, height)
      gl.useProgram(program)

      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, texture)
      // 只上传裁切区域：先把源画到一张临时 2D 画布再上传（WebGL1 不支持源矩形）。
      const staging = stagingCanvas(sw, sh)
      const stagingCtx = staging?.getContext('2d')
      if (!staging || !stagingCtx) return null
      stagingCtx.setTransform(1, 0, 0, 1, 0, 0)
      stagingCtx.clearRect(0, 0, sw, sh)
      stagingCtx.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, staging)
      gl.uniform1i(uniforms['u_texture'] ?? null, 0)
      gl.uniform2f(uniforms['u_texel'] ?? null, 1 / Math.max(1, sw), 1 / Math.max(1, sh))

      const [r, g, b] = parseHexColor(key.color)
      const { u, v } = rgbToChromaUV(r, g, b)
      gl.uniform2f(uniforms['u_keyUV'] ?? null, u, v)
      gl.uniform1f(uniforms['u_similarity'] ?? null, key.similarity)
      gl.uniform1f(uniforms['u_blend'] ?? null, key.blend)
      const spill = despillParams(key)
      gl.uniform1f(uniforms['u_spill'] ?? null, spill ? key.spill : 0)
      gl.uniform1f(uniforms['u_spillType'] ?? null, spill?.type === 'blue' ? 1 : 0)
      gl.uniform1f(uniforms['u_mix'] ?? null, spill?.mix ?? 0.5)
      gl.uniform1f(uniforms['u_expand'] ?? null, spill?.expand ?? 0)

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      return canvas
    } catch {
      return null
    }
  },
}

/** 上传用的暂存画布（按裁切尺寸复用）。 */
let staging: HTMLCanvasElement | null = null
function stagingCanvas(width: number, height: number): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null
  if (!staging) staging = document.createElement('canvas')
  if (staging.width !== width) staging.width = width
  if (staging.height !== height) staging.height = height
  return staging
}

/** 测试用：重置单例状态。 */
export function resetKeyerForTest(): void {
  if (state) {
    releaseContext(state.gl, {
      program: state.program,
      texture: state.texture,
      buffer: state.buffer,
      vertex: state.vertex,
      fragment: state.fragment,
    })
  }
  if (lost) releaseContext(lost.gl, {})
  state = null
  lost = null
  contextLost = false
  warnedUnavailable = false
  failureReason = null
  failedAttempts = 0
  lastFailureAt = 0
  staging = null
}

/** 抠像默认参数的再导出，方便 UI 直接引用。 */
export { CHROMA_KEY_DEFAULTS }