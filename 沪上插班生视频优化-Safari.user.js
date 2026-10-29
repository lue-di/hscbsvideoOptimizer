// ==UserScript==
// @name         沪上插班生视频优化 (Safari)
// @namespace    https://wq.bunanguo.com/
// @version      1.0.0
// @description  「沪上插班生视频优化」的 Safari 移植版：切换标签页或最小化窗口时视频不自动暂停，播放器控件移动显示、静止约3秒自动隐藏（普通与全屏模式），自动隐藏视频水印，切回页面后画面停滞时自动微跳恢复；适配 Userscripts / Tampermonkey / Stay
// @author       zhujunxi
// @license      GPL-3.0-or-later
// @match        *://wq.bunanguo.com/*
// @match        *://*.bunanguo.com/*
// @run-at       document-start
// @inject-into  auto
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // 主逻辑需要在页面主环境（Main World）执行，才能改写页面看到的原型与属性
  function mainWorldWorker() {
    const MARK_ATTR = "data-hs-video-opt";
    const markRoot = () => {
      try {
        if (document.documentElement) document.documentElement.setAttribute(MARK_ATTR, "1");
      } catch (_) {}
    };
    // 已运行（含同时安装了原版脚本）时只打标记，避免重复挂载
    if (window.__hsVideoOptInjected) { markRoot(); return; }
    window.__hsVideoOptInjected = true;
    window.__tabBgPlayInjected = true; // 兼容旧标记
    markRoot();

    const LOG = "[沪上插班生视频优化]";
    const nativeDoc = document;

    function appendStyle(el) {
      const parent = document.head || document.documentElement;
      if (parent) { parent.appendChild(el); return; }
      nativeDoc.addEventListener("DOMContentLoaded", () => {
        if (!el.isConnected) (document.head || document.documentElement).appendChild(el);
      }, { once: true });
    }

    /* =========================================================================
     * 第一部分：后台防暂停核心逻辑
     * ========================================================================= */

    // ---- 1. 原生 API 捕获 ----
    const DocProto = Document.prototype;
    const nativeVisibilityStateDesc = Object.getOwnPropertyDescriptor(DocProto, "visibilityState");
    const nativeHiddenDesc = Object.getOwnPropertyDescriptor(DocProto, "hidden");

    function isRealHidden() {
      try {
        if (nativeHiddenDesc && nativeHiddenDesc.get) {
          return nativeHiddenDesc.get.call(nativeDoc) === true;
        }
        if (nativeVisibilityStateDesc && nativeVisibilityStateDesc.get) {
          return nativeVisibilityStateDesc.get.call(nativeDoc) === "hidden";
        }
        return nativeDoc.hidden;
      } catch (e) {
        return false;
      }
    }

    // ---- 2. 伪装可见状态（旧版 Safari 的 webkit 前缀属性存在时一并处理）----
    const FAKE_PROPS = { visibilityState: "visible", hidden: false, webkitVisibilityState: "visible", webkitHidden: false };
    Object.keys(FAKE_PROPS).forEach((name) => {
      if (!(name in DocProto)) return;
      const value = FAKE_PROPS[name];
      [DocProto, nativeDoc].forEach((target) => {
        try {
          Object.defineProperty(target, name, { configurable: true, enumerable: true, get: () => value });
        } catch (e) {
          console.warn(LOG + " 重写 " + name + " 失败:", e);
        }
      });
    });

    // 重写 hasFocus 避免窗口失焦检测
    try {
      DocProto.hasFocus = () => true;
      nativeDoc.hasFocus = () => true;
    } catch (_) {}

    // ---- 3. 在捕获阶段吸收切到后台时的 visibilitychange ----
    // 不包装 document.addEventListener：捕获阶段已能拦住页面监听，包装反而会让页面的 removeEventListener 失效。
    // 切回前台时放行，通知渲染管线刷新。
    const visibilitySubscribers = new Set();
    let lastHidden = isRealHidden();
    function notifyVisibility(hidden) {
      lastHidden = hidden;
      visibilitySubscribers.forEach((fn) => { try { fn(hidden); } catch (_) {} });
    }
    function onVisibilityEvent(e) {
      const hidden = isRealHidden();
      // 先通知脚本自身：页面看到的 document.hidden 已被伪装，后台事件也会被拦截
      if (hidden !== lastHidden) notifyVisibility(hidden);
      if (hidden) e.stopImmediatePropagation();
    }
    ["visibilitychange", "webkitvisibilitychange"].forEach((type) => {
      window.addEventListener(type, onVisibilityEvent, true);
      nativeDoc.addEventListener(type, onVisibilityEvent, true);
    });
    // Safari 往返缓存（bfcache）恢复页面时不一定派发 visibilitychange
    window.addEventListener("pageshow", (e) => {
      if (e.persisted && !isRealHidden()) notifyVisibility(false);
    }, true);

    // ---- 4. 关键防御：拦截后台对当前播放视频的 pause() ----
    // 只拦截「真实后台 + 正在播放的主视频」；前台操作、其他媒体、换课等仍走原生 pause。
    const playingVideos = new WeakSet();
    function pickVideo() {
      return document.querySelector("#VideoView video") || document.querySelector("video.uni-video-video") || document.querySelector("video");
    }
    function shouldKeepPlaying(v) {
      return !!v && v === pickVideo() && v.isConnected && playingVideos.has(v) && !v.ended && !v.error;
    }

    const origMediaPause = HTMLMediaElement.prototype.pause;
    HTMLMediaElement.prototype.pause = function () {
      if (isRealHidden() && shouldKeepPlaying(this)) {
        console.log("%c" + LOG + " 成功拦截网页在后台尝试触发的 pause()！", "color: #10b981; font-weight: bold;");
        return;
      }
      return origMediaPause.apply(this, arguments);
    };

    // 后台时用户通过媒体键 / 控制中心 / 耳机暂停属于主动操作，不应被看门狗恢复
    try {
      if (navigator.mediaSession && navigator.mediaSession.setActionHandler) {
        navigator.mediaSession.setActionHandler("pause", () => {
          const v = pickVideo();
          if (!v) return;
          playingVideos.delete(v);
          origMediaPause.call(v);
        });
        navigator.mediaSession.setActionHandler("play", () => {
          const v = pickVideo();
          if (v) v.play().catch(() => {});
        });
      }
    } catch (_) {}

    // ---- 5. 辅助看门狗：后台被意外暂停时自动恢复播放 ----
    function resumeIfNeeded(v) {
      if (isRealHidden() && shouldKeepPlaying(v) && v.paused) {
        v.play().catch(() => {});
      }
    }

    nativeDoc.addEventListener("play", (e) => {
      if (e.target && e.target.tagName === "VIDEO") playingVideos.add(e.target);
    }, true);

    nativeDoc.addEventListener("pause", (e) => {
      const v = e.target;
      if (!v || v.tagName !== "VIDEO") return;
      if (!isRealHidden()) {
        playingVideos.delete(v); // 用户在前台主动暂停
      } else if (playingVideos.has(v)) {
        setTimeout(() => resumeIfNeeded(v), 50);
      }
    }, true);

    setInterval(() => {
      if (!isRealHidden()) return;
      const v = pickVideo();
      if (v && v.readyState >= 2) resumeIfNeeded(v);
    }, 800);

    // ---- 6. 切回前台后的画面停滞自愈 ----
    // 只在「时间轴在走、却长时间没有新画面」时，在已缓冲范围内小幅微跳唤醒解码器；
    // 不再在每次窗口获得焦点时盲目跳帧，避免无谓的音频跳动。
    const supportsRVFC = typeof HTMLVideoElement !== "undefined" && "requestVideoFrameCallback" in HTMLVideoElement.prototype;
    const FAST_WINDOW_MS = 10000;   // 切回后 10 秒内加快检测
    const RESYNC_BUDGET = 2;        // 未观察到新帧前最多微跳次数

    function inBuffered(v, t) {
      try {
        const b = v.buffered;
        for (let i = 0; i < b.length; i++) {
          if (t >= b.start(i) && t <= b.end(i)) return true;
        }
      } catch (_) {}
      return false;
    }

    function microSeek(v, delta) {
      if (!v || v.paused || v.ended || v.seeking || v.readyState < 2) return false;
      const target = v.currentTime + delta;
      if (!Number.isFinite(target) || !inBuffered(v, target)) return false;
      try {
        v.currentTime = target;
        return true;
      } catch (_) {
        return false;
      }
    }

    // 画中画、AirPlay、纯音频时页面内不会出新帧，不能据此判断停滞
    function framesObservable(v) {
      if (!v.videoWidth) return false;
      if (document.pictureInPictureElement === v) return false;
      if (v.webkitPresentationMode === "picture-in-picture") return false;
      if (v.webkitCurrentPlaybackTargetIsWireless) return false;
      return true;
    }

    let frameVideo = null;
    let frameHandle = 0;
    let lastFrameAt = 0;
    let lastFrameMedia = 0;
    let fastUntil = 0;
    let lastResyncAt = -Infinity;
    let resyncBudget = RESYNC_BUDGET;

    function resetFrameBaseline() {
      lastFrameAt = performance.now();
      lastFrameMedia = frameVideo ? frameVideo.currentTime : 0;
    }

    function requestFrame(v) {
      try {
        frameHandle = v.requestVideoFrameCallback((now, meta) => {
          if (v !== frameVideo) return;
          frameHandle = 0;
          lastFrameAt = now;
          lastFrameMedia = meta && Number.isFinite(meta.mediaTime) ? meta.mediaTime : v.currentTime;
          resyncBudget = RESYNC_BUDGET;
          if (!v.paused && !v.ended) requestFrame(v);
        });
      } catch (_) {
        frameHandle = 0;
      }
    }

    // 帧回调跟随当前视频实例，切课换元素后不会残留在旧元素上
    function watchFrames(v) {
      if (v === frameVideo && frameHandle) return;
      if (v !== frameVideo) {
        if (frameVideo && frameHandle && frameVideo.cancelVideoFrameCallback) {
          try { frameVideo.cancelVideoFrameCallback(frameHandle); } catch (_) {}
        }
        frameVideo = v;
        resyncBudget = RESYNC_BUDGET;
      }
      frameHandle = 0;
      resetFrameBaseline();
      requestFrame(v);
    }

    function checkFrames() {
      const v = pickVideo();
      if (isRealHidden() || !v || v.paused || v.ended || v.seeking || v.readyState < 2 || !framesObservable(v)) {
        if (frameVideo) resetFrameBaseline();
        return;
      }
      watchFrames(v);
      const now = performance.now();
      const limit = now < fastUntil ? 1000 : 2000;
      if (now - lastFrameAt < limit || v.currentTime - lastFrameMedia < 0.4) return;
      if (resyncBudget <= 0 || now - lastResyncAt < 3000) return;
      if (microSeek(v, resyncBudget === RESYNC_BUDGET ? 0.04 : 0.12)) {
        resyncBudget--;
        lastResyncAt = now;
        console.log(LOG + " 检测到画面停滞，已微跳唤醒解码器");
      }
      resetFrameBaseline();
    }

    if (supportsRVFC) {
      ["seeking", "seeked", "play"].forEach((type) => {
        nativeDoc.addEventListener(type, (e) => {
          if (e.target === frameVideo) resetFrameBaseline();
        }, true);
      });
      setInterval(checkFrames, 500);
    }

    visibilitySubscribers.add((hidden) => {
      if (hidden) return;
      const v = pickVideo();
      if (!v || v.paused || v.ended) return;
      if (supportsRVFC) {
        fastUntil = performance.now() + FAST_WINDOW_MS;
        watchFrames(v);
        resyncBudget = RESYNC_BUDGET;
        resetFrameBaseline();
      } else {
        // 旧版 Safari（< 15.4）没有帧回调，只能在切回后固定微跳一次
        setTimeout(() => microSeek(v, 0.04), 250);
      }
    });

    /* =========================================================================
     * 第二部分：播放器控件显示优化（移动显示 / 静止约3秒自动隐藏）
     * ========================================================================= */
    function initPlayerControlsFix(args) {
      args = args || {};
      const mode = ["move", "pin", "restore"].includes(args.mode) ? args.mode : "move";
      const IDLE_MS = Number.isFinite(args.idle_ms) ? args.idle_ms : 3000;

      const NS = "__tabbit_fatPlayerControlsFix";
      const STYLE_ID = "tabbit-fat-player-controls-fix-style";
      const SHOW_CLASS = "tabbit-player-ctrl-show";
      const HIDE_CLASS = "tabbit-player-ctrl-hide";

      // 普通模式 (#extFullControl_*) 与 网页/全屏模式 (#goFullControl_*)
      // 均通过行内 transform: translateY(±100%) 控制顶栏/底栏显隐
      const TOP_SELS = [
        "#extFullControl_top_box > uni-view",
        "#goFullControl_top_box > uni-view"
      ];
      const BOTTOM_SELS = [
        "#extFullControl_bottom_box > uni-view",
        "#goFullControl_bottom_box > uni-view"
      ];
      const ALL_SELS = TOP_SELS.concat(BOTTOM_SELS);
      const BARS = [
        ".extFullControl-Top", ".extFullControl-Bottom",
        "#extFullControl_top_box", "#extFullControl_bottom_box",
        ".goFullControl-Top", ".goFullControl-Bottom",
        "#goFullControl_top_box", "#goFullControl_bottom_box"
      ].join(", ");

      function scope(classToken, sels) {
        return sels.map((s) => "html." + classToken + " " + s).join(",\n");
      }

      const prev = globalThis[NS];
      if (prev && typeof prev.destroy === "function") {
        try { prev.destroy(); } catch (e) {}
      }

      const getRoot = () => document.documentElement || document.body;

      if (mode === "restore") {
        return { ok: true, summary: "已还原播放器控件的默认自动隐藏行为", changed_count: 0, data: {}, warnings: [] };
      }

      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent =
        scope(SHOW_CLASS, ALL_SELS) + " {\n" +
        "  transform: translateY(0) !important;\n" +
        "  opacity: 1 !important;\n" +
        "  visibility: visible !important;\n" +
        "  pointer-events: auto !important;\n" +
        "}\n" +
        scope(HIDE_CLASS, TOP_SELS) + " {\n" +
        "  transform: translateY(-100%) !important;\n" +
        "  opacity: 0 !important;\n" +
        "  pointer-events: none !important;\n" +
        "}\n" +
        scope(HIDE_CLASS, BOTTOM_SELS) + " {\n" +
        "  transform: translateY(100%) !important;\n" +
        "  opacity: 0 !important;\n" +
        "  pointer-events: none !important;\n" +
        "}\n" +
        BARS + " {\n  z-index: 1001 !important;\n}\n";
      appendStyle(style);

      let idleTimer = null;
      let activityCount = 0;
      let showCount = 0;
      let hideCount = 0;
      let dragging = false;
      const listeners = [];

      function showNow() {
        const r = getRoot();
        if (!r) return;
        r.classList.add(SHOW_CLASS);
        r.classList.remove(HIDE_CLASS);
      }
      function hideNow() {
        if (dragging) { scheduleHide(); return; }
        const r = getRoot();
        if (!r) return;
        r.classList.remove(SHOW_CLASS);
        r.classList.add(HIDE_CLASS);
        hideCount++;
      }
      function scheduleHide() {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(hideNow, IDLE_MS);
      }
      function onActivity() {
        activityCount++;
        showNow();
        showCount++;
        scheduleHide();
      }
      function onDown() { dragging = true; onActivity(); }
      function onUp() { dragging = false; scheduleHide(); }

      function bind(target, type, fn) {
        target.addEventListener(type, fn, { passive: true, capture: true });
        listeners.push([target, type, fn]);
      }

      if (mode === "move") {
        // Safari 13+ 支持 Pointer Events，可同时覆盖鼠标、触控板与触摸；更老的版本退回鼠标/触摸事件
        if (typeof PointerEvent !== "undefined") {
          bind(document, "pointermove", onActivity);
          bind(document, "pointerdown", onDown);
          bind(document, "pointerup", onUp);
          bind(document, "pointercancel", onUp);
        } else {
          bind(document, "mousemove", onActivity);
          bind(document, "mousedown", onDown);
          bind(document, "mouseup", onUp);
          bind(document, "touchstart", onDown);
          bind(document, "touchmove", onActivity);
          bind(document, "touchend", onUp);
          bind(document, "touchcancel", onUp);
        }
        // 拖动中把指针移出窗口松开时收不到 up 事件，失焦时解除拖动锁定
        bind(window, "blur", onUp);
        onActivity();
      } else {
        showNow();
      }

      function getState() {
        const r = getRoot();
        return {
          mode, idle_ms: IDLE_MS,
          activity_count: activityCount, show_count: showCount, hide_count: hideCount, dragging,
          show_active: !!(r && r.classList.contains(SHOW_CLASS)),
          hide_active: !!(r && r.classList.contains(HIDE_CLASS)),
          style_present: !!document.getElementById(STYLE_ID)
        };
      }

      function destroy() {
        listeners.forEach(([t, type, fn]) => { try { t.removeEventListener(type, fn, { capture: true }); } catch (e) {} });
        listeners.length = 0;
        if (idleTimer) clearTimeout(idleTimer);
        const r = getRoot();
        if (r) r.classList.remove(SHOW_CLASS, HIDE_CLASS);
        if (style.parentNode) style.parentNode.removeChild(style);
        if (globalThis[NS] === api) delete globalThis[NS];
        if (globalThis.__hsPlayerControlsFix === api) delete globalThis.__hsPlayerControlsFix;
      }

      const api = {
        destroy,
        onActivity,
        showNow,
        hideNow,
        getState,
        run: (newArgs) => initPlayerControlsFix(newArgs)
      };

      globalThis[NS] = api;
      globalThis.__hsPlayerControlsFix = api;

      return {
        ok: true,
        summary: mode === "pin"
          ? "已固定播放器控件常驻可见"
          : "已启用：鼠标/触摸移动显示控件，静止约 " + IDLE_MS + "ms 后自动隐藏（普通+全屏）",
        changed_count: 0,
        data: { mode, idle_ms: IDLE_MS, state: getState() },
        warnings: []
      };
    }

    // 默认以 move 模式启动播放器控件优化（静止约 3000ms 自动隐藏）
    initPlayerControlsFix({ mode: "move", idle_ms: 3000 });

    /* =========================================================================
     * 第三部分：视频水印净化与隐藏
     * ========================================================================= */
    function initWatermarkRemover(args) {
      args = args || {};
      const NS = "__tabbit_watermark_remover__";
      const STYLE_ID = NS + "_style";
      const SCOPE = args.scope ? String(args.scope) : "video-watermark";
      const SELECTOR = "." + SCOPE + ", ." + SCOPE + "-text";

      // 先销毁旧实例，避免效果叠加
      [globalThis[NS], globalThis.__hsWatermarkRemover].forEach((prev) => {
        if (prev && typeof prev.destroy === "function") {
          try { prev.destroy(); } catch (e) {}
        }
      });

      const getTargets = () => Array.from(document.querySelectorAll(SELECTOR));
      const isHidden = (el) => {
        const cs = getComputedStyle(el);
        return cs.display === "none" || cs.visibility === "hidden";
      };

      const styleEl = document.createElement("style");
      styleEl.id = STYLE_ID;
      styleEl.setAttribute("data-hs-opt", "watermark-remover");
      styleEl.textContent = SELECTOR + " { display: none !important; }";
      appendStyle(styleEl);

      const controller = {
        id: NS,
        selector: SELECTOR,
        styleEl: styleEl,
        get count() {
          return getTargets().length;
        },
        hide() {
          styleEl.disabled = false;
          if (!styleEl.parentNode) appendStyle(styleEl);
        },
        show() {
          if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
        },
        destroy() {
          if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
          if (globalThis[NS] === controller) delete globalThis[NS];
          if (globalThis.__hsWatermarkRemover === controller) delete globalThis.__hsWatermarkRemover;
        },
        getState() {
          const targets = getTargets();
          return {
            id: NS,
            selector: SELECTOR,
            matched_count: targets.length,
            hidden_count: targets.filter(isHidden).length,
            style_present: !!document.getElementById(STYLE_ID),
            style_disabled: !!styleEl.disabled
          };
        },
        run: (newArgs) => initWatermarkRemover(newArgs)
      };

      globalThis[NS] = controller;
      globalThis.__hsWatermarkRemover = controller;
      return controller.getState();
    }

    // 默认启用视频水印净化与隐藏
    initWatermarkRemover({ scope: "video-watermark" });

    /* =========================================================================
     * 第四部分：页面提示与初始化通知
     * ========================================================================= */
    function showNotification() {
      const tip = document.createElement("div");
      tip.id = "__hs_video_opt_notification";
      tip.textContent = "✨ 沪上插班生视频优化 (Safari) 已就绪";
      tip.style.cssText = `
        position: fixed;
        top: 12px;
        right: 12px;
        z-index: 999999;
        background: rgba(16, 185, 129, 0.95);
        color: #ffffff;
        padding: 8px 14px;
        font-size: 13px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        border-radius: 6px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        pointer-events: none;
        transition: opacity 0.8s ease, transform 0.8s ease;
      `;
      (document.body || document.documentElement).appendChild(tip);
      setTimeout(() => {
        tip.style.opacity = "0";
        tip.style.transform = "translateY(-10px)";
        setTimeout(() => tip.remove(), 800);
      }, 3500);
    }

    if (document.body) {
      showNotification();
    } else {
      nativeDoc.addEventListener("DOMContentLoaded", showNotification, { once: true });
    }

    console.log("%c" + LOG + " Safari 版注入成功（后台防暂停 + 控件显示优化 + 视频水印隐藏已就绪）！", "color: #10b981; font-weight: bold; font-size: 14px;");
  }

  // ---- 注入器 ----
  // Safari 的脚本管理器可能把脚本放在扩展隔离环境（content）或页面环境（page）中执行。
  // 优先用 <script> 注入页面主环境；若页面 CSP 拦截了内联脚本（标记未出现），再退回当前环境直接运行。
  // 这样两种环境下都只会运行一份，不会出现重复监听和重复提示。
  const MARK_ATTR = "data-hs-video-opt";

  function injectIntoPage() {
    try {
      const script = document.createElement("script");
      script.textContent = "(" + mainWorldWorker.toString() + ")();";
      (document.head || document.documentElement).appendChild(script);
      script.remove();
    } catch (e) {
      console.warn("[沪上插班生视频优化] 标签注入失败:", e);
    }
  }

  function boot() {
    const root = document.documentElement;
    if (!root.hasAttribute(MARK_ATTR)) injectIntoPage();
    if (!root.hasAttribute(MARK_ATTR)) {
      try {
        mainWorldWorker();
      } catch (e) {
        console.warn("[沪上插班生视频优化] 直接运行失败:", e);
      }
    }
    root.removeAttribute(MARK_ATTR);
  }

  if (document.documentElement) {
    boot();
  } else {
    const observer = new MutationObserver(() => {
      if (document.documentElement) {
        observer.disconnect();
        boot();
      }
    });
    observer.observe(document, { childList: true, subtree: true });
  }
})();
