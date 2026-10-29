# 沪上插班生视频优化 (HuShang Video Optimizer)

[![UserScript](https://img.shields.io/badge/Userscript-Tampermonkey%20%7C%20ScriptCat%20%7C%20Userscripts-blue)](https://www.tampermonkey.net/)
[![Platform](https://img.shields.io/badge/Platform-wq.bunanguo.com-green)](https://wq.bunanguo.com/)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](./LICENSE)

专为**沪上插班生**（`wq.bunanguo.com` / `bunanguo.com`）学习网课平台打造的油猴用户脚本。

保留官方原版播放器界面，优化控制条交互体验（鼠标/触摸移动即呼出、静止约 3 秒平滑隐藏、拖拽进度条常驻不消失），支持普通与全屏双模式，同时集成智能后台防暂停与视频去水印。

按浏览器选择**其中一个**版本安装：

| 版本 | 适用浏览器 |
| :--- | :--- |
| [`沪上插班生视频优化.user.js`](./沪上插班生视频优化.user.js) | Chrome、Edge、Firefox、Brave 等 |
| [`沪上插班生视频优化-Safari.user.js`](./沪上插班生视频优化-Safari.user.js) | macOS / iOS / iPadOS Safari |

---

## 🌟 核心功能

### 1. 智能后台播放防暂停
- **原生 API 伪装**：自动重写 `document.visibilityState`、`document.hidden` 以及 `document.hasFocus()`，向页面代码伪装为窗口始终处于活跃状态。
- **失焦事件拦截**：在捕获阶段拦截并阻断 `visibilitychange` 事件派发。
- **精准防御 `pause()` 调用**：拦截页面在后台静默触发的 `HTMLMediaElement.prototype.pause()`，网页尝试暂停的指令直接被忽略。
- **用户操作智能识别**：在前台主动点击暂停/播放完全不受干扰，贴合日常学习操作习惯。
- **看门狗自愈守护**：后台若因网络波动或异常导致视频中断，自动唤醒视频恢复播放。

### 2. 视频水印净化与隐藏
- **全局样式级阻断**：自动向页面根节点注入高优先级样式规则（`!important`），无感隐藏视频插槽中的水印文本与浮层（`.video-watermark`, `.video-watermark-text`）。
- **零开销即时生效**：纯 CSS 规则驱动，无需轮询或 DOM 监听损耗性能，兼容 uni-app 播放器组件的动态渲染。
- **独立控制接口**：全局挂载 `__hsWatermarkRemover`（同时兼容 `__tabbit_watermark_remover__`）控制器，支持在控制台随时切换显示/隐藏或自定义选择器范围。

### 3. 播放器控件显示优化
- **交互动态感知**：监听鼠标移动、触控及指针操作，检测到用户活动立即平滑显示控制栏；静止约 3 秒无操作后自动收起。
- **拖拽防误触锁定**：拖动进度条滑块或调节音量时自动锁定控件常驻，松手后才恢复静止倒计时隐藏。
- **普通与全屏双模式覆盖**：针对 uni-app 视频播放器的行内 `transform: translateY(±100%)` 样式进行全局 `!important` 覆盖，同时适配普通内嵌播放模式与全屏模式。

---

## 🚀 安装使用

### 前提准备
1. 确保已安装现代浏览器（如 Chrome、Edge、Firefox、Safari、Brave 等）。
2. 安装一款用户脚本管理器扩展：
   - [Tampermonkey（篡改猴）](https://www.tampermonkey.net/)（推荐）
   - [ScriptCat（脚本猫）](https://docs.scriptcat.org/)
   - [Violentmonkey（暴力猴）](https://violentmonkey.github.io/)
   - Safari：[Userscripts](https://github.com/quoid/userscripts)（App Store 免费开源）、Tampermonkey for Safari 或 Stay

### 方式一：在线一键安装（推荐）
点击进入 [`沪上插班生视频优化.user.js`](./沪上插班生视频优化.user.js)，点击页面右上角的 **`Raw`** 按钮，脚本管理器将自动识别并弹出安装界面，点击「安装」或「更新」即可。

### 方式二：手动导入
1. 打开对应脚本并复制全部代码。
2. 打开脚本管理器控制面板，选择「添加新脚本」。
3. 清空默认内容并将复制的代码粘贴进去，按 `Ctrl + S`（Mac 上为 `Cmd + S`）保存即可。

### Safari 用户
Safari 请安装 **[`沪上插班生视频优化-Safari.user.js`](./沪上插班生视频优化-Safari.user.js)**（不要与原版同时启用）。

1. 安装上面列出的任一 Safari 脚本管理器。
2. 在 Safari「设置 → 扩展」中启用该扩展，并允许它访问 `bunanguo.com`。
3. 把脚本导入管理器（Userscripts 可直接把文件放进其脚本目录，或在扩展弹窗中新建脚本后粘贴代码）。
4. 刷新播放页，右上角出现「沪上插班生视频优化 (Safari) 已就绪」即生效。

与原版相比：
- 自动判断脚本运行在扩展隔离环境还是页面环境，只注入一份；页面 CSP 禁止内联脚本时退回直接运行。
- 只拦截后台对**当前正在播放的主视频**的 `pause()`；通过媒体键、控制中心或耳机暂停时不会被强制恢复。
- 切回页面不再盲目跳帧：只有时间轴在走、画面却停止更新时，才在已缓冲范围内微跳，每次切回最多两次。画中画、AirPlay、纯音频不检测。
- 修正原版中切回前台的检测实际不触发、切课后帧监控失效、拖动时把指针移出窗口松开后控件不再隐藏的问题。

> iOS / iPadOS 上 Safari 会在切到后台后挂起整个页面并暂停媒体，脚本无法阻止；后台防暂停主要对 macOS Safari 有效。

---

## 🛠️ 控制台调试与高级调优 API

以下接口两个版本通用，可在浏览器开发者工具（F12 控制台）中调用。

### 1. 控件控制器 (`__hsPlayerControlsFix`)

```javascript
// 1. 立即呼出播放器控件
__hsPlayerControlsFix.showNow();

// 2. 立即隐藏播放器控件
__hsPlayerControlsFix.hideNow();

// 3. 固定控制栏常驻显示（不自动隐藏）
__hsPlayerControlsFix.run({ mode: "pin" });

// 4. 恢复默认行为（移动显示，静止 3 秒自动隐藏）
__hsPlayerControlsFix.run({ mode: "move", idle_ms: 3000 });

// 5. 获取当前控件与监听状态
console.log(__hsPlayerControlsFix.getState());

// 6. 销毁并还原页面初始默认行为
__hsPlayerControlsFix.destroy();
```

### 2. 视频水印控制器 (`__hsWatermarkRemover`)

同时兼容 `window.__tabbit_watermark_remover__`：

```javascript
// 1. 获取当前水印隐藏状态及匹配元素数量
console.log(__hsWatermarkRemover.getState());

// 2. 临时恢复显示水印
__hsWatermarkRemover.show();

// 3. 重新隐藏水印
__hsWatermarkRemover.hide();

// 4. 自定义水印 scope 重新初始化（默认 scope 为 "video-watermark"）
__hsWatermarkRemover.run({ scope: "video-watermark" });

// 5. 销毁并移除注入的水印样式
__hsWatermarkRemover.destroy();
```

### 本地测试

```bash
node --test tests/*.test.cjs
```

---

## ❓ 常见问题 (FAQ)

**Q：原版和 Safari 版应该同时安装吗？**  
A：不要。按所用浏览器只启用其中一个，同时启用会重复注入。

**Q：为什么我在前台点击视频画面或暂停键时，视频依然可以暂停？**  
A：这是特意设计的机制。脚本会精确区分“网页后台触发的防作弊暂停”与“用户在前台的主动操作”。你在前台点击暂停完全有效，不会出现无法暂停的问题。

**Q：更换视频集数时需要刷新页面吗？**  
A：不需要。脚本会监听 DOM 动态变化，切集换课时自动接管新的播放器。

**Q：为什么切换标签页或最小化回来后，容易出现声音还在放而画面卡住的情况？**  
A：后台渲染调度、解码器或网络异常都可能有关，不能仅凭症状确定原因。脚本在切回前台时会通过帧监控检测画面停滞并在已缓冲范围内微跳同步；恢复不保证成功，仍卡住时请刷新页面。

**Q：之前的「开源播放器替换版 (Plyr)」去哪了？**  
A：已移除，不再维护。如仍安装着 `沪上插班生视频播放器替换.user.js`，请在脚本管理器中删除或禁用它，改用本脚本。

---

## 📄 开源许可 (License)

本项目基于 [GNU General Public License v3.0 (GPL-3.0)](./LICENSE) 开放源代码。仅供交流与个人提升学习体验使用，请勿用于违反法律法规或破坏平台正常运营之用途。
