process.env.BUN_INSPECT = 'localhost:8888/2dc3gzl5xot'
await import('./dev')

// 使本文件被识别为 ES 模块（顶层 await 要求）
export {}
