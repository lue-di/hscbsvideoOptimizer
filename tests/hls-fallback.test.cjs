const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const script = fs.readFileSync(path.join(__dirname, '../沪上插班生视频播放器替换.user.js'), 'utf8');
const start = script.indexOf('    function createHlsFallback(');
const end = script.indexOf('    // ---- 6.', start);
assert.ok(start > 0 && end > start);
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(options = {}) {
  const events = () => {
    const listeners = new Map();
    return {
      addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
      removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
      emit(type) { for (const fn of [...(listeners.get(type) || [])]) fn(); }
    };
  };
  const video = Object.assign(events(), {
    src: 'https://example.test/lesson.m3u8?secret=private',
    currentSrc: 'https://example.test/lesson.m3u8?secret=private',
    srcObject: null, isConnected: true, paused: true, error: { code: 4 },
    currentTime: 42, duration: 100, playbackRate: 1.5, volume: 0.6, muted: true,
    buffered: { length: 1, start: () => 20, end: () => 42.157 },
    closest: () => null, plays: 0,
    play() { this.plays++; this.paused = false; return Promise.resolve(); }
  });
  const document = events();
  const instances = [];
  const timers = new Map();
  let sequence = 0;
  let observer;
  let loadCalls = 0;
  class Hls {
    static Events = { MEDIA_ATTACHED: 'attached', MANIFEST_PARSED: 'parsed', ERROR: 'error' };
    static ErrorTypes = { MEDIA_ERROR: 'mediaError', NETWORK_ERROR: 'networkError' };
    static isSupported() { return !options.unsupported; }
    constructor(config) { this.config = config; this.handlers = new Map(); this.recoveries = 0; this.stops = 0; instances.push(this); }
    on(type, fn) { this.handlers.set(type, fn); }
    emit(type, data) { this.handlers.get(type)?.(type, data); }
    attachMedia(v) { this.video = v; v.src = 'blob:owned'; v.currentSrc = v.src; v.error = null; }
    loadSource(src) { this.loadedSource = src; }
    stopLoad() { this.stops++; }
    recoverMediaError() { this.recoveries++; this.video.src = 'blob:recovered'; this.video.currentSrc = this.video.src; }
    destroy() { this.destroyed = true; if (this.video.src.startsWith('blob:')) this.video.src = ''; }
  }
  const context = vm.createContext({
    Date, navigator: { onLine: true }, document,
    isRealHidden: () => !!options.hidden, pickVideo: () => video,
    MutationObserver: class {
      constructor(fn) { observer = this; this.callback = fn; }
      observe() {} disconnect() { this.disconnected = true; }
    },
    setTimeout(fn) { const id = ++sequence; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  vm.runInContext(script.slice(start, end), context);
  const controller = context.createHlsFallback(video, () => { loadCalls++; return options.load ? options.load(Hls) : Promise.resolve(Hls); });
  return { video, document, controller, instances, timers, context,
    get loadCalls() { return loadCalls; }, mutate: () => observer.callback() };
}

test('paused native HLS parse failure triggers fallback once and keeps signed URL intact', async () => {
  const h = harness(); const src = h.video.src;
  h.controller.check(); h.controller.check(); await flush();
  assert.equal(h.loadCalls, 1); assert.equal(h.instances.length, 1);
  const instance = h.instances[0]; instance.emit('attached');
  assert.equal(instance.loadedSource, src); assert.equal(instance.config.startPosition, 42);
  instance.emit('parsed'); h.video.emit('loadedmetadata'); h.video.emit('canplay');
  assert.equal(h.controller.state().status, 'ready'); assert.equal(h.video.plays, 0);
  assert.equal(h.video.playbackRate, 1.5); assert.equal(h.video.currentTime, 42);
  assert.equal(JSON.stringify(h.controller.state()).includes('private'), false);
});

test('healthy HLS, blob, MP4 and media streams are not taken over', async () => {
  for (const type of ['healthy', 'blob', 'mp4', 'stream']) {
    const h = harness();
    if (type === 'healthy') h.video.error = null;
    if (type === 'blob') h.video.src = h.video.currentSrc = 'blob:site';
    if (type === 'mp4') h.video.src = h.video.currentSrc = 'https://example.test/a.mp4';
    if (type === 'stream') h.video.srcObject = {};
    h.controller.check(); await flush(); assert.equal(h.loadCalls, 0, type);
  }
});

test('exhausted native HLS can fall back without error code and resume at the saved position', async () => {
  const h = harness(); h.video.paused = false; h.video.error = null;
  assert.equal(h.controller.recoverStall(), true); await flush();
  assert.equal(h.instances.length, 1);
  h.video.emit('loadedmetadata'); h.video.emit('canplay');
  assert.equal(h.video.currentTime, 42); assert.equal(h.video.plays, 1);
  assert.equal(h.controller.recoverStall(), false);
});

test('native HLS resumed during library loading is not interrupted', async () => {
  let complete;
  const h = harness({ load: Hls => new Promise(resolve => { complete = () => resolve(Hls); }) });
  h.video.paused = false; h.video.error = null;
  h.controller.recoverStall(); h.video.currentTime += 1; complete(); await flush();
  assert.equal(h.instances.length, 0);
});

test('buffered video and intentional pause are not eligible for stall fallback', () => {
  const h = harness(); h.video.error = null;
  assert.equal(h.controller.recoverStall(), false);
  h.video.paused = false; h.video.buffered.end = () => 60;
  assert.equal(h.controller.recoverStall(), false);
  assert.equal(h.loadCalls, 0);
});

test('switching lessons during library load cancels stale attachment', async () => {
  let complete;
  const h = harness({ load: Hls => new Promise(resolve => { complete = () => resolve(Hls); }) });
  h.controller.check(); h.video.src = h.video.currentSrc = 'https://example.test/next.mp4';
  h.mutate(); complete(); await flush(); assert.equal(h.instances.length, 0);
});

test('input while library loads cancels automatic resume without failing setup', async () => {
  let complete;
  const h = harness({ load: Hls => new Promise(resolve => { complete = () => resolve(Hls); }) });
  h.video.paused = false; h.controller.check(); h.document.emit('keydown'); complete(); await flush();
  assert.equal(h.instances.length, 1); h.video.emit('canplay'); assert.equal(h.video.plays, 0);
});

test('fatal network failure stops retries and exposes status without URLs', async () => {
  const h = harness(); h.controller.check(); await flush();
  const instance = h.instances[0];
  instance.emit('error', { type: 'networkError', details: 'manifestLoadError', fatal: true,
    response: { code: 403, url: 'https://secret.test/?token=private', text: 'private' } });
  for (let i = 0; i < 100; i++) h.controller.check();
  assert.equal(h.loadCalls, 1); assert.equal(instance.stops, 1);
  assert.equal(h.controller.state().lastError.httpStatus, 403);
  assert.equal(h.controller.state().status, 'failed');
  assert.equal(JSON.stringify(h.controller.state()).includes('private'), false);
});

test('media recovery is attempted only once and only for a media element error', async () => {
  const h = harness(); h.controller.check(); await flush(); const instance = h.instances[0];
  const error = { type: 'mediaError', details: 'bufferAppendError', fatal: true };
  h.video.error = { code: 3 }; instance.emit('error', error); instance.emit('error', error);
  assert.equal(instance.recoveries, 1); assert.equal(h.controller.state().status, 'failed');
  const other = harness(); other.controller.check(); await flush();
  other.instances[0].emit('error', error); assert.equal(other.instances[0].recoveries, 0);
});

test('source change destroys fallback without replacing the next lesson source', async () => {
  const h = harness(); h.controller.check(); await flush();
  h.video.src = h.video.currentSrc = 'https://example.test/next.mp4'; h.mutate();
  assert.equal(h.instances[0].destroyed, true);
  assert.equal(h.video.src, 'https://example.test/next.mp4');
});

test('destroy restores original source and cancels timers', async () => {
  const h = harness(); const original = h.video.src; h.controller.check(); await flush();
  h.controller.destroy(); assert.equal(h.instances[0].destroyed, true);
  assert.equal(h.video.src, original); assert.equal(h.timers.size, 0);
  h.video.emit('canplay'); assert.equal(h.video.plays, 0);
});

test('unavailable library and unsupported MSE fail once without changing the source', async () => {
  for (const options of [{ unsupported: true }, { load: () => Promise.reject(new Error('CSP')) }]) {
    const h = harness(options); const original = h.video.src;
    h.controller.check(); await flush(); h.controller.check(); await flush();
    assert.equal(h.loadCalls, 1); assert.equal(h.controller.state().status, 'failed');
    assert.equal(h.video.src, original);
  }
});


test('background exhausted HLS falls back once and preserves playback intent', async () => {
  const h = harness({ hidden: true }); h.video.paused = false; h.video.error = null;
  assert.equal(h.controller.recoverStall(), true); await flush();
  assert.equal(h.instances.length, 1);
  h.video.emit('loadedmetadata'); h.video.emit('canplay');
  assert.equal(h.video.plays, 1); assert.equal(h.video.currentTime, 42);
  assert.equal(h.controller.recoverStall(), false);
});

test('background pause, offline, seeking and buffered playback prevent fallback', () => {
  for (const mode of ['paused', 'offline', 'seeking', 'buffered']) {
    const h = harness({ hidden: true }); h.video.paused = false; h.video.error = null;
    if (mode === 'paused') h.video.paused = true;
    if (mode === 'offline') h.context.navigator.onLine = false;
    if (mode === 'seeking') h.video.seeking = true;
    if (mode === 'buffered') h.video.buffered.end = () => 60;
    assert.equal(h.controller.recoverStall(), false, mode);
    assert.equal(h.loadCalls, 0);
  }
});

test('user input or offline during stall library loading cancels takeover', async () => {
  for (const mode of ['input', 'offline']) {
    let complete;
    const h = harness({ hidden: true, load: Hls => new Promise(resolve => { complete = () => resolve(Hls); }) });
    h.video.paused = false; h.video.error = null;
    h.controller.recoverStall();
    if (mode === 'input') h.document.emit('keydown');
    else h.context.navigator.onLine = false;
    complete(); await flush();
    assert.equal(h.instances.length, 0);
  }
});
