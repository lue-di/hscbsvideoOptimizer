// ==UserScript==
// @name         沪上插班生视频播放器替换
// @namespace    https://wq.bunanguo.com/
// @version      1.3.0
// @description  在沪上插班生 (wq.bunanguo.com) 播放视频时，使用开源播放器 Plyr 接管原生播放器，保留原视频源与 HLS 解码管线，自动隐藏视频水印与原生冗余控件，支持网页全屏、丰富快捷键、后台防暂停与切屏音画防假死同步
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
    if (!document.documentElement) {
      const ready = new MutationObserver(() => {
        if (document.documentElement) { ready.disconnect(); mainWorldWorker(); }
      });
      ready.observe(document, { childList: true });
      return;
    }
    if (window.__hsPlayerReplacerInjected) return;
    window.__hsPlayerReplacerInjected = true;

    /* =========================================================================
     * 第一部分：后台防暂停核心逻辑
     * ========================================================================= */
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
      console.warn("[沪上插班生播放器替换] 重写 visibilityState 失败:", e);
    }

    try {
      DocProto.hasFocus = () => true;
      nativeDoc.hasFocus = () => true;
    } catch (_) {}

    const origDocAddEventListener = nativeDoc.addEventListener;
    // 捕获阶段已经阻止后台事件；不包装监听器，以保持 removeEventListener 正常工作。

    const blockVis = (e) => {
      try {
        if (isRealHidden()) {
          e.stopImmediatePropagation();
        }
      } catch (_) {}
    };
    origDocAddEventListener.call(nativeDoc, "visibilitychange", blockVis, true);
    window.addEventListener("visibilitychange", blockVis, true);

    const origMediaPause = HTMLMediaElement.prototype.pause;
    HTMLMediaElement.prototype.pause = function (...args) {
      if (isRealHidden() && this === pickVideo() && this.isConnected &&
          playingVideos.has(this) && !this.ended && !this.error) {
        return;
      }
      return origMediaPause.apply(this, args);
    };

    const playingVideos = new WeakSet();
    function pickVideo() {
      return document.querySelector("#VideoView video") || document.querySelector("video.uni-video-video") || document.querySelector("video");
    }

    origDocAddEventListener.call(nativeDoc, "play", (e) => {
      if (e.target && e.target.tagName === "VIDEO") {
        playingVideos.add(e.target);
      }
    }, true);

    origDocAddEventListener.call(nativeDoc, "pause", (e) => {
      if (e.target && e.target.tagName === "VIDEO") {
        if (!isRealHidden()) {
          playingVideos.delete(e.target);
        } else if (playingVideos.has(e.target)) {
          setTimeout(() => {
            const v = e.target;
            if (v === pickVideo() && v.isConnected && playingVideos.has(v) && v.paused && !v.ended && !v.error) {
              v.play().catch(() => {});
            }
          }, 50);
        }
      }
    }, true);

    setInterval(() => {
      if (isRealHidden()) {
        const v = pickVideo();
        if (v && playingVideos.has(v) && v.paused && !v.ended && !v.error && v.readyState >= 2) {
          v.play().catch(() => {});
        }
      }
    }, 800);

    // ---- 6. 每个播放器独立的卡顿监控：先修复缓冲间隙，再有限重载直连媒体 ----
    function createPlaybackRecovery(video) {
      let disposed = false;
      let frameId = null;
      let source = video.currentSrc;
      let lastTime = video.currentTime;
      let lastProgress = performance.now();
      let lastFrame = lastProgress;
      let frameTime = lastTime;
      let lastTick = lastProgress;
      let lastAttempt = -Infinity;
      let attempts = 0;
      let healthySince = null;
      let pendingReload = null;
      const history = [];
      const listeners = [];
      const ranges = () => Array.from({ length: video.buffered.length }, (_, i) =>
        [video.buffered.start(i), video.buffered.end(i)]);
      const state = () => ({
        currentTime: video.currentTime, paused: video.paused, seeking: video.seeking,
        readyState: video.readyState, networkState: video.networkState,
        errorCode: video.error ? video.error.code : null,
        sourceType: video.srcObject ? 'stream' : video.currentSrc.startsWith('blob:') ? 'blob/MSE' : 'url',
        buffered: ranges(), attempts, reloading: !!pendingReload,
        history: history.map(item => ({ ...item }))
      });
      function record(action) {
        history.push({ action, time: new Date().toISOString(), position: video.currentTime,
          readyState: video.readyState, networkState: video.networkState,
          errorCode: video.error ? video.error.code : null });
        if (history.length > 20) history.shift();
      }
      function listen(type, handler) {
        video.addEventListener(type, handler);
        listeners.push([type, handler]);
      }
      function baseline() {
        lastTime = video.currentTime;
        frameTime = lastTime;
        lastProgress = lastFrame = performance.now();
      }
      function cancelReload() {
        if (!pendingReload) return;
        clearTimeout(pendingReload.timer);
        video.removeEventListener('loadedmetadata', pendingReload.restore);
        pendingReload = null;
      }
      // 重载等待期间用户操作优先，避免稍后强制恢复用户刚暂停/拖动的视频。
      const onUserInput = () => { if (pendingReload) { cancelReload(); record('reload-cancelled-by-user'); } };
      const container = video.closest('#VideoView') || video;
      container.addEventListener('pointerdown', onUserInput, true);
      document.addEventListener('keydown', onUserInput, true);
      function trackFrame() {
        if (disposed || frameId !== null || !video.requestVideoFrameCallback) return;
        frameId = video.requestVideoFrameCallback((now, metadata) => {
          frameId = null;
          if (disposed) return;
          lastFrame = now;
          frameTime = metadata.mediaTime;
          if (!video.paused && !video.ended) trackFrame();
        });
      }
      function recover(reason) {
        const now = performance.now();
        if (disposed || !video.isConnected || video !== pickVideo() || video.paused ||
            video.ended || video.seeking || isRealHidden() || navigator.onLine === false ||
            pendingReload || attempts >= 3 || now - lastAttempt < 15000) return false;
        attempts++;
        lastAttempt = now;
        healthySince = null;
        record(reason);
        const cur = video.currentTime;
        // 不跳到远处：只跨过 <= 0.5 秒的缓冲小间隙，或在已有缓冲内微跳。
        const buffer = ranges();
        const next = buffer.find(([start, end]) => start > cur && start - cur <= 0.5 && end - start > 0.1);
        const covering = buffer.find(([start, end]) => start <= cur && end > cur + 0.1);
        if (attempts === 1 && !video.error && (next || covering)) {
          try {
            video.currentTime = next ? next[0] + 0.01 : cur + 0.01;
            record('buffer-seek');
            baseline();
            return true;
          } catch (_) {}
        }
        // blob 通常由站点 HLS/MSE 管线管理，load() 会破坏它；未知流不盲目重载。
        if (!/^https?:/i.test(video.currentSrc) || video.srcObject || !Number.isFinite(video.duration)) {
          attempts = 3;
          record('needs-site-reload');
          console.warn('[沪上插班生播放器替换] 卡顿未恢复，当前媒体需由平台重新加载。诊断：', state());
          return false;
        }
        const saved = { src: video.currentSrc, position: cur, rate: video.playbackRate,
          volume: video.volume, muted: video.muted };
        const restore = () => {
          cancelReload();
          if (disposed || !video.isConnected || video !== pickVideo() || video.currentSrc !== saved.src) return;
          try {
            video.currentTime = Math.max(0, Math.min(saved.position, video.duration - 0.05));
            video.playbackRate = saved.rate;
            video.volume = saved.volume;
            video.muted = saved.muted;
            video.play().catch(() => record('resume-rejected'));
            record('position-restored');
          } catch (_) { record('restore-failed'); }
          baseline();
        };
        pendingReload = { restore, timer: setTimeout(() => {
          cancelReload();
          record('reload-timeout');
        }, 15000) };
        video.addEventListener('loadedmetadata', restore);
        try {
          record('reload-url');
          video.load();
          // 每次卡顿最多一次媒体重载；持续正常播放 30 秒后才重置预算。
          attempts = 3;
        } catch (_) {
          cancelReload();
          record('reload-failed');
        }
        return true;
      }
      listen('play', baseline);
      listen('pause', () => { if (!pendingReload) baseline(); });
      listen('seeking', () => { healthySince = null; baseline(); });
      listen('seeked', baseline);
      listen('emptied', () => {
        if (!pendingReload) { attempts = 0; playingVideos.delete(video); }
        baseline();
      });
      for (const event of ['waiting', 'stalled', 'error']) listen(event, () => record(event));
      const timer = setInterval(() => {
        const now = performance.now();
        const delayed = now - lastTick > 5000;
        lastTick = now;
        if (source !== video.currentSrc && !pendingReload) {
          source = video.currentSrc;
          attempts = 0;
          lastAttempt = -Infinity;
          healthySince = null;
          baseline();
        }
        if (disposed || !video.isConnected || video !== pickVideo() || video.paused ||
            video.ended || video.seeking || isRealHidden() || delayed || navigator.onLine === false) {
          healthySince = null;
          baseline();
          return;
        }
        trackFrame();
        const advanced = video.currentTime > lastTime + 0.02;
        if (advanced) {
          lastProgress = now;
          if (healthySince === null) healthySince = now;
          if (now - healthySince >= 30000 && (!video.requestVideoFrameCallback || now - lastFrame < 4000)) attempts = 0;
        } else healthySince = null;
        lastTime = video.currentTime;
        if (now - lastProgress >= 12000) recover('playback-stalled');
        else if (video.requestVideoFrameCallback && now - lastFrame >= 4000 &&
            video.currentTime - frameTime > 1 && video.readyState >= 2) recover('frames-stalled');
      }, 1000);
      return {
        state, retry: () => recover('manual-retry'),
        destroy() {
          disposed = true;
          clearInterval(timer);
          cancelReload();
          container.removeEventListener('pointerdown', onUserInput, true);
          document.removeEventListener('keydown', onUserInput, true);
          if (frameId !== null && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameId);
          for (const [type, handler] of listeners) video.removeEventListener(type, handler);
          playingVideos.delete(video);
        }
      };
    }

    /* =========================================================================
     * 第二部分：视频水印净化与隐藏
     * ========================================================================= */
    function initWatermarkRemover(args) {
      args = args || {};
      const NS = "__tabbit_watermark_remover__";
      const STYLE_ID = NS + "_style";
      const SCOPE = args && args.scope ? String(args.scope) : "video-watermark";
      const SELECTOR = "." + SCOPE + ", ." + SCOPE + "-text";

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
     * 第三部分：开源播放器 Plyr 接管核心逻辑
     * ========================================================================= */
    const NS = '__tbVideoPlayer';
    const CSS_ID = 'tb-video-player-style';
    const WEBFS_CSS_ID = 'tb-webfs-style';
    const PLYR_CSS_ID = 'tb-plyr-css';
    const PLYR_JS_ID = 'tb-plyr-js';
    const PLYR_CSS = 'https://cdn.jsdelivr.net/npm/plyr@3.7.8/dist/plyr.css';
    const PLYR_JS = 'https://cdn.jsdelivr.net/npm/plyr@3.7.8/dist/plyr.min.js';

    const HIDE_SELECTORS = [
      '.h5-ready-play-entry',
      '.h5-fullscreen-entry',
      '.extFullControl',
      '.suoping-box',
      '.TouchView',
      '.TextBubble-view',
      '.video-watermark',
      '.video-watermark-text'
    ];

    function ensureCss(href, id) {
      if (document.getElementById(id)) return;
      const l = document.createElement('link');
      l.id = id;
      l.rel = 'stylesheet';
      l.href = href;
      (document.head || document.documentElement).appendChild(l);
    }

    let libraryPromise = null;
    let libraryRetryAfter = 0;
    function loadJs(src, id) {
      if (typeof globalThis.Plyr === 'function') return Promise.resolve();
      if (libraryPromise) return libraryPromise;
      libraryPromise = new Promise((resolve, reject) => {
        const existing = document.getElementById(id);
        if (existing) existing.remove();
        const s = document.createElement('script');
        s.id = id;
        s.src = src;
        s.async = true;
        const finish = (error) => {
          clearTimeout(timeout);
          s.onload = s.onerror = null;
          if (error) { s.remove(); reject(error); } else resolve();
        };
        const timeout = setTimeout(() => finish(new Error('Plyr load timeout')), 15000);
        s.onload = () => finish(typeof globalThis.Plyr === 'function' ? null : new Error('Plyr unavailable'));
        s.onerror = () => finish(new Error('Plyr load error'));
        (document.head || document.documentElement).appendChild(s);
      }).catch(error => {
        libraryPromise = null;
        libraryRetryAfter = Date.now() + 30000;
        throw error;
      });
      return libraryPromise;
    }

    function ensurePlayerStyle() {
      let style = document.getElementById(CSS_ID);
      if (!style) {
        style = document.createElement('style');
        style.id = CSS_ID;
        (document.head || document.documentElement).appendChild(style);
      }
      style.textContent = `
        ${HIDE_SELECTORS.join(',\n')} { display: none !important; }
        /* 关键修复：uni 的 slots 覆盖层默认 pointer-events:auto，会拦截一切点击。
           强制其全部子层不拦截指针，仅保留返回按钮可点 */
        #VideoView .uni-video-slots,
        #VideoView .uni-video-slots * { pointer-events: none !important; }
        #VideoView .uni-video-slots .Back-btn-top,
        #VideoView .uni-video-slots .Back-btn-top * { pointer-events: auto !important; }
        /* 兜底：视频容器内的 cover-view 层一律不拦指针 */
        #myVideo uni-cover-view { pointer-events: none !important; }
        /* 让开源播放器撑满原视频区域并位于可交互层 */
        #VideoView .plyr { width: 100% !important; height: 100% !important; }
        #VideoView .plyr__video-wrapper { height: 100% !important; }
        #VideoView .plyr video { width: 100% !important; height: 100% !important; }
      `;
    }

    function ensureWebFsStyle() {
      let webfsStyle = document.getElementById(WEBFS_CSS_ID);
      if (!webfsStyle) {
        webfsStyle = document.createElement('style');
        webfsStyle.id = WEBFS_CSS_ID;
        (document.head || document.documentElement).appendChild(webfsStyle);
      }
      webfsStyle.textContent = `
        #VideoView.tb-webfs {
          position: fixed !important;
          top: 0 !important;
          left: 0 !important;
          width: 100vw !important;
          height: 100vh !important;
          max-width: none !important;
          max-height: none !important;
          margin: 0 !important;
          z-index: 2147483000 !important;
          background: #000;
        }
        #VideoView.tb-webfs video,
        #VideoView.tb-webfs .plyr,
        #VideoView.tb-webfs .plyr__video-wrapper {
          width: 100% !important;
          height: 100% !important;
        }
        body:has(#VideoView.tb-webfs) {
          overflow: hidden !important;
        }
        .plyr__control.tb-webfs-btn[data-state="on"] {
          background: var(--plyr-color-main, #00b3ff) !important;
          color: #fff !important;
        }
      `;
    }

    // 立即发起样式和库的预加载
    ensureCss(PLYR_CSS, PLYR_CSS_ID);
    loadJs(PLYR_JS, PLYR_JS_ID).catch(() => {});

    let currentInstance = null;
    let isMounting = false;
    let activeKeyHandler = null;

    async function mountPlyr(args) {
      if (isMounting || Date.now() < libraryRetryAfter) return;
      const root = document.querySelector('#VideoView');
      if (!root) {
        return { ok: false, summary: '未找到播放器容器 #VideoView', warnings: ['target_not_found'] };
      }
      let video = root.querySelector('video');
      if (!video) {
        return { ok: false, summary: '未找到原生 <video> 元素', warnings: ['target_not_found'] };
      }

      // 如果当前视频已经接管，直接返回状态
      if (video.plyr && currentInstance && currentInstance.video === video) {
        return {
          ok: true,
          summary: 'Plyr 播放器已在运行中',
          changed_count: 0,
          data: currentInstance.state()
        };
      }

      isMounting = true;
      try {
        // 清理旧实例
        if (currentInstance && typeof currentInstance.destroy === 'function') {
          try { currentInstance.destroy(); } catch (_) {}
        } else if (globalThis.Plyr && video.plyr) {
          try { video.plyr.destroy(); } catch (_) {}
        }
        video = root.querySelector('video');
        if (!video) {
          return { ok: false, summary: '清理后未找到原生 <video> 元素', warnings: ['target_not_found'] };
        }

        ensureCss(PLYR_CSS, PLYR_CSS_ID);
        if (!globalThis.Plyr) {
          try {
            await loadJs(PLYR_JS, PLYR_JS_ID);
          } catch (e) {
            return {
              ok: false,
              summary: '无法加载开源播放器 Plyr（可能被 CSP 或网络限制）',
              warnings: ['library_load_failed', String(e && e.message)]
            };
          }
        }
        if (!globalThis.Plyr || typeof globalThis.Plyr !== 'function') {
          return { ok: false, summary: 'Plyr 未就绪', warnings: ['library_not_ready'] };
        }
        // CDN 加载期间可能已经切课，不能接管过期的视频节点。
        if (!root.isConnected || root.querySelector('video') !== video ||
            document.querySelector('#VideoView') !== root) return;

        const previousRate = video.playbackRate;
        const player = new globalThis.Plyr(video, {
          controls: [
            'play-large',
            'play',
            'progress',
            'current-time',
            'duration',
            'mute',
            'volume',
            'settings',
            'pip',
            'fullscreen'
          ],
          settings: ['speed'],
          speed: { selected: previousRate, options: [0.5, 0.75, 1, 1.25, 1.5, 2] },
          seekTime: 10,
          hideControls: true,
          tooltips: { controls: true, seek: true },
          i18n: {
            play: '播放',
            pause: '暂停',
            mute: '静音',
            unmute: '取消静音',
            settings: '设置',
            speed: '速度',
            normal: '正常',
            enterFullscreen: '全屏',
            exitFullscreen: '退出全屏',
            pip: '画中画'
          }
        });
        player.speed = previousRate;
        ensurePlayerStyle();
        ensureWebFsStyle();
        const recovery = createPlaybackRecovery(video);
        if (!video.paused) playingVideos.add(video);

        // ---------- 网页全屏（铺满浏览器视口，非系统全屏 API） ----------
        const isWebFs = () => root.classList.contains('tb-webfs');
        let webfsBtn = null;
        const toggleWebFs = (force) => {
          const nextState = typeof force === 'boolean' ? force : !isWebFs();
          root.classList.toggle('tb-webfs', nextState);
          if (webfsBtn) webfsBtn.setAttribute('data-state', nextState ? 'on' : 'off');
          return nextState;
        };

        // 在 Plyr 控制栏全屏按钮旁插入网页全屏按钮
        const setupWebFsButton = () => {
          if (root.querySelector('.tb-webfs-btn')) return;
          try {
            const fsPlyrBtn = root.querySelector('.plyr__controls .plyr__control[data-plyr="fullscreen"]');
            if (fsPlyrBtn && fsPlyrBtn.parentElement) {
              webfsBtn = document.createElement('button');
              webfsBtn.type = 'button';
              webfsBtn.className = 'plyr__control tb-webfs-btn';
              webfsBtn.setAttribute('aria-label', '网页全屏');
              webfsBtn.title = '网页全屏 (W)';
              webfsBtn.dataset.state = isWebFs() ? 'on' : 'off';
              webfsBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M4 4h6v2H6v4H4V4zm10 0h6v6h-2V6h-4V4zM4 14h2v4h4v2H4v-6zm14 0h2v6h-6v-2h4v-4z"/></svg>';
              webfsBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleWebFs();
              });
              fsPlyrBtn.parentElement.insertBefore(webfsBtn, fsPlyrBtn);
            }
          } catch (_) {}
        };
        setupWebFsButton();
        player.on('ready', setupWebFsButton);

        if (activeKeyHandler) {
          document.removeEventListener('keydown', activeKeyHandler, true);
          activeKeyHandler = null;
        }

        const onKey = (e) => {
          if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
          if (e.metaKey || e.ctrlKey || e.altKey) return;
          switch (e.code) {
            case 'Space':
              e.preventDefault();
              e.stopPropagation();
              player.togglePlay();
              break;
            case 'ArrowRight':
              e.preventDefault();
              e.stopPropagation();
              player.forward(player.config.seekTime || 10);
              break;
            case 'ArrowLeft':
              e.preventDefault();
              e.stopPropagation();
              player.rewind(player.config.seekTime || 10);
              break;
            case 'ArrowUp':
              e.preventDefault();
              e.stopPropagation();
              player.increaseVolume(0.05);
              break;
            case 'ArrowDown':
              e.preventDefault();
              e.stopPropagation();
              player.decreaseVolume(0.05);
              break;
            case 'KeyM':
              e.preventDefault();
              e.stopPropagation();
              player.muted = !player.muted;
              break;
            case 'KeyF':
              e.preventDefault();
              e.stopPropagation();
              player.fullscreen.toggle();
              break;
            case 'KeyW':
              e.preventDefault();
              e.stopPropagation();
              toggleWebFs();
              break;
            case 'Escape':
              if (isWebFs()) {
                e.preventDefault();
                e.stopPropagation();
                toggleWebFs(false);
              }
              break;
          }
        };
        activeKeyHandler = onKey;
        document.addEventListener('keydown', onKey, true);

        const instance = {
          version: 'plyr-3.7.8',
          library: 'Plyr (MIT)',
          root,
          video,
          player,
          recovery,
          isWebFs,
          toggleWebFs,
          destroy() {
            recovery.destroy();
            try { player.destroy(); } catch (e) {}
            if (activeKeyHandler) {
              document.removeEventListener('keydown', activeKeyHandler, true);
              activeKeyHandler = null;
            }
            root.classList.remove('tb-webfs');
            const ws = document.getElementById(WEBFS_CSS_ID);
            if (ws) ws.remove();
            const st = document.getElementById(CSS_ID);
            if (st) st.remove();
            if (globalThis[NS] === instance) globalThis[NS] = null;
            if (globalThis['__hsPlayerReplacer'] === instance) globalThis['__hsPlayerReplacer'] = null;
            if (currentInstance === instance) currentInstance = null;
          },
          state() {
            return {
              paused: video.paused,
              currentTime: video.currentTime,
              duration: video.duration,
              muted: video.muted,
              volume: video.volume,
              rate: video.playbackRate,
              webfs: isWebFs(),
              recovery: recovery.state()
            };
          },
          run: (newArgs) => mountPlyr(newArgs)
        };

        currentInstance = instance;
        globalThis[NS] = instance;
        globalThis['__hsPlayerReplacer'] = instance;

        console.log("%c[沪上插班生播放器替换] 已用开源播放器 Plyr 接管原始 <video>（网页全屏 + 去水印 + 全键盘快捷键已就绪）！", "color: #10b981; font-weight: bold;");

        return {
          ok: true,
          summary: '已用开源播放器 Plyr 接管原始 <video>（保留原有视频源与解码管线）',
          changed_count: 1,
          data: {
            library: 'Plyr 3.7.8 (MIT)',
            cdn: PLYR_JS,
            plyr_wrapper: !!root.querySelector('.plyr'),
            hidden_page_controls: HIDE_SELECTORS,
            preserved: ['video#myVideo (原生 <video>/HLS)', '.Back-btn-top (返回导航)'],
            controls: ['大播放按钮', '播放/暂停', '进度拖拽', '时间', '音量/静音', '倍速', '画中画', '网页全屏', '全屏']
          },
          warnings: []
        };
      } finally {
        isMounting = false;
      }
    }

    // 监听 DOM 变动与轮询检测，以在 SPA 路由切换、进入视频页时自动接管
    function checkPlayer() {
      const v = document.querySelector('#VideoView video');
      if (currentInstance && (!currentInstance.video.isConnected || !v)) currentInstance.destroy();
      if (v && (!v.plyr || !currentInstance || currentInstance.video !== v)) {
        mountPlyr().catch(error => console.warn('[沪上插班生播放器替换] 接管失败:', error));
      }
    }
    let checkQueued = false;
    const observer = new MutationObserver(() => {
      if (checkQueued) return;
      checkQueued = true;
      setTimeout(() => { checkQueued = false; checkPlayer(); }, 100);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    setInterval(checkPlayer, 1200);
    checkPlayer();

    /* =========================================================================
     * 第四部分：页面提示与初始化通知
     * ========================================================================= */
    function showNotification() {
      const tip = document.createElement("div");
      tip.id = "__hs_player_replacer_notification";
      tip.innerHTML = "✨ 沪上插班生视频播放器已替换 (Plyr + 去水印)";
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
      console.warn("[沪上插班生视频播放器替换] 标签注入失败:", e);
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
