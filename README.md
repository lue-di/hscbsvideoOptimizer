# 沪上插班生视频优化套件 (HuShang Video Optimizer Suite)

[![UserScript](https://img.shields.io/badge/Userscript-Tampermonkey%20%7C%20ScriptCat-blue)](https://www.tampermonkey.net/)
[![Platform](https://img.shields.io/badge/Platform-wq.bunanguo.com-green)](https://wq.bunanguo.com/)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](./LICENSE)

专为**沪上插班生**（`wq.bunanguo.com` / `bunanguo.com`）学习网课平台打造的油猴用户脚本套件。

针对网页播放器的痛点，提供两种定制使用方案（**二选一**）：

1. **方案 A：原生控件优化版 ([`沪上插班生视频优化.user.js`](./沪上插班生视频优化.user.js))**  
   保留官方原版播放器界面，优化控制条交互体验（鼠标/触摸移动即呼出、静止约 3 秒平滑隐藏、拖拽进度条常驻不消失），支持普通与全屏双模式，同时集成智能后台防暂停与视频去水印。

2. **方案 B：开源播放器替换版 ([`沪上插班生视频播放器替换.user.js`](./沪上插班生视频播放器替换.user.js))**  
   使用现代化开源播放器 **Plyr** 接管网页原生播放器，保留原始视频源与 HLS 解码管线，提供全键盘快捷键操控（空格暂停/播放、方向键快进快退与音量调节、M静音、F全屏）、多档倍速、画中画（PiP），自动屏蔽官方冗余浮层与去水印，同样集成智能后台防暂停。

---

## 🌟 核心功能对比与介绍

| 功能特性 | 方案 A：原生控件优化版 | 方案 B：开源播放器替换版 (Plyr) |
| :--- | :---: | :---: |
| **后台切屏防暂停** | ✅ 深度支持（API伪装 + 事件拦截 + 防御 pause + 看门狗自愈） | ✅ 深度支持（与方案 A 一致） |
| **视频水印净化与隐藏** | ✅ 自动隐藏（`.video-watermark`） | ✅ 自动隐藏（`.video-watermark`） |
| **播放器界面风格** | 官方原生播放器 UI（优化自动隐藏） | 现代极简风格 Plyr 开源播放器 UI |
| **全键盘快捷键** | 沿用平台原有交互 | ✅ 支持（空格、方向键、M静音、F全屏） |
| **全屏与画中画 (PiP)** | 官方原生全屏 | 原生全屏 + 浏览器画中画 (PiP) |
| **单页应用 (SPA) 自动适配** | 页面初始化常驻生效 | ✅ 自动监听路由切换与切集换片，无缝挂载 |

### 1. 智能后台播放防暂停
- **原生 API 伪装**：自动重写 `document.visibilityState`、`document.hidden` 以及 `document.hasFocus()`，向页面代码伪装为窗口始终处于活跃状态。
- **失焦事件拦截**：在捕获阶段拦截并阻断 `visibilitychange` 事件派发。
- **精准防御 `pause()` 调用**：拦截页面在后台静默触发的 `HTMLMediaElement.prototype.pause()`，网页尝试暂停的指令直接被忽略。
- **用户操作智能识别**：在前台主动点击暂停/播放完全不受干扰，贴合日常学习操作习惯。
- **看门狗自愈守护**：后台若因网络波动或异常导致视频中断，自动唤醒视频恢复播放。

### 2. 视频水印净化与隐藏
- **全局样式级阻断**：自动向页面根节点注入高优先级样式规则（`!important`），无感隐藏视频插槽中的水印文本与浮层（`.video-watermark`, `.video-watermark-text`）。
- **零开销即时生效**：纯 CSS 规则驱动，无需轮询或 DOM 监听损耗性能，完美兼容 uni-app 播放器组件的动态渲染。
- **独立控制接口**：全局挂载 `__hsWatermarkRemover`（同时兼容 `__tabbit_watermark_remover__`）控制器，支持在控制台随时切换显示/隐藏或自定义选择器范围。

### 3. [方案 A] 播放器控件显示优化
- **交互动态感知**：监听鼠标移动、触控及指针操作，检测到用户活动立即平滑显示控制栏；静止约 3 秒无操作后自动收起。
- **拖拽防误触锁定**：拖动进度条滑块或调节音量时自动锁定控件常驻，松手后才恢复静止倒计时隐藏。
- **普通与全屏双模式覆盖**：针对 uni-app 视频播放器的行内 `transform: translateY(±100%)` 样式进行全局 `!important` 覆盖，同时完美适配普通内嵌播放模式与全屏模式。

### 4. [方案 B] 开源播放器 Plyr 接管
- **无损视频接管**：直接接管页面现有的原生 `<video>`，不修改视频源、加密或 HLS 解码管线。
- **多功能控制台**：包含大播放按钮、进度拖拽、多级倍速播放（0.5x ~ 2x）、音量调节、画中画与全屏。
- **全键盘快捷键**：
  - `Space`（空格键）：播放 / 暂停
  - `→`（右方向键）：快进 10 秒
  - `←`（左方向键）：快退 10 秒
  - `↑`（上方向键）：音量增加 5%
  - `↓`（下方向键）：音量减少 5%
  - `M` 键：静音 / 取消静音
  - `F` 键：进入 / 退出全屏（显示器系统全屏）
  - `W` 键：进入 / 退出**网页全屏**（铺满浏览器视口，不遮挡浏览器标签栏）
  - `Esc` 键：退出网页全屏

---

## 🚀 安装使用

### 前提准备
1. 确保已安装现代浏览器（如 Chrome、Edge、Firefox、Safari、Brave 等）。
2. 安装一款用户脚本管理器扩展：
   - [Tampermonkey（篡改猴）](https://www.tampermonkey.net/)（推荐）
   - [ScriptCat（脚本猫）](https://docs.scriptcat.org/)
   - [Violentmonkey（暴力猴）](https://violentmonkey.github.io/)

### 安装步骤

#### 方式一：在线一键安装（推荐，二选一）
根据个人喜好选择安装其中一个方案即可：

- 🌟 **[方案 A] 官方控件优化版：[`沪上插班生视频优化.user.js`](./沪上插班生视频优化.user.js)**
- 🎬 **[方案 B] 开源播放器替换版：[`沪上插班生视频播放器替换.user.js`](./沪上插班生视频播放器替换.user.js)**

点击进入对应的脚本文件，点击页面右上角的 **`Raw`** 按钮，脚本管理器将自动识别并弹出安装界面，点击「安装」或「更新」即可。

#### 方式二：手动导入
1. 打开对应脚本并复制全部代码。
2. 打开脚本管理器控制面板，选择「添加新脚本」。
3. 清空默认内容并将复制的代码粘贴进去，按 `Ctrl + S`（Mac 上为 `Cmd + S`）保存即可。

---

## 🛠️ 控制台调试与高级调优 API

### 1. 方案 A 控制器 (`__hsPlayerControlsFix`)

安装「方案 A」后，可在浏览器开发者工具（F12 控制台）动态调优：

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

### 2. 方案 B 控制器 (`__tbVideoPlayer` / `__hsPlayerReplacer`)

安装「方案 B」后，可在控制台随时查看播放器实例与状态：

```javascript
// 1. 获取当前播放状态（暂停、当前时间、总时长、音量、倍速、网页全屏状态）
console.log(__tbVideoPlayer.state());

// 2. 访问底层 Plyr 播放器实例与原生 video
console.log(__tbVideoPlayer.player);
console.log(__tbVideoPlayer.video);

// 3. 切换网页全屏 / 查询网页全屏状态
__tbVideoPlayer.toggleWebFs();
console.log(__tbVideoPlayer.isWebFs());

// 4. 销毁 Plyr 并还原页面原始播放器状态
__tbVideoPlayer.destroy();

// 5. 加载卡住时查看诊断（不记录视频 URL、签名或令牌）
console.log(JSON.stringify(__tbVideoPlayer.recovery.state(), null, 2));

// 6. 手动尝试一次恢复（仍遵守冷却时间和重试上限）
__tbVideoPlayer.recovery.retry();
```

#### 方案 B 1.3.0：加载停滞恢复

- 播放进度连续约 12 秒不动时尝试恢复；暂停、拖动、后台、离线时不触发。
- 优先在已有缓冲内微跳，或跨过不超过 0.5 秒的缓冲间隙；每次尝试间隔至少 15 秒。
- 普通 HTTP(S) 媒体且时长已知时，每次卡顿最多重载一次，元数据加载成功后恢复进度、倍速、音量；用户操作或切课会取消过期恢复。连续正常播放 30 秒后重置重试预算。
- `blob:` / MSE 流、媒体流对象和时长未知的媒体不执行 `load()` 重置。微跳无法恢复时记录 `needs-site-reload`，仍可能需要刷新页面。脚本不能重新签发过期播放链接，也不能保证修复平台 HLS 分片请求。
- 不再在窗口每次获得焦点时连续跳转；帧监控跟随各视频实例创建和销毁，避免切课后监控失效。
- Plyr 库加载等待最多 15 秒，失败后等待 30 秒再尝试；库接管成功后才隐藏官方控件。

诊断中的 `readyState`、`networkState`、`errorCode`、`buffered` 和最近 20 条事件可帮助区分缓冲耗尽与渲染停滞，但不能代替浏览器 Network 面板中的请求状态。`reload-url` 只代表已尝试重载，不代表已经恢复播放。

实现参考：[HTMLMediaElement.load() 的重置与中止行为](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/load)。本地验证：`node --test tests/playback-recovery.test.cjs`。

### 3. 视频水印控制器 (`__hsWatermarkRemover`)

两款脚本均内置水印控制器实例 `window.__hsWatermarkRemover`（同时兼容 `window.__tabbit_watermark_remover__`）：

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

---

## ❓ 常见问题 (FAQ)

**Q：两个脚本应该同时安装吗？**  
A：建议二选一安装。如果更喜欢原版播放器界面的用户安装方案 A；如果希望获得全键盘快捷键、现代播放器外观和更干净清爽界面的用户推荐安装方案 B。

**Q：为什么我在前台点击视频画面或暂停键时，视频依然可以暂停？**  
A：这是特意设计的机制。脚本会精确区分“网页后台触发的防作弊暂停”与“用户在前台的主动操作”。你在前台点击暂停完全有效，不会出现无法暂停的问题。

**Q：更换视频集数时需要刷新页面吗？**  
A：不需要。脚本内置了 SPA 路由与 DOM 动态监听，切集换课时会自动即时挂载接管。

**Q：为什么切换标签页或最小化回来后，容易出现声音还在放而画面卡住的情况？**  
A：后台渲染调度、解码器或网络异常都可能有关，不能仅凭症状确定原因。方案 A 保留原有的回前台微跳与帧监控。方案 B 从 1.3.0 起取消无条件跳转，只在前台检测到时间轴前进、但超过 4 秒没有新帧时尝试有限恢复；声音和进度也停止时走上述 12 秒停滞检测。恢复不保证成功，尤其是平台 HLS 请求或鉴权失效时。

---

## 📄 开源许可 (License)

本项目基于 [GNU General Public License v3.0 (GPL-3.0)](./LICENSE) 开放源代码。仅供交流与个人提升学习体验使用，请勿用于违反法律法规或破坏平台正常运营之用途。
