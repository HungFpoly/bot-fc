const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BotScheduler } = require('../bot-scheduler');

function setup(count = 10) {
  const started = [];
  const workers = new Map(Array.from({ length: count }, (_, id) => [id, {
    id, running: false, _pendingSpins: 0,
    async start() { this.running = true; started.push(id); return true; },
    stop() { this.running = false; this.queued = false; },
  }]));
  const scheduler = new BotScheduler(workers);
  scheduler.configure({ queueEnabled: true, maxConcurrent: 3 });
  return { workers, scheduler, started };
}

test('ten accounts fill three slots, replace finished accounts FIFO, and finish once', async () => {
  const { workers, scheduler, started } = setup();
  for (const worker of workers.values()) await scheduler.enqueue(worker);
  assert.deepEqual(started, [0, 1, 2]);
  workers.get(1).stop();
  await scheduler.pump();
  assert.deepEqual(started, [0, 1, 2, 3]);
  while ([...workers.values()].some(w => w.running)) {
    [...workers.values()].find(w => w.running).stop();
    await scheduler.pump();
    assert.ok([...workers.values()].filter(w => w.running).length <= 3);
  }
  assert.deepEqual(started, Array.from({ length: 10 }, (_, i) => i));
});

test('pending responses hold a slot; stop-all cancels waiting accounts', async () => {
  const { workers, scheduler, started } = setup();
  for (const worker of workers.values()) await scheduler.enqueue(worker);
  workers.get(0)._pendingSpins = 1;
  workers.get(0).stop();
  await scheduler.pump();
  assert.equal(started.length, 3);
  workers.get(0)._pendingSpins = 0;
  await scheduler.pump();
  assert.equal(started.length, 4);
  for (const worker of workers.values()) worker.stop();
  await scheduler.pump();
  assert.equal(started.length, 4);
});

test('parallel enqueue cannot exceed capacity during asynchronous startup', async () => {
  const { workers, scheduler, started } = setup();
  let release;
  workers.get(0).start = async function () {
    this.starting = true;
    await new Promise(resolve => { release = resolve; });
    this.starting = false;
    this.running = true;
    started.push(0);
  };
  const pending = scheduler.enqueue(workers.get(0));
  for (const worker of [...workers.values()].slice(1)) await scheduler.enqueue(worker);
  release();
  await pending;
  assert.deepEqual(started, [0, 1, 2]);
});

test('spin dispatch spacing is global and does not wait for network responses', async () => {
  const scheduler = new BotScheduler(new Map());
  scheduler.configure({ spinGap: 25 });
  const times = [];
  let release;
  const first = scheduler.dispatch(() => true, () => {
    times.push(performance.now());
    return new Promise(resolve => { release = resolve; });
  });
  await scheduler.dispatch(() => true, () => { times.push(performance.now()); return 'second'; });
  assert.ok(times[1] - times[0] >= 24);
  release('first');
  assert.equal(await first, 'first');
  let sent = false;
  assert.equal(await scheduler.dispatch(() => false, () => { sent = true; }), null);
  assert.equal(sent, false);
});

test('invalid settings and changes to active concurrency are rejected', async () => {
  const { workers, scheduler } = setup();
  assert.throws(() => scheduler.configure({ maxConcurrent: 0 }));
  assert.throws(() => scheduler.configure({ spinGap: -1 }));
  await scheduler.enqueue(workers.get(0));
  assert.throws(() => scheduler.configure({ maxConcurrent: 1 }));
  scheduler.configure({ spinGap: 200 });
  assert.equal(scheduler.config.spinGap, 200);
});
