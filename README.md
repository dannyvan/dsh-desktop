# DeepSeek Harness Desktop（macOS 壳）

把 DSH Web GUI 套成原生窗口的轻量 Electron 壳。

## 使用

```sh
npm start        # 开发模式启动（自动复用/拉起 dsh web）
npm run dist     # 打包出 dist/DeepSeek Harness Desktop-*.dmg / .zip
```

启动逻辑（main.js）：

1. 探测 `127.0.0.1:3080/3081/3082` 是否有在跑的 DSH 实例 → 有则**复用**；
2. 没有 → 自动 `spawn dsh web --port 3080`（PATH 找不到 dsh 时回退 `npx --yes @deepseek-ai/dsh`）并轮询 `__DSH_BOOT__` 就绪；
3. 打开原生窗口；关窗只杀掉**自己启动**的服务，复用的不误杀。

日志：`~/Library/Logs/DSH Desktop/server.log`

## 拖拽直取原始路径

- `preload.js` 在 **window 捕获阶段**监听 `drop`，用 Electron `webUtils.getPathForFile` 就地解析磁盘路径；
- 页面插件 `dsh-file-drop` 通过 `window.dshDesktop.drainDroppedPaths()` 取走，直接写入输入框草稿 —— 零上传、零复制。

## 文件

```
main.js      主进程：端口探测 / 起服务 / 窗口管理 / 导航拦截
preload.js   注入 window.dshDesktop（getPathForFile / drainDroppedPaths）
```

配套插件：`~/dsh-file-drop/`（dsh 持久插件，含回形针按钮 + 拖拽处理）。
