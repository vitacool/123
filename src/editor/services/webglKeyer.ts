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
}

let state: KeyerState | null = null
/** 上下文是否丢失（丢失时禁用并等待 restored）。 */
let contextLost = false
/** 只提示一次「WebGL 不可用」。 */
let warnedUnavailable = false
/**
 * 失败原因（一旦确定不可用就**永久缓存**）。
 *
 * 为什么必须缓存：isKeyerAvailable() 每帧都会被调用。原来着色器编译/链接失败时
 * 直接 return false 但不记结果，于是每帧都会 createElement('canvas') + getContext('webgl')，
 * 既慢又把 WebGL 上下文用尽（浏览器上限约 8–16 个），最终连正常画面都拿不到。
 */
let failureReason: string | null = null

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

/** 是否可用（不可用时调用方应退回 CPU / 原画面）。 */
export function isKeyerAvailable(): boolean {
  // 已经成功创建：直接复用（上下文只创建一次）。
  if (state) return true
  // 已知不可用（编译失败 / 上下文丢失 / 无 document）：**不再新建任何上下文**。
  if (failureReason !== null) return false
  if (contextLost) return false
  if (typeof document === 'undefined') {
    failureReason = 'no-document'
    return false
  }

  let gl: WebGLRenderingContext | null = null
  const objects: GlObjects = {}
  /** 统一失败出口：缓存原因 + 释放已创建的一切。 */
  const fail = (reason: string): false => {
    failureReason = reason
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

    objects.vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
    objects.fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
    if (!objects.vertex || !objects.fragment) return fail('shader-compile')

    const program = gl.createProgram()
    objects.program = program
    if (!program) return fail('program-create')
    gl.attachShader(program, objects.vertex)
    gl.attachShader(program, objects.fragment)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return fail('program-link')
    gl.useProgram(program)

    // 全屏三角带
    const buffer = gl.createBuffer()
    objects.buffer = buffer
    if (!buffer) return fail('buffer-create')
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
    objects.texture = texture
    if (!texture) return fail('texture-create')
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

    // 上下文丢失/恢复：只创建一次上下文，丢失期间退回原画面（降级）。
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault()
      contextLost = true
      // 对象随上下文一起失效；把引用丢掉，等 restored 后重建。
      state = null
    })
    canvas.addEventListener('webglcontextrestored', () => {
      contextLost = false
      failureReason = null
      state = null
    })

    state = { gl, program, uniforms, canvas, texture }
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
      gl.useProgram(program)!

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
  if (state) releaseContext(state.gl, { program: state.program, texture: state.texture })
  state = null
  contextLost = false
  warnedUnavailable = false
  failureReason = null
  staging = null
}

/** 抠像默认参数的再导出，方便 UI 直接引用。 */
export { CHROMA_KEY_DEFAULTS }