const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TelegramNotifier, createTelegramNotifiers } = require('../telegram-notifier');

const win = { id: '1', label: 'Acc 1', accountName: 'player', type: 'grand', prize: '15000 FC', fc: 100 };

for (const separateChat of [false, true]) {
  test(`two bots notify independently with separate chat=${separateChat}`, async () => {
    const calls = [];
    const notifiers = createTelegramNotifiers({
      TELEGRAM_BOT_TOKEN: 'first', TELEGRAM_CHAT_ID: '123',
      TELEGRAM_BOT_TOKEN_2: 'second', TELEGRAM_CHAT_ID_2: separateChat ? '456' : '',
    }, { logger: { warn() {} }, fetchImpl: async (url, options) => {
      calls.push({ url, chat: JSON.parse(options.body).chat_id });
      if (url.includes('botfirst/')) throw new Error('first unavailable');
      return { ok: true, json: async () => ({ ok: true }) };
    } });
    assert.deepEqual(await Promise.all(notifiers.map(n => n.notify(win, 'Test'))), [false, true]);
    assert.deepEqual(calls.map(c => c.chat), ['123', separateChat ? '456' : '123']);
    assert.match(calls[1].url, /botsecond\/sendMessage$/);
    await Promise.all(notifiers.map(n => n.notify(win, 'Test')));
    assert.equal(calls.length, 2);
  });
}

test('unconfigured second bot sends nothing', async () => {
  let calls = 0;
  const notifiers = createTelegramNotifiers({ TELEGRAM_BOT_TOKEN: 'first', TELEGRAM_CHAT_ID: '123' }, {
    fetchImpl: async () => { calls++; return { ok: true, json: async () => ({ ok: true }) }; },
  });
  assert.deepEqual(await Promise.all(notifiers.map(n => n.notify(win, 'Test'))), [true, false]);
  assert.equal(calls, 1);
});

test('missing credentials disables notification', async () => {
  const notifier = new TelegramNotifier({ token: '', chatId: '', fetchImpl: () => assert.fail('network called') });
  assert.equal(await notifier.notify(win, 'Test'), false);
});

test('sends plain text with prize and account but never credentials or cookie', async () => {
  const notifier = new TelegramNotifier({ token: 'secret', chatId: '-123', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.telegram.org/botsecret/sendMessage');
    const payload = JSON.parse(options.body);
    assert.equal(payload.chat_id, '-123');
    assert.match(payload.text, /Acc 1 \(player\)/);
    assert.match(payload.text, /15000 FC/);
    assert.match(payload.text, /FC con lai: 100/);
    assert.doesNotMatch(payload.text, /secret|private-cookie/);
    assert.equal(payload.parse_mode, undefined);
    assert.ok(options.signal);
    return { ok: true, json: async () => ({ ok: true }) };
  } });
  assert.equal(await notifier.notify({ ...win, cookie: 'private-cookie' }, 'Test'), true);
});

test('deduplicates concurrent sources; other accounts/types and later wins still send', async () => {
  let calls = 0, now = 0;
  const notifier = new TelegramNotifier({ token: 'secret', chatId: '123', now: () => now,
    fetchImpl: async () => { calls++; return { ok: true, json: async () => ({ ok: true }) }; } });
  await Promise.all([notifier.notify(win, 'Test'), notifier.notify(win, 'Test')]);
  assert.equal(calls, 1);
  await notifier.notify({ ...win, type: 'mini' }, 'Test');
  await notifier.notify({ ...win, accountName: 'another' }, 'Test');
  assert.equal(calls, 3);
  now = 10000;
  await notifier.notify(win, 'Test');
  assert.equal(calls, 4);
});

for (const failure of ['network', 'invalid-json', 'api']) {
  test(`handles ${failure} failure without exposing token`, async () => {
    const warnings = [];
    const notifier = new TelegramNotifier({ token: 'secret', chatId: '123',
      logger: { warn: message => warnings.push(message) }, fetchImpl: async () => {
        if (failure === 'network') throw new Error('secret');
        return { ok: false, status: 401, json: async () => {
          if (failure === 'invalid-json') throw new Error('secret');
          return { ok: false, error_code: 401, description: 'secret' };
        } };
      } });
    assert.equal(await notifier.notify(win, 'Test'), false);
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(warnings[0], /secret/);
  });
}
