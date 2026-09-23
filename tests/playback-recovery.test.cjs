const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const script = fs.readFileSync(path.join(__dirname, '../沪上插班生视频播放器替换.user.js'), 'utf8');
const start = script.indexOf('    function createPlaybackRecovery(video) {');
const end = script.indexOf('\n    /* ===', start);

function harness({ src = 'blob:lesson', buffer = [], frames = false } = {}) {
  let now = 0;
  let hidden = false;
  let online = true;
  let sequence = 0;
  const timers = new Map();
  const callbacks = new Map();
  const listeners = new Map();
  const events = () => {
    const map = new Map();
    return {
      addEventListener(type, fn) { if (!map.has(type)) map.set(type, new Set()); map.get(type).add(fn); },
      removeEventListener(type, fn) { map.get(type)?.delete(fn); },
      emit(type) { for (const fn of [...(map.get(type) || [])]) fn(); }
    };
  };
  const document = events();
  let position = 10;
  const seeks = [];
  const video = Object.assign(events(), {
    currentSrc: src, paused: false, ended: false, seeking: false, isConnected: true,
    readyState: 2, networkState: 2, error: null, srcObject: null,
    duration: 100, playbackRate: 1.5, volume: 0.6, muted: true,
    buffered: { get length() { return buffer.length; }, start: i => buffer[i][0], end: i => buffer[i][1] },
    closest: () => null,
    loads: 0, plays: 0,
    load() { this.loads++; position = 0; this.paused = true; this.emit('emptied'); },
    play() { this.plays++; this.paused = false; this.emit('play'); return Promise.resolve(); }
  });
  Object.defineProperty(video, 'currentTime', {
    get: () => position,
    set(value) { position = value; seeks.push(value); }
  });
  if (frames) {
    video.requestVideoFrameCallback = fn => { const id = ++sequence; callbacks.set(id, fn); return id; };
    video.cancelVideoFrameCallback = id => callbacks.delete(id);
  }
  const context = vm.createContext({
    performance: { now: () => now }, document, Date,
    navigator: { get onLine() { return online; } },
    console: { warn() {} }, playingVideos: new WeakSet(),
    isRealHidden: () => hidden, pickVideo: () => video,
    setInterval(fn) { const id = ++sequence; listeners.set(id, fn); return id; },
    clearInterval(id) { listeners.delete(id); },
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  vm.runInContext(script.slice(start, end), context);
  const recovery = context.createPlaybackRecovery(video);
  return {
    video, recovery, seeks, callbacks, document,
    hidden(value) { hidden = value; }, online(value) { online = value; },
    tick(seconds, advance = 0) {
      for (let i = 0; i < seconds; i++) {
        now += 1000; position += advance;
        for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.fn(); }
        for (const fn of listeners.values()) fn();
      }
    }
  };
}

test('normal playback never seeks or reloads', () => {
  const h = harness(); h.tick(60, 1);
  assert.equal(h.seeks.length, 0); assert.equal(h.video.loads, 0);
});

test('12 second stall skips only a small buffered gap and respects cooldown', () => {
  const h = harness({ buffer: [[10.2, 25]] });
  h.tick(11); assert.equal(h.seeks.length, 0);
  h.tick(1); assert.equal(h.seeks.length, 1); assert.ok(Math.abs(h.seeks[0] - 10.21) < 0.001);
  h.tick(14); assert.equal(h.recovery.state().attempts, 1);
});

test('MSE stall never calls load and stops retrying', () => {
  const h = harness({ buffer: [[30, 40]] }); h.tick(60);
  assert.equal(h.video.loads, 0); assert.equal(h.seeks.length, 0);
  assert.equal(h.recovery.state().attempts, 3);
  assert.equal(h.recovery.state().history.filter(e => e.action === 'needs-site-reload').length, 1);
});

test('direct URL reload restores progress and preferences once', () => {
  const h = harness({ src: 'https://example.test/lesson.mp4' }); h.tick(12);
  assert.equal(h.video.loads, 1); assert.equal(h.recovery.state().reloading, true);
  h.video.playbackRate = 1; h.video.volume = 1; h.video.muted = false;
  h.video.emit('loadedmetadata');
  assert.equal(h.video.currentTime, 10); assert.equal(h.video.playbackRate, 1.5);
  assert.equal(h.video.volume, 0.6); assert.equal(h.video.muted, true);
  assert.equal(h.video.plays, 1); h.tick(60); assert.equal(h.video.loads, 1);
});

test('pause, seek, hidden tab, offline and removed video suppress recovery', () => {
  for (const mode of ['pause', 'seek', 'hidden', 'offline', 'removed']) {
    const h = harness({ src: 'https://example.test/lesson.mp4' });
    if (mode === 'pause') h.video.paused = true;
    if (mode === 'seek') h.video.seeking = true;
    if (mode === 'hidden') h.hidden(true);
    if (mode === 'offline') h.online(false);
    if (mode === 'removed') h.video.isConnected = false;
    h.tick(30); assert.equal(h.video.loads, 0, mode); assert.equal(h.seeks.length, 0, mode);
  }
});

test('user input cancels pending resume', () => {
  const h = harness({ src: 'https://example.test/lesson.mp4' }); h.tick(12);
  h.document.emit('keydown'); h.video.emit('loadedmetadata');
  assert.equal(h.video.plays, 0); assert.equal(h.recovery.state().reloading, false);
});

test('switching source during reload never restores old lesson position', () => {
  const h = harness({ src: 'https://example.test/lesson.mp4' }); h.tick(12);
  h.video.currentSrc = 'https://example.test/next.mp4'; h.video.emit('loadedmetadata');
  assert.equal(h.video.plays, 0); assert.equal(h.seeks.length, 0);
});

test('destroy cancels pending reload, frame callbacks and watchdog', () => {
  const h = harness({ src: 'https://example.test/lesson.mp4', frames: true }); h.tick(12);
  assert.equal(h.callbacks.size, 1); h.recovery.destroy();
  assert.equal(h.callbacks.size, 0); h.video.emit('loadedmetadata'); h.tick(60);
  assert.equal(h.video.plays, 0); assert.equal(h.video.loads, 1);
});

test('frame stall recovery is bounded and requires advancing media time', () => {
  const h = harness({ frames: true, buffer: [[0, 90]] }); h.tick(4, 1);
  assert.equal(h.seeks.length, 1);
  h.tick(14, 1); assert.equal(h.seeks.length, 1);
});

test('reload timeout clears late metadata handler', () => {
  const h = harness({ src: 'https://example.test/lesson.mp4' }); h.tick(30);
  h.video.emit('loadedmetadata'); assert.equal(h.video.plays, 0);
  assert.equal(h.recovery.state().reloading, false);
});

test('Plyr library load is shared, times out and can retry after failure', async () => {
  const elements = new Map();
  const timers = new Map();
  let sequence = 0;
  const context = vm.createContext({
    Date,
    document: {
      getElementById: id => elements.get(id),
      createElement() { return { remove() { elements.delete(this.id); } }; },
      head: { appendChild(element) { elements.set(element.id, element); } }
    },
    setTimeout(fn) { const id = ++sequence; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  const from = script.indexOf('    let libraryPromise = null;');
  const to = script.indexOf('    function ensurePlayerStyle()', from);
  vm.runInContext(script.slice(from, to), context);
  const first = context.loadJs('https://example.test/plyr.js', 'lib');
  assert.equal(context.loadJs('https://example.test/plyr.js', 'lib'), first);
  const rejected = assert.rejects(first, /timeout/);
  [...timers.values()][0](); await rejected;
  assert.equal(elements.size, 0);
  assert.ok(vm.runInContext('libraryRetryAfter > Date.now()', context));
  const second = context.loadJs('https://example.test/plyr.js', 'lib');
  context.Plyr = function () {};
  elements.get('lib').onload(); await second;
  assert.equal(timers.size, 0);
});
