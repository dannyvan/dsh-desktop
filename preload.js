// preload：在页面（主 world）暴露 window.dshDesktop 桥。
//
// 关键设计：File 对象跨 contextBridge 传递不可靠（getPathForFile 常拿不到路径），
// 所以这里直接监听 window 的 drop 事件（preload 与页面共享 DOM，capture 阶段先于
// 页面脚本执行），就地用 webUtils.getPathForFile 解析出磁盘原始路径，存入数组，
// 页面插件通过 drainDroppedPaths() 取走。
const { contextBridge, webUtils } = require('electron')

let droppedPaths = []

try {
  window.addEventListener('drop', (e) => {
    const dt = e.dataTransfer
    const files = dt ? Array.from(dt.files || []) : []
    if (files.length === 0) return
    const paths = []
    for (const f of files) {
      try {
        const p = webUtils.getPathForFile(f)
        if (p && typeof p === 'string') paths.push(p)
      } catch { /* 单个文件失败不影响其它 */ }
    }
    if (paths.length > 0) {
      droppedPaths = droppedPaths.concat(paths)
      console.log('[dshDesktop] drop 解析到路径:', paths)
    }
  }, true) // capture：即使页面 preventDefault 也能先拿到
} catch { /* 老版本 Electron 无 webUtils 时忽略 */ }

contextBridge.exposeInMainWorld('dshDesktop', {
  platform: process.platform,
  // 后备：直接映射单个 File（能生效时用，但优先 drainDroppedPaths）
  getPathForFile: (file) => {
    try {
      const p = webUtils.getPathForFile(file)
      return typeof p === 'string' && p.length > 0 ? p : null
    } catch { return null }
  },
  // 取走 preload 已解析好的路径（每次调用清空）
  drainDroppedPaths: () => {
    const out = droppedPaths
    droppedPaths = []
    return out
  },
})
