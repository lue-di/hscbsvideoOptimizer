// ==UserScript==
// @name         沪上插班生视频优化
// @namespace    https://wq.bunanguo.com/
// @version      2.3.0
// @description  在沪上插班生 (wq.bunanguo.com) 播放视频时，避免因切换标签页或最小化窗口导致视频自动暂停，优化播放器控件显示（鼠标/触摸移动显示、静止约3秒自动隐藏，支持普通与全屏模式），自动隐藏视频水印覆盖层，并解决切屏切页后音画不同步/画面卡死问题
// @author       zhujunxi
// @license      GPL-3.0-or-later
// @match        *://wq.bunanguo.com/*
// @match        *://*.bunanguo.com/*
// @include      *://wq.bunanguo.com/*
// @include      *://*.bunanguo.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // 将主逻辑封装为一个可以在主页面（Main World）中直接执行的函数
  function mainWorldWorker() {
    if (window.__hsVideoOptInjected) return;
    window.__hsVideoOptInjected = true;
    window.__tabBgPlayInjected = true; // 兼容旧标记

    /* =========================================================================
     * 第一部分：后台防暂停核心逻辑
     * ========================================================================= */

    // ---- 1. 原生 API 捕获 ----
    const nativeDoc = document;
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

    // ---- 2. 重写原型链与 document 实例，强制返回 visible / false ----
    try {
      Object.defineProperty(DocProto, "visibilityState", {
        configurable: true,
        enumerable: true,
        get: () => "visible"
      });
      Object.defineProperty(DocProto, "hidden", {
        configurable: true,
        enumerable: true,
        get: () => false
      });
      Object.defineProperty(nativeDoc, "visibilityState", {
        configurable: true,
        enumerable: true,
        get: () => "visible"
      });
      Object.defineProperty(nativeDoc, "hidden", {
        configurable: true,
        enumerable: true,
        get: () => false
      });
    } catch (e) {
      console.warn("[沪上插班生视频优化] 重写 visibilityState 失败:", e);
    }

    // 重写 hasFocus 避免窗口失焦检测
    try {
      DocProto.hasFocus = () => true;
      nativeDoc.hasFocus = () => true;
    } catch (_) {}

    // ---- 3. 拦截 document.addEventListener，阻止页面监听 visibilitychange ----
    const origDocAddEventListener = nativeDoc.addEventListener;
    nativeDoc.addEventListener = function (type, listener, options) {
      if (type === "visibilitychange") {
        // 包装监听器：如果真实状态处于后台，则坚决不向页面派发事件
        const wrappedListener = function (e) {
          if (!isRealHidden()) {
            return typeof listener === "function" ? listener.call(this, e) : listener.handleEvent(e);
          }
        };
        return origDocAddEventListener.call(this, type, wrappedListener, options);
      }
      return origDocAddEventListener.apply(this, arguments);
    };

    // 在捕获阶段吸收切到后台时的 visibilitychange 事件（切回前台时放行以通知渲染管线刷新）
    const blockVis = (e) => {
      try {
        if (isRealHidden()) {
          e.stopImmediatePropagation();
        }
      } catch (_) {}
    };
    origDocAddEventListener.call(nativeDoc, "visibilitychange", blockVis, true);
    window.addEventListener("visibilitychange", blockVis, true);

    // ---- 4. 关键防御：拦截 HTMLMediaElement.prototype.pause ----
    // 只要是在后台被网页代码调用的 pause()，直接忽略！用户在前台点击暂停仍不受影响。
    const origMediaPause = HTMLMediaElement.prototype.pause;
    HTMLMediaElement.prototype.pause = function (...args) {
      if (isRealHidden()) {
        console.log("%c[沪上插班生视频优化] 成功拦截网页在后台尝试触发的 pause()！", "color: #10b981; font-weight: bold;");
        return Promise.resolve();
      }
      return origMediaPause.apply(this, args);
    };

    // ---- 5. 辅助看门狗：如果视频因其他异常被暂停，自动恢复播放 ----
    let wasPlaying = false;
    function pickVideo() {
      return document.querySelector("video.uni-video-video") || document.querySelector("video");
    }

    // 监听播放/暂停更新用户意图
    origDocAddEventListener.call(nativeDoc, "play", (e) => {
      if (e.target && e.target.tagName === "VIDEO") {
        wasPlaying = true;
      }
    }, true);

    origDocAddEventListener.call(nativeDoc, "pause", (e) => {
      if (e.target && e.target.tagName === "VIDEO") {
        if (!isRealHidden()) {
          wasPlaying = false; // 用户在前台主动点击了暂停
        } else if (wasPlaying) {
          // 在后台被意外暂停，立即唤醒恢复
          setTimeout(() => {
            const v = e.target;
            if (v && v.paused && !v.ended) {
              v.play().catch(() => {});
            }
          }, 50);
        }
      }
    }, true);

    setInterval(() => {
      if (isRealHidden() && wasPlaying) {
        const v = pickVideo();
        if (v && v.paused && !v.ended && v.readyState >= 2) {
          v.play().catch(() => {});
        }
      }
    }, 800);

    // ---- 6. 切回前台音画重同步与画面假死自动自愈看门狗 ----
    // Chromium 在后台会停止视频轨道硬件解码；切回前台通过毫秒级微跳帧强制清空陈旧帧缓存并唤醒解码器
    function wakeUpVideoDecoder(v) {
      if (!v || v.paused || v.ended || v.readyState < 2) return;
      try {
        const cur = v.currentTime;
        if (Number.isFinite(cur)) {
          const delta = (v.duration && cur + 0.001 >= v.duration) ? -0.001 : 0.001;
          v.currentTime = cur + delta;
        }
      } catch (_) {}
    }

    let lastHiddenState = isRealHidden();
    function onForegroundResync() {
      const v = pickVideo();
      if (!v || v.paused || v.ended) return;
      setTimeout(() => wakeUpVideoDecoder(v), 40);
      setTimeout(() => wakeUpVideoDecoder(v), 250);
    }

    window.addEventListener("focus", onForegroundResync, true);
    window.addEventListener("pageshow", onForegroundResync, true);
    origDocAddEventListener.call(nativeDoc, "visibilitychange", () => {
      const nowHidden = isRealHidden();
      if (lastHiddenState && !nowHidden) {
        onForegroundResync();
      }
      lastHiddenState = nowHidden;
    }, true);

    // 结合现代浏览器 requestVideoFrameCallback 监听渲染帧，画面停滞时自动自愈
    if (typeof HTMLVideoElement !== "undefined" && "requestVideoFrameCallback" in HTMLVideoElement.prototype) {
      let lastPaintTime = performance.now();
      let lastMediaTime = 0;
      let rvfcPending = false;

      function trackVideoFrames(v) {
        if (!v || rvfcPending) return;
        rvfcPending = true;
        try {
          v.requestVideoFrameCallback((now, metadata) => {
            rvfcPending = false;
            lastPaintTime = now;
            lastMediaTime = metadata.mediaTime;
            if (!v.paused && !v.ended) {
              trackVideoFrames(v);
            }
          });
        } catch (_) {
          rvfcPending = false;
        }
      }

      setInterval(() => {
        if (isRealHidden()) return;
        const v = pickVideo();
        if (!v || v.paused || v.ended || v.readyState < 2) return;
        trackVideoFrames(v);
        const now = performance.now();
        // 前台播放时，若时间轴持续推进超过 1 秒，但画面超过 1.5 秒未画出新帧，执行微跳帧唤醒
        if (now - lastPaintTime > 1500 && Math.abs(v.currentTime - lastMediaTime) > 0.8) {
          wakeUpVideoDecoder(v);
          lastPaintTime = now;
          lastMediaTime = v.currentTime;
        }
      }, 1000);
    }

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
      const ALL_WRAPS = ALL_SELS.join(", ");
      const BARS = [
        ".extFullControl-Top", ".extFullControl-Bottom",
        "#extFullControl_top_box", "#extFullControl_bottom_box",
        ".goFullControl-Top", ".goFullControl-Bottom",
        "#goFullControl_top_box", "#goFullControl_bottom_box"
      ].join(", ");

      function scope(classToken, sels) {
        return sels.map((s) => "html." + classToken + " " + s).join(",\n");
      }

      function stripOurLeftovers() {
        document.querySelectorAll(ALL_WRAPS).forEach((el) => {
          if (el.style.getPropertyPriority("transform") === "important") el.style.removeProperty("transform");
          if (el.style.getPropertyPriority("opacity") === "important") el.style.removeProperty("opacity");
          if (el.style.getPropertyPriority("pointer-events") === "important") el.style.removeProperty("pointer-events");
        });
        document.querySelectorAll(BARS).forEach((el) => {
          if (el.style.getPropertyPriority("z-index") === "important") el.style.removeProperty("z-index");
          if (el.style.getPropertyPriority("pointer-events") === "important") el.style.removeProperty("pointer-events");
        });
      }

      const prev = globalThis[NS];
      if (prev && typeof prev.destroy === "function") {
        try { prev.destroy(); } catch (e) {}
      }
      stripOurLeftovers();

      const getRoot = () => document.documentElement || document.body;
      const root = getRoot();
      if (root) {
        root.classList.remove(SHOW_CLASS, HIDE_CLASS);
      }

      if (mode === "restore") {
        const st = document.getElementById(STYLE_ID);
        if (st && st.parentNode) st.parentNode.removeChild(st);
        return { ok: true, summary: "已还原播放器控件的默认自动隐藏行为", changed_count: 0, data: {}, warnings: [] };
      }

      let style = document.getElementById(STYLE_ID);
      if (!style) {
        style = document.createElement("style");
        style.id = STYLE_ID;
        const parent = document.head || document.documentElement;
        if (parent) {
          parent.appendChild(style);
        } else {
          origDocAddEventListener.call(nativeDoc, "DOMContentLoaded", () => {
            const p = document.head || document.documentElement;
            if (p) p.appendChild(style);
          }, { once: true });
        }
      }
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
        bind(document, "pointermove", onActivity);
        bind(document, "mousemove", onActivity);
        bind(document, "touchstart", onActivity);
        bind(document, "touchmove", onActivity);
        bind(document, "mousedown", onDown);
        bind(document, "pointerdown", onDown);
        bind(document, "mouseup", onUp);
        bind(document, "pointerup", onUp);
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
        const st = document.getElementById(STYLE_ID);
        if (st && st.parentNode) st.parentNode.removeChild(st);
        stripOurLeftovers();
        if (globalThis[NS] === api) delete globalThis[NS];
        if (globalThis["__hsPlayerControlsFix"] === api) delete globalThis["__hsPlayerControlsFix"];
      }

      function ty(sel) {
        const el = document.querySelector(sel);
        if (!el) return null;
        const t = getComputedStyle(el).transform;
        if (!t || t === "none") return 0;
        const m = t.match(/matrix\(([^)]+)\)/);
        return m ? Math.round(Number(m[1].split(",")[5])) : null;
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
      globalThis["__hsPlayerControlsFix"] = api;

      return {
        ok: true,
        summary: mode === "pin"
          ? "已固定播放器控件常驻可见"
          : "已启用：鼠标/触摸移动显示控件，静止约 " + IDLE_MS + "ms 后自动隐藏（普通+全屏）",
        changed_count: 0,
        data: {
          mode, idle_ms: IDLE_MS,
          css_head: style.textContent.slice(0, 240),
          state: getState(),
          fs_top_ty: ty(TOP_SELS[1]),
          fs_bottom_ty: ty(BOTTOM_SELS[1])
        },
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
      const SCOPE = args && args.scope ? String(args.scope) : "video-watermark";
      const SELECTOR = "." + SCOPE + ", ." + SCOPE + "-text";

      // Reuse / tear down a previous instance so effects never stack.
      if (globalThis[NS] && typeof globalThis[NS].destroy === "function") {
        try { globalThis[NS].destroy(); } catch (e) {}
      }
      if (globalThis["__hsWatermarkRemover"] && typeof globalThis["__hsWatermarkRemover"].destroy === "function") {
        try { globalThis["__hsWatermarkRemover"].destroy(); } catch (e) {}
      }

      const getTargets = () => Array.from(document.querySelectorAll(SELECTOR));

      const css = "." + SCOPE + ", ." + SCOPE + "-text { display: none !important; }";
      let styleEl = document.getElementById(STYLE_ID);
      if (!styleEl) {
        styleEl = document.createElement("style");
        styleEl.id = STYLE_ID;
        styleEl.setAttribute("data-tabbit", NS);
        styleEl.setAttribute("data-hs-opt", "watermark-remover");
        styleEl.textContent = css;
        const parent = document.head || document.documentElement;
        if (parent) {
          parent.appendChild(styleEl);
        } else {
          origDocAddEventListener.call(nativeDoc, "DOMContentLoaded", () => {
            const p = document.head || document.documentElement;
            if (p && !document.getElementById(STYLE_ID)) p.appendChild(styleEl);
          }, { once: true });
        }
      }

      // Independent postcondition check from rendered state.
      function isHidden(el) {
        const cs = getComputedStyle(el);
        return cs.display === "none" || cs.visibility === "hidden";
      }

      const controller = {
        id: NS,
        selector: SELECTOR,
        styleEl: styleEl,
        get count() {
          return getTargets().length;
        },
        hide() {
          if (styleEl) {
            styleEl.disabled = false;
            if (!styleEl.parentNode) {
              (document.head || document.documentElement).appendChild(styleEl);
            }
          }
        },
        show() {
          if (styleEl && styleEl.parentNode) {
            styleEl.parentNode.removeChild(styleEl);
          }
        },
        destroy() {
          if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
          if (globalThis[NS] === controller) delete globalThis[NS];
          if (globalThis["__hsWatermarkRemover"] === controller) delete globalThis["__hsWatermarkRemover"];
        },
        getState() {
          const targets = getTargets();
          const hiddenNow = targets.filter(isHidden).length;
          return {
            id: NS,
            selector: SELECTOR,
            matched_count: targets.length,
            hidden_count: hiddenNow,
            style_present: !!document.getElementById(STYLE_ID),
            style_disabled: !!(styleEl && styleEl.disabled)
          };
        },
        run: (newArgs) => initWatermarkRemover(newArgs)
      };

      globalThis[NS] = controller;
      globalThis["__hsWatermarkRemover"] = controller;

      const targets = getTargets();
      const hiddenNow = targets.filter(isHidden).length;
      const ok = targets.length > 0 && hiddenNow === targets.length;

      return {
        ok: ok,
        summary: ok
          ? ("已隐藏水印覆盖层 " + hiddenNow + "/" + targets.length + " 个元素（刷新页面即可恢复）")
          : "已注入水印隐藏规则（若当前无水印，出现时将自动隐藏）",
        matched_count: targets.length,
        hidden_count: hiddenNow,
        data: {
          selector: SELECTOR,
          scope_root: ".uni-video-slots",
          sample_text: targets.map(function (t) { return (t.textContent || "").trim().slice(0, 24); })
        },
        warnings: targets.length === 0 ? ["当前页面未匹配到水印元素，已预置隐藏样式"] : []
      };
    }

    // 默认启用视频水印净化与隐藏
    initWatermarkRemover({ scope: "video-watermark" });

    /* =========================================================================
     * 第四部分：页面提示与初始化通知
     * ========================================================================= */
    function showNotification() {
      const tip = document.createElement("div");
      tip.id = "__hs_video_opt_notification";
      tip.innerHTML = "✨ 沪上插班生视频优化已就绪";
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
      origDocAddEventListener.call(nativeDoc, "DOMContentLoaded", showNotification, { once: true });
    }

    console.log("%c[沪上插班生视频优化] 核心注入成功（后台防暂停 + 控件显示优化 + 视频水印隐藏已就绪）！", "color: #10b981; font-weight: bold; font-size: 14px;");
  }

  // ---- 注入器：突破扩展沙盒限制，强制注入到页面的真实主环境中 ----
  try {
    mainWorldWorker();
  } catch (e) {}

  function injectIntoMainWorld() {
    try {
      const script = document.createElement("script");
      script.textContent = "(" + mainWorldWorker.toString() + ")();";
      (document.head || document.documentElement).appendChild(script);
      script.remove();
    } catch (e) {
      console.warn("[沪上插班生视频优化] 标签注入失败:", e);
    }
  }

  if (document.documentElement) {
    injectIntoMainWorld();
  } else {
    const observer = new MutationObserver(() => {
      if (document.documentElement) {
        observer.disconnect();
        injectIntoMainWorld();
      }
    });
    observer.observe(document, { childList: true, subtree: true });
  }
})();
