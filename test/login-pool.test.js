const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loginPool, closeLoginBrowser } = require('../login-pool');

test('free login slot advances without waiting for slow account, preserving order', async () => {
  let finishSlow;
  const started = [];
  const pending = loginPool(['slow', 'fast', 'next'].map(username => ({ username })), 2, async name => {
    started.push(name);
    if (name === 'slow') await new Promise(resolve => { finishSlow = resolve; });
    return { success: true };
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['slow', 'fast', 'next']);
  finishSlow();
  const results = await pending;
  assert.deepEqual(results.map(item => item.username), ['slow', 'fast', 'next']);
});

test('failed login does not block remaining accounts or next submission', async () => {
  const login = async name => { if (name === 'bad') throw new Error('Failed'); return { success: true }; };
  const results = await loginPool([{ username: 'bad' }, { acc: { username: 'ok' } }], 1, login);
  assert.equal(results[0].result.success, false);
  assert.equal(results[1].result.success, true);
  assert.equal((await loginPool([{ username: 'ok' }], 1, login))[0].result.success, true);
});

test('stalled browser close terminates only its owned process', async () => {
  let killed = 0;
  await closeLoginBrowser({ close: () => new Promise(() => {}),
    process: () => ({ exitCode: null, kill: () => killed++ }) }, 10);
  assert.equal(killed, 1);
});

test('normal browser close does not kill process', async () => {
  await closeLoginBrowser({ close: async () => {}, process: () => assert.fail('unexpected kill') }, 10);
});
