import { cp, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const publicDir = join(root, 'public', 'ffmpeg')

const bundles = [
  {
    // The @ffmpeg/ffmpeg class worker runs as an ES module under Vite, so the
    // ESM core (which default-exports createFFmpegCore) is required.
    from: join(root, 'node_modules', '@ffmpeg', 'core', 'dist', 'esm'),
    to: join(publicDir, 'core'),
    files: ['ffmpeg-core.js', 'ffmpeg-core.wasm'],
  },
  {
    from: join(root, 'node_modules', '@ffmpeg', 'core-mt', 'dist', 'esm'),
    to: join(publicDir, 'core-mt'),
    files: ['ffmpeg-core.js', 'ffmpeg-core.wasm', 'ffmpeg-core.worker.js'],
  },
]

for (const bundle of bundles) {
  if (!existsSync(bundle.from)) {
    throw new Error(
      `Missing ${bundle.from}. Run the package install before preparing the FFmpeg runtime.`,
    )
  }
  await rm(bundle.to, { recursive: true, force: true })
  await mkdir(bundle.to, { recursive: true })
  for (const file of bundle.files) {
    await cp(join(bundle.from, file), join(bundle.to, file))
  }
  console.log(`[ffmpeg] copied ${bundle.files.length} files -> ${bundle.to}`)
}