const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const script = fs.readFileSync(path.join(__dirname, '../沪上插班生视频播放器替换.user.js'), 'utf8');
const start = script.indexOf('    function createPlaybackRecovery(');
const end = script.indexOf('\n    /* ===', start);

function harness({ src = 'blob:lesson', buffer = [], frames = false, fallback = null } = {}) {
  let now = 0;
  let hidden = false;
  let online = true;
  let sequence = 0;
  const timers = new Map();
  const callbacks = new Map();
  const visibilitySubscribers = new Set();
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
    performance: { now: () => now }, document, Date, visibilitySubscribers,
    navigator: { get onLine() { return online; } },
    console: { warn() {} }, playingVideos: new WeakSet(),
    isRealHidden: () => hidden, pickVideo: () => video,
    setInterval(fn) { const id = ++sequence; listeners.set(id, fn); return id; },
    clearInterval(id) { listeners.delete(id); },
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  vm.runInContext(script.slice(start, end), context);
  const recovery = context.createPlaybackRecovery(video, fallback);
  return {
    video, recovery, seeks, callbacks, document,
    hidden(value) { hidden = value; for (const fn of visibilitySubscribers) fn(value); },
    online(value) { online = value; },
    frame(mediaTime = position) {
      const entry = callbacks.entries().next().value;
      if (entry) { callbacks.delete(entry[0]); entry[1](now, { mediaTime }); }
    },
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

test('HLS failure check runs even when the media element is paused after error', () => {
  let checks = 0;
  const h = harness({ fallback: { check() { checks++; }, state: () => ({ status: 'native' }) } });
  h.video.paused = true; h.video.error = { code: 4 }; h.tick(1);
  assert.equal(checks, 1); assert.equal(h.recovery.state().hls.status, 'native');
});

test('12 second stall skips only a small buffered gap and respects cooldown', () => {
  const h = harness({ buffer: [[10.2, 25]] });
  h.tick(11); assert.equal(h.seeks.length, 0);
  h.tick(1); assert.equal(h.seeks.length, 1); assert.ok(Math.abs(h.seeks[0] - 10.21) < 0.001);
  h.tick(14); assert.equal(h.recovery.state().attempts, 1);
});

test('12 second native HLS stall tries fallback before load or seek', () => {
  let calls = 0;
  const h = harness({ src: 'https://example.test/a.m3u8', buffer: [[0, 10.157]],
    fallback: { check() {}, state: () => ({}), recoverStall() { calls++; return true; } } });
  h.tick(11); assert.equal(calls, 0);
  h.tick(1); assert.equal(calls, 1);
  assert.equal(h.video.loads, 0); assert.equal(h.seeks.length, 0);
  assert.equal(h.recovery.state().scriptVersion, '1.4.3');
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
  // load() 的 emptied 事件现在会立即撤销旧帧回调。
  assert.equal(h.callbacks.size, 0); h.recovery.destroy();
  assert.equal(h.callbacks.size, 0); h.video.emit('loadedmetadata'); h.tick(60);
  assert.equal(h.video.plays, 0); assert.equal(h.video.loads, 1);
});

test('cancelled frame callbacks cannot overwrite a new foreground monitor', () => {
  const h = harness({ frames: true, buffer: [[0, 90]] }); h.tick(1, 1);
  const oldCallback = [...h.callbacks.values()][0];
  h.hidden(true); h.hidden(false);
  oldCallback(999999, { mediaTime: 999999 });
  h.tick(2, 1); assert.equal(h.seeks.length, 1);
  h.recovery.destroy(); assert.equal(h.callbacks.size, 0);
});

test('frame stall recovery is bounded and requires advancing media time', () => {
  const h = harness({ frames: true, buffer: [[0, 90]] }); h.tick(4, 1);
  assert.equal(h.seeks.length, 1);
  h.tick(30, 1); assert.equal(h.seeks.length, 2);
  assert.equal(h.video.loads, 0); assert.equal(h.video.paused, false);
});

test('each foreground return can recover frozen blob frames without spending network budget', () => {
  const h = harness({ frames: true, buffer: [[0, 90]] });
  for (let i = 0; i < 3; i++) {
    h.hidden(true); h.tick(2, 1);
    const count = h.seeks.length;
    h.hidden(false); h.tick(2, 1);
    assert.equal(h.seeks.length, count + 1);
    assert.equal(h.video.paused, false);
  }
  assert.equal(h.video.loads, 0); assert.equal(h.recovery.state().attempts, 0);
});

test('healthy foreground frames do not seek and clear previous frame recovery budget', () => {
  const h = harness({ frames: true, buffer: [[0, 90]] });
  h.tick(4, 1); assert.equal(h.recovery.state().frames.attempts, 1);
  for (let i = 0; i < 3; i++) { h.tick(1, 1); h.frame(); }
  assert.equal(h.recovery.state().frames.attempts, 0);
  h.hidden(true); h.tick(3, 1); h.hidden(false);
  for (let i = 0; i < 10; i++) { h.tick(1, 1); h.frame(); }
  assert.equal(h.seeks.length, 1);
});

test('returning while paused never resumes or seeks; destroy removes visibility listener', () => {
  const h = harness({ frames: true, buffer: [[0, 90]] });
  h.video.paused = true; h.hidden(true); h.tick(3); h.hidden(false); h.tick(5);
  assert.equal(h.seeks.length, 0); assert.equal(h.video.plays, 0);
  h.recovery.destroy(); h.hidden(true); h.hidden(false);
  assert.equal(h.callbacks.size, 0);
});

test('frame recovery does not seek outside buffer or reload an unbuffered stream', () => {
  const h = harness({ frames: true }); h.tick(30, 1);
  assert.equal(h.seeks.length, 0); assert.equal(h.video.loads, 0);
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


test('hidden watchdog baselines do not fabricate frame or progress observations', () => {
  const h = harness({ frames: true });
  h.tick(1, 1); h.frame();
  h.hidden(true); h.tick(10);
  const state = h.recovery.state();
  assert.equal(state.progressIdleMs, 10000);
  assert.equal(state.frames.lastFrameAgoMs, 10000);
  assert.equal(state.frames.monitoring, false);
  assert.equal(state.recoveryIdleMs, 0);
});

test('no received frames are reported as unknown, including after a source change', () => {
  const h = harness({ frames: true }); h.tick(1, 1);
  assert.equal(h.recovery.state().frames.lastFrameAgoMs, null);
  h.frame(); h.video.currentSrc = 'blob:next'; h.tick(1);
  assert.equal(h.recovery.state().frames.lastFrameAgoMs, null);
  assert.equal(h.recovery.state().progressIdleMs, null);
});

test('backward seek accepts new frames and clears frame recovery budget', () => {
  const h = harness({ frames: true, buffer: [[0, 90]] });
  h.tick(4, 1); h.frame();
  assert.equal(h.recovery.state().frames.attempts, 1);
  h.video.seeking = true; h.video.emit('seeking');
  h.video.currentTime = 2;
  h.video.seeking = false; h.video.emit('seeked');
  const seeks = h.seeks.length;
  for (let i = 0; i < 3; i++) { h.tick(1, 1); h.frame(); }
  assert.equal(h.recovery.state().frames.attempts, 0);
  assert.equal(h.seeks.length, seeks);
});

test('stalled events alone do not trigger recovery while playback advances', () => {
  const h = harness({ buffer: [[0, 90]] });
  for (let i = 0; i < 30; i++) { h.video.emit('stalled'); h.tick(1, 1); }
  assert.equal(h.seeks.length, 0); assert.equal(h.video.loads, 0);
  const event = h.recovery.state().history.at(-1);
  assert.equal(event.realHidden, false);
  assert.equal(event.playbackRate, 1.5);
  assert.ok(event.bufferAhead > 0);
});
