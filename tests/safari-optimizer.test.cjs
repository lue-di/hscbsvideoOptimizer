const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const script = fs.readFileSync(path.join(__dirname, '../沪上插班生视频优化-Safari.user.js'), 'utf8');

function harness({ csp = false, rvfc = true, videoWidth = 640 } = {}) {
  let now = 0;
  let hidden = false;
  let sequence = 0;
  const timers = new Map();
  const logs = [];

  class Target {
    constructor() { this.listeners = []; }
    addEventListener(type, fn, options) {
      const capture = options === true || !!(options && options.capture);
      this.listeners.push({ type, fn, capture, once: !!(options && options.once) });
    }
    removeEventListener(type, fn, options) {
      const capture = options === true || !!(options && options.capture);
      this.listeners = this.listeners.filter(l => !(l.type === type && l.fn === fn && l.capture === capture));
    }
  }
  function dispatch(chain, type, extra = {}) {
    // chain: 从 window 到事件目标
    let stopped = false;
    const event = Object.assign({ type, target: chain[chain.length - 1], stopImmediatePropagation() { stopped = true; } }, extra);
    const phases = [...chain.map((t, i) => [t, i === chain.length - 1 ? null : true]), ...chain.slice(0, -1).reverse().map(t => [t, false])];
    for (const [target, capture] of phases) {
      for (const l of [...target.listeners]) {
        if (l.type !== type || (capture !== null && l.capture !== capture)) continue;
        if (l.once) target.removeEventListener(type, l.fn, l.capture);
        l.fn.call(target, event);
        if (stopped) return event;
      }
    }
    return event;
  }

  class Element extends Target {
    constructor(tag) {
      super();
      this.tagName = tag.toUpperCase();
      this.attrs = new Map();
      this.children = [];
      this.parentNode = null;
      this.style = {};
      const classes = new Set();
      this.classList = {
        add: (...c) => c.forEach(x => classes.add(x)),
        remove: (...c) => c.forEach(x => classes.delete(x)),
        contains: c => classes.has(c)
      };
    }
    get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === html; }
    setAttribute(k, v) { this.attrs.set(k, String(v)); }
    hasAttribute(k) { return this.attrs.has(k); }
    removeAttribute(k) { this.attrs.delete(k); }
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      if (child.tagName === 'SCRIPT' && !csp) vm.runInContext(child.textContent, context);
      return child;
    }
    removeChild(child) { this.children = this.children.filter(c => c !== child); child.parentNode = null; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  }

  class Document extends Target {}
  Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });

  const html = new Element('html');
  const head = html.appendChild(new Element('head'));
  const body = html.appendChild(new Element('body'));
  const document = new Document();
  const window = new Target();

  class HTMLMediaElement extends Element {
    pause() { if (!this.paused) { this.paused = true; dispatch([window, document, this], 'pause'); } }
    play() {
      this.plays = (this.plays || 0) + 1;
      if (this.paused) { this.paused = false; dispatch([window, document, this], 'play'); }
      return Promise.resolve();
    }
  }
  class HTMLVideoElement extends HTMLMediaElement {}
  const frameCallbacks = new Map();
  if (rvfc) {
    HTMLVideoElement.prototype.requestVideoFrameCallback = function (fn) { const id = ++sequence; frameCallbacks.set(id, fn); return id; };
    HTMLVideoElement.prototype.cancelVideoFrameCallback = function (id) { frameCallbacks.delete(id); };
  }

  function makeVideo() {
    const v = new HTMLVideoElement('video');
    let position = 10;
    v.seeks = [];
    Object.assign(v, { paused: true, ended: false, seeking: false, error: null, readyState: 4, videoWidth });
    v.buffered = { length: 1, start: () => 0, end: () => 100 };
    Object.defineProperty(v, 'currentTime', { get: () => position, set(t) { position = t; v.seeks.push(t); } });
    v.advance = s => { position += s; };
    body.appendChild(v);
    return v;
  }
  let video = makeVideo();

  const allElements = () => { const out = []; const walk = n => n.children.forEach(c => { out.push(c); walk(c); }); walk(html); return out; };
  Object.assign(document, {
    documentElement: html, head, body,
    createElement: tag => new Element(tag),
    querySelector: sel => (/video/.test(sel) ? allElements().find(e => e.tagName === 'VIDEO') || null : null),
    querySelectorAll: () => [],
    getElementById: id => allElements().find(e => e.id === id) || null
  });

  const mediaHandlers = {};
  const context = vm.createContext({
    document, Document, HTMLMediaElement, HTMLVideoElement, PointerEvent: function () {},
    MutationObserver: class { observe() {} disconnect() {} },
    navigator: { mediaSession: { setActionHandler: (name, fn) => { mediaHandlers[name] = fn; } } },
    performance: { now: () => now },
    console: { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')) },
    getComputedStyle: () => ({ display: 'none' }),
    setTimeout(fn, delay = 0) { const id = ++sequence; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, delay) { const id = ++sequence; timers.set(id, { fn, at: now + delay, every: delay }); return id; },
    clearInterval(id) { timers.delete(id); }
  });
  context.window = context;
  context.globalThis = context;
  // window 事件统一走同一个 Target
  for (const k of ['addEventListener', 'removeEventListener']) context[k] = window[k].bind(window);

  vm.runInContext(script, context);

  function advanceTo(target) {
    for (;;) {
      let next = null;
      for (const [id, t] of timers) if (t.at <= target && (!next || t.at < next[1].at)) next = [id, t];
      if (!next) break;
      const [id, t] = next;
      now = t.at;
      if (t.every) t.at += t.every; else timers.delete(id);
      t.fn();
    }
    now = target;
  }

  return {
    context, document, window, mediaHandlers, logs, frameCallbacks,
    get video() { return video; },
    replaceVideo() { video.remove(); video = makeVideo(); return video; },
    setHidden(value) { hidden = value; return dispatch([window, document], 'visibilitychange'); },
    focus() { dispatch([window], 'focus'); },
    nativePause() { video.paused = true; dispatch([window, document, video], 'pause'); },
    // 前进 ms 毫秒；playing 时时间轴同步推进，paint 为 true 时每 100ms 出一帧
    run(ms, { playing = true, paint = false } = {}) {
      for (let t = 0; t < ms; t += 100) {
        if (playing && !video.paused) video.advance(0.1);
        advanceTo(now + 100);
        if (paint) {
          for (const [id, fn] of [...frameCallbacks]) { frameCallbacks.delete(id); fn(now, { mediaTime: video.currentTime }); }
        }
      }
    },
    countById: id => allElements().filter(e => e.id === id).length,
    html
  };
}

test('boots exactly once via page injection and cleans the marker', () => {
  const h = harness();
  assert.equal(h.countById('__hs_video_opt_notification'), 1);
  assert.equal(h.countById('tabbit-fat-player-controls-fix-style'), 1);
  assert.equal(h.html.hasAttribute('data-hs-video-opt'), false);
  assert.equal(typeof h.context.__hsPlayerControlsFix.getState, 'function');
  assert.equal(typeof h.context.__hsWatermarkRemover.getState, 'function');
});

test('falls back to direct run when CSP blocks the inline script', () => {
  const h = harness({ csp: true });
  assert.equal(h.countById('__hs_video_opt_notification'), 1);
  assert.equal(h.context.__hsVideoOptInjected, true);
});

test('page never observes hidden state or background visibilitychange', () => {
  const h = harness();
  let seen = 0;
  h.document.addEventListener('visibilitychange', () => { seen++; });
  h.setHidden(true);
  assert.equal(h.document.hidden, false);
  assert.equal(h.document.visibilityState, 'visible');
  assert.equal(seen, 0);
  h.setHidden(false);
  assert.equal(seen, 1);
});

test('background pause() on the playing video is ignored, foreground pause works', () => {
  const h = harness();
  h.video.play();
  h.setHidden(true);
  h.video.pause();
  assert.equal(h.video.paused, false);
  h.setHidden(false);
  h.video.pause();
  assert.equal(h.video.paused, true);
});

test('background pause() is allowed for a video that was not playing', () => {
  const h = harness();
  h.setHidden(true);
  h.video.paused = false; // 未经 play 事件启动，脚本不认为它是用户正在播放的视频
  h.video.pause();
  assert.equal(h.video.paused, true);
});

test('unexpected background pause is resumed, media-key pause is respected', () => {
  const h = harness();
  h.video.play();
  h.setHidden(true);
  h.nativePause();
  h.run(100);
  assert.equal(h.video.paused, false);

  h.mediaHandlers.pause();
  assert.equal(h.video.paused, true);
  h.run(2000);
  assert.equal(h.video.paused, true);
});

test('focus alone never seeks', () => {
  const h = harness();
  h.video.play();
  h.run(1000, { paint: true });
  h.focus();
  h.run(5000, { paint: true });
  assert.deepEqual(h.video.seeks, []);
});

test('returning to foreground with healthy frames does not seek', () => {
  const h = harness();
  h.video.play();
  h.run(1000, { paint: true });
  h.setHidden(true);
  h.run(10000);
  h.setHidden(false);
  h.run(10000, { paint: true });
  assert.deepEqual(h.video.seeks, []);
});

test('frozen picture after returning triggers bounded micro-seeks', () => {
  const h = harness();
  h.video.play();
  h.run(1000, { paint: true });
  h.setHidden(true);
  h.run(10000);
  h.setHidden(false);
  h.run(2000);
  assert.equal(h.video.seeks.length, 1);
  h.run(30000);
  assert.equal(h.video.seeks.length, 2, 'no more than two seeks without a new frame');
});

test('audio-only media is never seeked', () => {
  const h = harness({ videoWidth: 0 });
  h.video.play();
  h.setHidden(true);
  h.run(5000);
  h.setHidden(false);
  h.run(20000);
  assert.deepEqual(h.video.seeks, []);
});

test('frame monitor follows a replaced video element', () => {
  const h = harness();
  h.video.play();
  h.run(1000, { paint: true });
  const next = h.replaceVideo();
  next.play();
  h.run(5000, { paint: true });
  assert.deepEqual(next.seeks, []);
  h.run(3000);
  assert.equal(next.seeks.length, 1);
});

test('controls hide after idle and stay while dragging', () => {
  const h = harness();
  const api = h.context.__hsPlayerControlsFix;
  h.run(3100, { playing: false });
  assert.equal(api.getState().hide_active, true);
  const down = h.document.listeners.find(l => l.type === 'pointerdown');
  const up = h.document.listeners.find(l => l.type === 'pointerup');
  down.fn();
  h.run(6000, { playing: false });
  assert.equal(api.getState().show_active, true);
  up.fn();
  h.run(3100, { playing: false });
  assert.equal(api.getState().hide_active, true);
});
