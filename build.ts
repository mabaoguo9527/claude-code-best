import { readdir, readFile, writeFile, cp } from 'fs/promises'
import { join } from 'path'
import { getMacroDefines } from './scripts/defines.ts'
import { DEFAULT_BUILD_FEATURES } from './scripts/defines.ts'

// ─────────────────────────────────────────────────────────────────────────────
// build.ts — 构建流水线（bun run build）
//
// 五步：清场 → 打包 → Node 兼容 patch → 拷 vendor → 生成双运行时入口
//
// 与 scripts/dev.ts（开发直跑源码）的区别：
//   - dev 模式不产出任何文件，MACRO/feature 由 Bun 运行时参数注入
//   - 本脚本把 MACRO/feature 编译期固化为常量，产物自包含，脱离源码仓库运行
//   - 产物同时兼容 Node 与 Bun（见 Step 3 的两轮 patch）
// 产物用途：npm 发布（files 白名单只带 dist/），bin 入口为 dist/cli-node.js
// ─────────────────────────────────────────────────────────────────────────────

// 产物输出目录（.gitignore 已排除；npm files 白名单第 1 项）
const outdir = 'dist'

// Step 1: 清场 — 删除上一次构建的全部产物，保证 dist/ 内容只来自本次构建
const { rmSync } = await import('fs')
rmSync(outdir, { recursive: true, force: true })

// 收集环境变量里的运行时开关（FEATURE_X=1 → 'X'），与默认集合并去重。
// 这些 flag 会在打包时被编译期固化：feature('X') 替换成 true/false，
// 关闭的分支随后被摇树移除，不会出现在产物里。
const envFeatures = Object.keys(process.env)
  .filter(k => k.startsWith('FEATURE_'))
  .map(k => k.replace('FEATURE_', ''))
const features = [...new Set([...DEFAULT_BUILD_FEATURES, ...envFeatures])]

// Step 2: 打包 — Bun.build + 代码分割，产出 dist/cli.js + chunks/
const result = await Bun.build({
  // 唯一入口：CLI 的 true entrypoint（内部再动态加载 main.tsx）
  entrypoints: ['src/entrypoints/cli.tsx'],
  outdir,
  // target 决定内置模块（node:* 等）的处理方式；产物经 Step 3 patch 后 node 也能跑
  target: 'bun',
  // 代码分割：必须开启。Bun/JSC 对单文件大 bundle 全量编译，17MB 单文件
  // 导致 RSS ~1GB；拆成数百个小 chunk 后按需加载，--version RSS 降到 ~35MB
  splitting: true,
  // linked = 生成独立 .map 文件并在产物末尾追加 sourceMappingURL 注释
  sourcemap: 'linked',
  // 编译期常量替换（与 dev.ts 的 -d 注入共用 scripts/defines.ts 这一份定义）
  define: {
    ...getMacroDefines(),
    // React production mode — eliminates _debugStack Error objects
    // (6,889 objects × ~1.7KB = 12MB in development builds) and removes
    // prop-type / key warnings not useful in a production CLI tool.
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  features,
})

// 打包失败：打印全部构建日志并以非零码退出，让 CI / npm 钩子感知失败
if (!result.success) {
  console.error('Build failed:')
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}

// Step 3a: Node 兼容 patch #1 — 替换 Bun 专属的 import.meta.require。
// Node 没有这个语法，解析器碰到直接 SyntaxError，必须替换成回退写法：
// Bun 下用原生的，Node 下用 createRequire(import.meta.url) 达到同样效果。
const files = await readdir(outdir)
const IMPORT_META_REQUIRE = 'var __require = import.meta.require;'
const COMPAT_REQUIRE = `var __require = typeof import.meta.require === "function" ? import.meta.require : (await import("module")).createRequire(import.meta.url);`

let patched = 0
for (const file of files) {
  if (!file.endsWith('.js')) continue
  const filePath = join(outdir, file)
  const content = await readFile(filePath, 'utf-8')
  if (content.includes(IMPORT_META_REQUIRE)) {
    await writeFile(
      filePath,
      content.replace(IMPORT_META_REQUIRE, COMPAT_REQUIRE),
    )
    patched++
  }
}

// Step 3b: Node 兼容 patch #2 — 给第三方依赖裸写的 globalThis.Bun 解构加守卫
// （e.g. @anthropic-ai/sandbox-runtime）。Node 下 globalThis.Bun 是 undefined，
// 不加守卫的话解构即 TypeError，import 阶段就崩。兜底给空对象让 import 先过。
let bunPatched = 0
const BUN_DESTRUCTURE = /var \{([^}]+)\} = globalThis\.Bun;?/g
const BUN_DESTRUCTURE_SAFE =
  'var {$1} = typeof globalThis.Bun !== "undefined" ? globalThis.Bun : {};'
for (const file of files) {
  if (!file.endsWith('.js')) continue
  const filePath = join(outdir, file)
  const content = await readFile(filePath, 'utf-8')
  if (BUN_DESTRUCTURE.test(content)) {
    await writeFile(
      filePath,
      content.replace(BUN_DESTRUCTURE, BUN_DESTRUCTURE_SAFE),
    )
    bunPatched++
  }
}
// 重置 lastIndex：带 /g 的正则 test() 会推进内部指针，复用前必须归零
BUN_DESTRUCTURE.lastIndex = 0

console.log(
  `Bundled ${result.outputs.length} files to ${outdir}/ (patched ${patched} for import.meta.require, ${bunPatched} for Bun destructure)`,
)

// Step 4: 拷贝二进制 vendor — 这些是原生/预编译文件，走不了打包，只能整目录复制。
// 运行时由 src/utils/distRoot.ts 的 distRoot() 按 import.meta.url 定位到 dist/vendor/。
// audio-capture：语音输入（VOICE_MODE）的 native .node 插件源目录
const audioCaptureDir = join(outdir, 'vendor', 'audio-capture')
await cp('vendor/audio-capture', audioCaptureDir, { recursive: true })
console.log(`Copied vendor/audio-capture/ → ${audioCaptureDir}/`)

// ripgrep：Grep 工具的二进制引擎（多平台预编译版本，gitignore 掉 src/utils/vendor/ 之外的副本）
const ripgrepDir = join(outdir, 'vendor', 'ripgrep')
await cp('src/utils/vendor/ripgrep', ripgrepDir, { recursive: true })
console.log(`Copied src/utils/vendor/ripgrep/ → ${ripgrepDir}/`)

// Step 5: 生成两个两行的可执行入口，分别指向不同运行时的 shebang。
// 业务逻辑只有一份（cli.js + chunks/），入口只负责声明「直接执行我时用谁」：
//   cli-node.js → #!/usr/bin/env node  （npm bin 的 ccb / claude-code-best）
//   cli-bun.js  → #!/usr/bin/env bun   （npm bin 的 ccb-bun，启动更快）
// 本体 cli.js 自己的 shebang 是 bun，仅影响直接 ./cli.js 时的默认解释器。
const cliBun = join(outdir, 'cli-bun.js')
const cliNode = join(outdir, 'cli-node.js')

await writeFile(cliBun, '#!/usr/bin/env bun\nimport "./cli.js"\n')

await writeFile(cliNode, '#!/usr/bin/env node\nimport "./cli.js"\n')

// 直接执行入口需要 x 位（内核 execve 的硬要求）；
// 755 = 属主 rwx + 其他人 r-x。cli.js 不 chmod，它不是给人直接执行的。
const { chmodSync } = await import('fs')
chmodSync(cliBun, 0o755)
chmodSync(cliNode, 0o755)

console.log(`Generated ${cliBun} (shebang: bun) and ${cliNode} (shebang: node)`)
