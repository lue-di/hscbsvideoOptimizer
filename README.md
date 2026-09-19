# 沪上插班生视频优化 (HuShang Video Optimizer)

[![UserScript](https://img.shields.io/badge/Userscript-Tampermonkey%20%7C%20ScriptCat-blue)](https://www.tampermonkey.net/)
[![Platform](https://img.shields.io/badge/Platform-wq.bunanguo.com-green)](https://wq.bunanguo.com/)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](./LICENSE)

专为**沪上插班生**（`wq.bunanguo.com` / `bunanguo.com`）学习网课平台打造的油猴用户脚本。

解决网页播放器的两大核心痛点：
1. **后台切屏防暂停**：切换标签页、最小化窗口或锁屏失焦时，避免视频被网页强制暂停；
2. **播放器控件体验优化**：解决官方播放器控制栏容易消失或阻碍画面的问题，实现「鼠标/触控移动即呼出，静止约 3 秒平滑隐藏，拖拽进度条不隐藏」，普通模式与全屏模式双向支持。

---

## 🌟 核心功能

### 1. 智能后台播放防暂停
- **原生 API 伪装**：自动重写 `document.visibilityState`、`document.hidden` 以及 `document.hasFocus()`，向页面代码伪装为窗口始终处于活跃状态。
- **失焦事件拦截**：在捕获阶段拦截并阻断 `visibilitychange` 事件派发。
- **精准防御 `pause()` 调用**：拦截页面在后台静默触发的 `HTMLMediaElement.prototype.pause()`，网页尝试暂停的指令直接被忽略。
- **用户操作智能识别**：在前台主动点击暂停/播放完全不受干扰，贴合日常学习操作习惯。
- **看门狗自愈守护**：后台若因网络波动或异常导致视频中断，自动唤醒视频恢复播放。

### 2. 播放器控件显示优化
- **交互动态感知**：监听鼠标移动、触控及指针操作，检测到用户活动立即平滑显示控制栏；静止约 3 秒无操作后自动收起。
- **拖拽防误触锁定**：拖动进度条滑块或调节音量时自动锁定控件常驻，松手后才恢复静止倒计时隐藏。
- **普通与全屏双模式覆盖**：针对 uni-app 视频播放器的行内 `transform: translateY(±100%)` 样式进行全局 `!important` 覆盖，同时完美适配：
  - 普通内嵌播放模式（`#extFullControl_*`）
  - 网页全屏 / 真实全屏模式（`#goFullControl_*`）
- **层级加固**：重设控制栏 `z-index: 1001`，避免控制条被页面其他浮层遮挡。

### 3. 轻量纯粹 & 穿透注入
- **零外部依赖**：纯原生 JavaScript 实现，体积小巧，毫秒级注入。
- **主环境（Main World）穿透**：通过动态 `<script>` 标签突破扩展沙盒与页面环境的隔离，保证 API 重写与事件拦截 100% 生效。
- **无感通知徽标**：脚本成功挂载后在右上角显示优雅的临时提示，3.5 秒后自动淡出消失。

---

## 📥 安装使用

### 前提准备
1. 确保已安装现代浏览器（如 Chrome、Edge、Firefox、Safari、Brave 等）。
2. 安装一款用户脚本管理器扩展：
   - [Tampermonkey（篡改猴）](https://www.tampermonkey.net/)（推荐）
   - [ScriptCat（脚本猫）](https://docs.scriptcat.org/)
   - [Violentmonkey（暴力猴）](https://violentmonkey.github.io/)

### 安装步骤

#### 方式一：在线一键安装（推荐）
点击进入本仓库的脚本文件：
👉 **[`沪上插班生视频优化.user.js`](./沪上插班生视频优化.user.js)**

点击页面右上角的 **`Raw`** 按钮，脚本管理器将自动识别并弹出安装界面，点击「安装」或「更新」即可。

#### 方式二：手动导入
1. 打开 [`沪上插班生视频优化.user.js`](./沪上插班生视频优化.user.js) 并复制全部代码。
2. 打开脚本管理器控制面板，选择「添加新脚本」。
3. 清空默认内容并将复制的代码粘贴进去，按 `Ctrl + S`（Mac 上为 `Cmd + S`）保存即可。

---

## 🛠️ 控制台调试与高级调优 API

脚本在全局挂载了控制器实例 `window.__hsPlayerControlsFix`（同时兼容 `window.__tabbit_fatPlayerControlsFix`），可在浏览器开发者工具（F12 控制台）随时动态调优：

```javascript
// 1. 立即呼出播放器控件
__hsPlayerControlsFix.showNow();

// 2. 立即隐藏播放器控件
__hsPlayerControlsFix.hideNow();

// 3. 固定控制栏常驻显示（不自动隐藏）
__hsPlayerControlsFix.run({ mode: "pin" });

// 4. 恢复默认行为（移动显示，静止 3 秒自动隐藏）
__hsPlayerControlsFix.run({ mode: "move", idle_ms: 3000 });

// 5. 自定义静止隐藏时间为 5 秒
__hsPlayerControlsFix.run({ mode: "move", idle_ms: 5000 });

// 6. 获取当前控件与监听状态
console.log(__hsPlayerControlsFix.getState());

// 7. 销毁并还原页面初始默认行为
__hsPlayerControlsFix.destroy();
```

---

## ❓ 常见问题 (FAQ)

**Q：为什么我在前台点击视频画面或暂停键时，视频依然可以暂停？**  
A：这是特意设计的机制。脚本会精确区分“网页后台触发的防作弊暂停”与“用户在前台的主动操作”。你在前台点击暂停完全有效，不会出现无法暂停的问题。

**Q：全屏模式下控件能正常唤出和隐藏吗？**  
A：完全可以。脚本针对普通模式与全屏模式各自的顶栏、底栏容器均配置了专属选择器与样式覆盖，全屏下移动鼠标即可自如控制。

**Q：使用时有其他快捷键或冲突吗？**  
A：脚本不劫持任何自定义按键，与油猴其他通用播放器增强插件良好兼容。

---

## 📄 开源许可 (License)

本项目基于 [GNU General Public License v3.0 (GPL-3.0)](./LICENSE) 开放源代码。仅供交流与个人提升学习体验使用，请勿用于违反法律法规或破坏平台正常运营之用途。
