const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

test('zero FC releases the bot even while it is waiting for another turn', async () => {
  const { BotWorker } = load('bot-worker.js', {
    './event-config': selectConfig('vqtg'),
    './jackpot-monitor': { jackpotMonitor: { getJackpot: () => 15000 } },
  });
  const bot = new BotWorker('empty', '', 'empty');
  bot.running = true;
  bot._loopId = 1;
  bot.lastKnownFc = 0;
  bot.waitingNextTurn = true;
  await bot._runLoop(1);
  assert.equal(bot.running, false);
});

for (const failure of ['http400', 'http500', 'network', 'invalid-json', 'server-error']) {
  test(`paid spin ${failure}: only one request, no automatic retry`, async () => {
    let calls = 0;
    const { BotWorker } = load('bot-worker.js', {
      './event-config': selectConfig('vqtg'),
      './jackpot-monitor': { jackpotMonitor: { getJackpot: () => 15000 } },
      globals: { fetch: async () => {
        calls++;
        if (failure === 'network') throw new Error('connection lost');
        if (failure.startsWith('http')) return { ok: false, status: Number(failure.slice(4)), text: async () => '' };
        return { ok: true, json: async () => {
          if (failure === 'invalid-json') throw new Error('invalid JSON');
          return { status: 'error', message: 'unknown failure' };
        } };
      } },
    });
    const bot = new BotWorker(1, '', 'test');
    bot.running = true;
    bot._loopId = 1;
    bot._sleep = async () => {};
    await bot._runLoop(1);
    assert.equal(calls, 1);
    assert.equal(bot.running, false);
    assert.equal(bot._pendingSpins, 0);
  });
}

test('pending sequential spin blocks duplicate dispatch and restart after stop', async () => {
  let calls = 0, finish;
  const { BotWorker } = load('bot-worker.js', {
    './event-config': selectConfig('vqtg'),
    './jackpot-monitor': { jackpotMonitor: { getJackpot: () => 15000 } },
    globals: { fetch: () => { calls++; return new Promise(resolve => { finish = resolve; }); } },
  });
  const bot = new BotWorker(1, '', 'test');
  bot.running = true;
  const pending = bot._fireSpinApi();
  assert.equal(await bot._fireSpinApi(), false);
  bot.stop();
  assert.equal(await bot.start(), false);
  assert.equal(calls, 1);
  finish({ ok: false, status: 500, text: async () => '' });
  await pending;
  assert.equal(bot._pendingSpins, 0);
});

test('config edits preserve paid turn and duplicate accounts cannot start together', async () => {
  const { BotWorker } = load('bot-worker.js', {
    './event-config': selectConfig('vqtg'),
    './jackpot-monitor': { jackpotMonitor: {} },
  });
  const bots = [1, 2].map(id => {
    const bot = new BotWorker(id, `sessionid=${id}`, 'test');
    bot._fetchAccountData = async () => {
      bot.accountUid = 'same-account';
      bot.firstSpinChecked = bot.firstSpinCompleted = true;
    };
    bot._fetchBalance = async () => {};
    bot._startBalancePoller = () => {};
    bot._runLoop = () => {};
    return bot;
  });
  const results = await Promise.all(bots.map(bot => bot.start()));
  assert.deepEqual(results, [true, false]);
  bots[0].turnSpins = 5;
  bots[0].waitingNextTurn = true;
  bots[0].applyConfig({ baseInterval: 300 });
  assert.equal(bots[0].turnSpins, 5);
  assert.equal(bots[0].waitingNextTurn, true);
  bots[0].stop();
  assert.equal(await bots[1].start(), true);
  bots[1].stop();
});

function load(file, dependencies = {}, source) {
  const context = {
    module: { exports: {} }, Buffer, URL, URLSearchParams,
    console: { log() {} },
    require: name => {
      if (name === './event-profiles') return require('../event-profiles');
      if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    ...dependencies.globals,
  };
  vm.runInNewContext(source ?? fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context);
  return context.module.exports;
}

for (const host of ["bilac", "vqsc"]) {
 for (const wrapped of [false, true]) {
  test(`${host}: ${wrapped ? "payload" : "direct"} response selects requests and login redirect`, async () => {
    const origin = `https://${host}.fconline.garena.vn`;
    const source = fs.readFileSync(path.join(__dirname, "..", "event-config.js"), "utf8")
      .replace(/^const BASE_URL = "https:\/\/[^\"]+";/m, `const BASE_URL = "${origin}";`);
    const config = load("event-config.js", {}, source);
    const bilac = host === "bilac";
    assert.equal(config.SESSION_COOKIE, bilac ? "sessionid" : "ff_session");
    const login = new URL(config.SSO_LOGIN_URL);
    assert.equal(login.searchParams.get("redirect_uri"), `${origin}/connect/garena/callback`);
    const state = Buffer.from(login.searchParams.get("state"), "base64");
    assert.equal(state[9], Buffer.byteLength(`${origin}/`));
    assert.equal(state.subarray(10).toString(), `${origin}/`);

    let data = bilac
      ? { user: { nickname: "Test", fc: 13054 }, socket_account_id: "123", jackpot_value: 2929 }
      : { user: { name: "Test", fc: 13054 }, socketUid: "456", socketUrl: "https://example.test", jackpot_value: 2929 };
    const calls = [];
    const fetch = async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => wrapped ? { payload: data } : data };
    };
    const { jackpotMonitor: monitor } = load("jackpot-monitor.js", {
      "./event-config": config, ws: class {}, globals: { fetch },
    });
    const { BotWorker } = load("bot-worker.js", {
      "./event-config": config, "./jackpot-monitor": { jackpotMonitor: monitor }, globals: { fetch },
    });
    const bot = new BotWorker(1, "", "Test");
    await bot._fetchAccountData();
    assert.equal(bot.accountName, "Test");
    assert.equal(bot.lastKnownFc, 13054);
    assert.equal(calls.at(-1).url, origin + (bilac ? "/api/user/get" : "/api/app/me"));
    monitor._fetchWithCookieFallback = fetch;
    await monitor._fetchSocketInfo();
    assert.equal(monitor.socketUid, bilac ? "123" : "456");
    assert.equal(monitor.socketUrl, bilac ? "wss://sock.bis.fconline.garena.vn" : "https://example.test");
    assert.equal(monitor.getJackpot(), 2929);
    monitor._handleMessage('42["message",{"content":{"env":"live","type":"jackpot_value","value":3759}}]');
    assert.equal(monitor.getJackpot(), 3759);
    data = bilac ? { user: { fc: 0 } } : { fc: 0 };
    await bot._fetchBalance();
    assert.equal(bot.lastKnownFc, 0);
    assert.equal(calls.at(-1).options.method, bilac ? "GET" : "POST");
    assert.equal(calls.at(-1).url, origin + (bilac ? "/api/user/get" : "/api/app/me/get_balance"));
    data = bilac
      ? { user: { fc: 13034, accumulation: 59 }, spin_results: [{ reward_name: "12,000,000 BP" }], jackpot_value: 3759 }
      : { fc: 13034, userRewards: [{ name: "12,000,000 BP" }], userExtension: { accumulatedPoint: 59 } };
    bot.running = true;
    assert.equal(await bot._fireSpinApi(), true);
    assert.equal(bot.lastKnownFc, 13034);
    assert.equal(bot.totalSpins, 1);
    assert.equal(calls.at(-1).url, origin + (bilac ? "/api/user/spin" : "/api/app/reward/spin"));
    assert.deepEqual(JSON.parse(calls.at(-1).options.body), bilac
      ? { spin_type: 2, payment_type: 1 }
      : { spinConfId: 5, paymentType: "fc", spinNum: 10, isFree: "inactive" });
    assert.equal(config.event.jackpotPath, bilac ? "/api/user/get" : "/api/app/me/get_jackpot_infos");
  });
 }
}

function selectConfig(host) {
  const origin = `https://${host}.fconline.garena.vn`;
  const source = fs.readFileSync(path.join(__dirname, "..", "event-config.js"), "utf8")
    .replace(/^const BASE_URL = "https:\/\/[^\"]+";/m, `const BASE_URL = "${origin}";`);
  return load("event-config.js", {}, source);
}

for (const valid of [true, false]) {
  test(`typhu auto-spin ${valid ? 'updates results' : 'stops on missing status'}`, async () => {
    const config = selectConfig('typhu');
    const { jackpotMonitor } = load('jackpot-monitor.js', {
      './event-config': config, ws: class {},
    });
    let requests = 0;
    const { BotWorker } = load('bot-worker.js', {
      './event-config': config, './jackpot-monitor': { jackpotMonitor },
      globals: { fetch: async (url, options) => {
        requests++;
        assert.equal(url, 'https://typhu.fconline.garena.vn/api/user/spin');
        assert.deepEqual(JSON.parse(options.body), { spin_type: 2, payment_type: 1 });
        assert.equal(options.headers['x-csrftoken'], 'test-csrf');
        return { ok: true, json: async () => ({
          ...(valid ? { status: 'successful' } : {}),
          payload: { user: { fc: 2026 }, jackpot_value: 7314,
            spin_results: [{ reward_name: '17,000,000 BP' }] },
        }) };
      } },
    });
    const bot = new BotWorker(1, 'sessionid=test; csrftoken=test-csrf', 'test');
    bot.running = true;
    assert.equal(await bot._fireSpinApi(), valid);
    assert.equal(requests, 1);
    assert.equal(bot.totalSpins, valid ? 1 : 0);
    if (valid) {
      assert.equal(bot.lastKnownFc, 2026);
      assert.equal(jackpotMonitor.getJackpot(), 7314);
      assert.match(bot.lastRewards[0].items, /17,000,000 BP/);
    } else {
      assert.equal(bot.running, false);
      assert.equal(bot.lastKnownFc, null);
    }
    bot.stop();
  });
}

for (const [rewardName, shouldStop] of [
  ['Giải đặc biệt FC/MC: 1.180 FC', false],
  ['Mini Jackpot: 1.180 FC', false],
  ['Grand Jackpot: 11.580 FC', true],
]) {
  test(`typhu reward ${rewardName}: stop=${shouldStop}`, async () => {
    const { BotWorker } = load('bot-worker.js', {
      './event-config': selectConfig('typhu'),
      './jackpot-monitor': { jackpotMonitor: {
        getJackpot: () => 10830, getMiniJackpot: () => 0,
        updateFromSpin: () => {},
      } },
      globals: { fetch: async () => ({ ok: true, json: async () => ({
        status: 'successful',
        payload: {
          user: { fc: 6422, accumulation: 900 }, jackpot_value: 10830,
          spin_results: [{ reward_name: rewardName, dice_result: 2,
            step_type: 2, extra_value: 1180, accumulation_point: 2,
            spin_result_reward_id: 2 }],
        },
      }) }) },
    });
    const bot = new BotWorker(1, '', 'test');
    bot.running = true;
    assert.equal(await bot._fireSpinApi(), true);
    assert.equal(bot.running, !shouldStop);
    assert.equal(bot.lastKnownFc, 6422);
    assert.equal(bot.totalSpins, 1);
    bot.stop();
  });
}

test('typhu socket uses account ID and parses grand/mini winners without duplicate notifications', async () => {
  const config = selectConfig('typhu');
  let connection;
  class Socket {
    constructor(url, options) { connection = { url, options }; }
    on() {}
  }
  const { jackpotMonitor: monitor } = load('jackpot-monitor.js', {
    './event-config': config, ws: Socket,
  });
  monitor._fetchWithCookieFallback = async () => ({ ok: true, json: async () => ({
    status: 'successful', payload: { socket_account_id: '1744125852', jackpot_value: 7314 },
  }) });
  await monitor._fetchSocketInfo();
  monitor._connectWebSocket();
  assert.equal(connection.url, 'wss://sock.bis.fo4.garena.vn/io/?account_id=1744125852&EIO=4&transport=websocket');
  assert.equal(connection.options.headers.Origin, 'https://typhu.fconline.garena.vn');
  const grand = [], mini = [];
  monitor.onOwnJackpot = win => grand.push(win);
  monitor.onMiniJackpot = win => mini.push(win);
  const packets = [
    '42["message",{"content":{"env":"live","type":"mini_jackpot","value":"1.005 FC","nickname":"Phù đạo tổ sư"}}]',
    '42["message",{"content":{"env":"live","type":"jackpot","value":"14.461 FC","nickname":"xbzu93311"}}]',
  ];
  for (const packet of packets) {
    monitor._handleMessage(packet);
    monitor._handleMessage(packet);
  }
  assert.equal(grand.length, 1);
  assert.equal(grand[0].nickname, 'xbzu93311');
  assert.equal(grand[0].parsedValue, 14461);
  assert.equal(mini.length, 1);
  assert.equal(mini[0].nickname, 'Phù đạo tổ sư');
  assert.equal(mini[0].parsedValue, 1005);
  assert.equal(monitor.getJackpot(), 7314);
});

for (const host of ['typhu', 'bilac']) {
test(`${host} first spin updates balance/rewards and stays locked after reload`, async () => {
  const config = selectConfig(host);
  const calls = [];
  let user = { nickname: 'Test', fc: 2036, price_type: 'first_pay', all_spins: 0 };
  if (host === 'bilac') delete user.all_spins;
  const { BotWorker } = load('bot-worker.js', {
    './event-config': config,
    './jackpot-monitor': { jackpotMonitor: { getJackpot: () => 7314, getMiniJackpot: () => 0 } },
    globals: { fetch: async (url, options) => {
      calls.push({ url, options });
      if (options.method === 'POST') {
        user = { ...user, fc: 2026, price_type: 'normal', all_spins: 1 };
        if (host === 'bilac') delete user.all_spins;
        return { ok: true, json: async () => ({ status: 'successful', payload: {
          user, spin_results: [{ reward_name: '17,000,000 BP' }], jackpot_value: 7314,
        } }) };
      }
      return { ok: true, json: async () => ({ status: 'successful', payload: { user } }) };
    } },
  });
  const bot = new BotWorker(1, '', 'test');
  assert.equal((await bot.spinFirstTime()).success, true);
  assert.equal(calls[1].url, `https://${host}.fconline.garena.vn/api/user/spin`);
  assert.deepEqual(JSON.parse(calls[1].options.body), { spin_type: 1, payment_type: 1 });
  assert.equal(bot.lastKnownFc, 2026);
  assert.equal(bot.lastRewards[0].items, '17,000,000 BP');
  assert.equal((await bot.spinFirstTime()).success, false);
  const reloaded = new BotWorker(2, '', 'reload');
  assert.equal((await reloaded.spinFirstTime()).success, false);
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  assert.equal(config.event.spinPath, '/api/user/spin');
  assert.deepEqual(JSON.parse(JSON.stringify(config.event.spinPayload({ SPIN_TYPE: 2 }))), { spin_type: 2, payment_type: 1 });
  user = { fc: 2026 };
  const unknown = new BotWorker(3, '', 'unknown');
  assert.equal((await unknown.spinFirstTime()).success, false);
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
});
}

test("vqtg get response reads account, balance and jackpot without enabling spin", async () => {
  const origin = "https://vqtg.fconline.garena.vn";
  const source = fs.readFileSync(path.join(__dirname, "..", "event-config.js"), "utf8")
    .replace(/^const BASE_URL = "https:\/\/[^\"]+";/m, `const BASE_URL = "${origin}";`);
  const config = load("event-config.js", {}, source);
  assert.equal(config.event.name, "Vòng Quanh Thế Giới");
  const data = {
    user: { nickname: "Test", account_name: "Winner", uid: "607850690", fc: 1836 },
    user_status: { first_spin: 0, paid_spin_count: 11 },
    current_jackpot_prize: 3134,
    socket_account_id: 123,
  };
  assert.equal(config.event.spinPath, "/api/reward/spin");
  assert.equal(config.event.rewardInfosPath, "/api/reward/get-infos");
  assert.equal(config.event.balance(data), 1836);
  assert.equal(config.event.jackpot(data), 3134);
  assert.deepEqual(JSON.parse(JSON.stringify(config.event.jackpotBillboard({
    last_jackpot_infos: { account_name: "Winner", jackpot_prize: 12759 },
  }))), { nickname: "Winner", value: "12759 FC" });
  assert.equal(config.event.socketId(data), 123);
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => data };
  };
  const { jackpotMonitor: monitor } = load("jackpot-monitor.js", {
    "./event-config": config, ws: class {}, globals: { fetch },
  });
  monitor._fetchWithCookieFallback = fetch;
  await monitor._fetchSocketInfo();
  assert.equal(monitor.getJackpot(), 3134);
  assert.equal(monitor.socketUid, 123);
  assert.equal(monitor.socketUrl, "wss://sock.bis.fo4.garena.vn");
  monitor._handleMessage('42["message",{"content":{"type":"prize_change","data":{"jackpot_prize":5573},"env":"live"}}]');
  assert.equal(monitor.getJackpot(), 5573);
  const wins = [], busts = [];
  monitor.onOwnJackpot = win => wins.push(win);
  monitor.onJackpotBust = bust => busts.push(bust);
  const winPacket = '42["message",{"content":{"type":"jackpot","data":{"uid":"607850690","account_name":"Winner","jackpot_prize":12763,"payment_type":1},"env":"live"}}]';
  monitor._handleMessage(winPacket);
  monitor._handleMessage(winPacket);
  assert.equal(wins.length, 1);
  assert.equal(wins[0].nickname, "Winner");
  assert.equal(wins[0].uid, "607850690");
  assert.equal(wins[0].parsedValue, 12763);
  monitor._handleMessage('42["message",{"content":{"type":"prize_change","data":{"jackpot_prize":100},"env":"live"}}]');
  assert.equal(busts.length, 1);
  assert.equal(busts[0].winner, "Winner");
  const { BotWorker } = load("bot-worker.js", {
    "./event-config": config, "./jackpot-monitor": { jackpotMonitor: monitor }, globals: { fetch },
  });
  const bot = new BotWorker(1, "", "Test");
  await bot._fetchAccountData();
  await bot._fetchBalance();
  assert.equal(bot.accountName, "Winner");
  assert.equal(bot.matchesJackpotWinner({ nickname: "Winner" }), true);
  assert.equal(bot.matchesJackpotWinner({ uid: "607850690" }), true);
  assert.equal(bot.matchesJackpotWinner({ nickname: "Someone else", uid: "999" }), false);
  assert.equal(bot.lastKnownFc, 1836);
  assert.equal(bot.getStatus().firstSpinCompleted, true);
  assert.equal(calls.length, 3);
  assert.equal(calls.at(-1).url, `${origin}/api/user/get`);
});

test("socket disconnect clears the jackpot until a new value arrives", () => {
  const origin = "https://vqtg.fconline.garena.vn";
  const source = fs.readFileSync(path.join(__dirname, "..", "event-config.js"), "utf8")
    .replace(/^const BASE_URL = "https:\/\/[^\"]+";/m, `const BASE_URL = "${origin}";`);
  const config = load("event-config.js", {}, source);
  class FakeSocket {
    constructor(url) { this.url = url; this.handlers = {}; }
    on(name, handler) { this.handlers[name] = handler; }
  }
  const { jackpotMonitor: monitor } = load("jackpot-monitor.js", {
    "./event-config": config, ws: FakeSocket,
  });
  monitor.socketUid = 123;
  monitor.socketUrl = config.event.socketUrl();
  monitor.jackpot = 5573;
  monitor._connectWebSocket();
  const url = new URL(monitor.ws.url);
  assert.equal(url.hostname, "sock.bis.fo4.garena.vn");
  assert.equal(url.pathname, "/io/");
  assert.equal(url.searchParams.get("account_id"), "123");
  assert.equal(url.searchParams.get("EIO"), "4");
  monitor.ws.handlers.close(1006, "lost connection");
  assert.equal(monitor.getJackpot(), 0);
});

test("bilac's existing jackpot socket format still reports the winner", () => {
  const config = selectConfig("bilac");
  const { jackpotMonitor: monitor } = load("jackpot-monitor.js", {
    "./event-config": config, ws: class {},
  });
  let winner;
  monitor.onOwnJackpot = event => { winner = event; };
  monitor._handleMessage('42["message",{"content":{"env":"live","type":"jackpot","value":"17.698 FC","nickname":"OldWinner"}}]');
  assert.equal(winner.nickname, "OldWinner");
  assert.equal(winner.parsedValue, 17698);
});

test('bilac API fallback identifies the winner and deduplicates a later socket event', async () => {
  const config = selectConfig('bilac');
  const fetch = async () => ({ ok: true, json: async () => ({ payload: {
    jackpot_billboard: { nickname: 'Winner', value: '17.698 FC' },
  } }) });
  const { jackpotMonitor: monitor } = load('jackpot-monitor.js', {
    './event-config': config, ws: class {},
    globals: { fetch, setTimeout: callback => callback() },
  });
  monitor._fetchWithCookieFallback = fetch;
  const wins = [];
  monitor.onOwnJackpot = win => wins.push(win);
  await monitor._fetchJackpotWinner(17698, 100);
  assert.equal(wins.length, 1);
  assert.equal(wins[0].nickname, 'Winner');
  assert.equal(wins[0].parsedValue, 17698);
  monitor._handleMessage('42["message",{"content":{"type":"jackpot","nickname":"Winner","value":"17.698 FC"}}]');
  assert.equal(wins.length, 1);
});

test('bilac mini socket routes an account alias to notification without stopping; grand stops', () => {
  const config = selectConfig('bilac');
  const { jackpotMonitor: monitor } = load('jackpot-monitor.js', {
    './event-config': config, ws: class {},
  });
  const { BotWorker } = load('bot-worker.js', {
    './event-config': config, './jackpot-monitor': { jackpotMonitor: monitor },
  });
  const bot = new BotWorker('test', '', 'Account');
  bot.accountName = 'LoginName';
  bot.accountGameName = 'GameName';
  bot.running = true;
  bot._log = () => {};
  let stops = 0;
  bot.stop = () => { stops++; bot.running = false; };
  const messages = [];
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  vm.runInNewContext(source.slice(source.indexOf('jackpotMonitor.onOwnJackpot ='), source.indexOf('setBroadcast(broadcast);')), {
    jackpotMonitor: monitor, workers: new Map([['test', bot]]),
    console: { log() {} }, broadcast: (type, data) => messages.push({ type, data }),
  });
  const mini = '42["message",{"content":{"type":"mini_jackpot","nickname":"GameName","value":"1.348 FC"}}]';
  monitor._handleMessage(mini);
  monitor._handleMessage(mini);
  assert.equal(messages.filter(m => m.type === 'jackpot_win').length, 1);
  assert.equal(messages.find(m => m.type === 'jackpot_win').data.type, 'mini');
  assert.equal(stops, 0);
  monitor._handleMessage('42["message",{"content":{"type":"jackpot","nickname":"GameName","value":"17.698 FC"}}]');
  assert.equal(stops, 1);
  assert.equal(bot.jackpotWins, 1);
  assert.equal(messages.filter(m => m.type === 'jackpot_win').length, 2);
  assert.equal(messages.filter(m => m.type === 'jackpot_win')[1].data.prize, '17.698 FC');
});

test("vqtg does not announce the same jackpot from socket and API fallback twice", async () => {
  const config = selectConfig("vqtg");
  const fetch = async () => ({ ok: true, json: async () => ({
    last_jackpot_infos: { account_name: "Winner", jackpot_prize: 13809 },
  }) });
  const { jackpotMonitor: monitor } = load("jackpot-monitor.js", {
    "./event-config": config, ws: class {}, globals: { fetch, setTimeout: callback => callback() },
  });
  monitor.cookie = "sessionid=fake";
  monitor._fetchWithCookieFallback = fetch;
  const wins = [], busts = [];
  monitor.onOwnJackpot = event => wins.push(event);
  monitor.onJackpotBust = event => busts.push(event);
  monitor.jackpot = 16000;
  const packet = '42["message",{"content":{"type":"jackpot","data":{"uid":"123","account_name":"Winner","jackpot_prize":13809},"env":"live"}}]';
  monitor._handleMessage(packet);
  await monitor._fetchJackpotWinner(16000, 100);
  monitor._handleMessage(packet);
  monitor._setJackpot(100);
  assert.equal(wins.length, 1);
  assert.equal(busts.length, 1);
  assert.equal(busts[0].prize, "13.809 FC");
});

test("vqtg refuses auto-spin before the account's first paid spin", async () => {
  const origin = "https://vqtg.fconline.garena.vn";
  const source = fs.readFileSync(path.join(__dirname, "..", "event-config.js"), "utf8")
    .replace(/^const BASE_URL = "https:\/\/[^\"]+";/m, `const BASE_URL = "${origin}";`);
  const config = load("event-config.js", {}, source);
  const calls = [];
  const fetch = async url => {
    calls.push(url);
    return { ok: true, json: async () => ({
      user: { nickname: "Test", fc: 2000 },
      user_status: { first_spin: 1, paid_spin_count: 0 },
    }) };
  };
  const { BotWorker } = load("bot-worker.js", {
    "./event-config": config,
    "./jackpot-monitor": { jackpotMonitor: { getJackpot: () => 3134, getMiniJackpot: () => 0 } },
    globals: { fetch },
  });
  const bot = new BotWorker(1, "sessionid=fake", "Test");
  await bot.start();
  assert.equal(bot.running, false);
  assert.equal(bot.getStatus().canFirstSpin, true);
  assert.deepEqual(calls, [`${origin}/api/user/get`]);
});

test("vqtg start does not create two loops while account verification is pending", async () => {
  const origin = "https://vqtg.fconline.garena.vn";
  const source = fs.readFileSync(path.join(__dirname, "..", "event-config.js"), "utf8")
    .replace(/^const BASE_URL = "https:\/\/[^\"]+";/m, `const BASE_URL = "${origin}";`);
  const config = load("event-config.js", {}, source);
  let resolveAccount;
  const calls = [];
  const fetch = (url) => {
    calls.push(url);
    if (calls.length === 1) return new Promise(resolve => { resolveAccount = resolve; });
    return Promise.resolve({ ok: true, json: async () => ({ user: { fc: 2000 } }) });
  };
  const { BotWorker } = load("bot-worker.js", {
    "./event-config": config,
    "./jackpot-monitor": { jackpotMonitor: { getJackpot: () => 3134, getMiniJackpot: () => 0 } },
    globals: { fetch },
  });
  const bot = new BotWorker(1, "sessionid=fake", "Test");
  let loops = 0;
  bot._runLoop = () => { loops++; };
  bot._startBalancePoller = () => {};
  const first = bot.start();
  assert.equal(await bot.start(), false);
  assert.equal(calls.length, 1);
  resolveAccount({ ok: true, json: async () => ({
    user: { nickname: "Test", fc: 2000 },
    user_status: { first_spin: 0, paid_spin_count: 1 },
  }) });
  assert.equal(await first, true);
  assert.equal(loops, 1);
  assert.equal(calls.length, 2);
  bot.stop();
});

test("vqtg auto-spin updates jackpot, uses type 2 and displays only the latest reward", async () => {
  const origin = "https://vqtg.fconline.garena.vn";
  const source = fs.readFileSync(path.join(__dirname, "..", "event-config.js"), "utf8")
    .replace(/^const BASE_URL = "https:\/\/[^\"]+";/m, `const BASE_URL = "${origin}";`);
  const config = load("event-config.js", {}, source);
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({
      status: "successful",
      payload: {
        fc: 1836,
        current_jackpot_prize: 13356,
        user_status: { first_spin: 0, paid_spin_count: 11, last_reward_id: 44 },
        receive_reward_infos: [
          { reward_id: 23, item_name: "Old reward" },
          { reward_id: 44, item_name: "35,000,000 BP" },
        ],
      },
    }) };
  };
  const { jackpotMonitor } = load("jackpot-monitor.js", {
    "./event-config": config, ws: class {},
  });
  jackpotMonitor.updateFromSpin(9970);
  const { BotWorker } = load("bot-worker.js", {
    "./event-config": config,
    "./jackpot-monitor": { jackpotMonitor },
    globals: { fetch },
  });
  const bot = new BotWorker(1, "sessionid=fake", "Test");
  bot.running = true;
  assert.equal(await bot._fireSpinApi(), true);
  assert.equal(calls[0].url, `${origin}/api/reward/spin`);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    spin_type: 2, payment_type: 1, use_topup_deal: false, is_free: false,
  });
  assert.equal(bot.lastKnownFc, 1836);
  assert.equal(bot.totalSpins, 1);
  assert.equal(jackpotMonitor.getJackpot(), 13356);
  assert.match(bot.lastRewards[0].items, /35,000,000 BP/);
  assert.doesNotMatch(bot.lastRewards[0].items, /Old reward/);
});

test("vqtg stops after an unconfirmed paid-spin response instead of retrying", async () => {
  const origin = "https://vqtg.fconline.garena.vn";
  const source = fs.readFileSync(path.join(__dirname, "..", "event-config.js"), "utf8")
    .replace(/^const BASE_URL = "https:\/\/[^\"]+";/m, `const BASE_URL = "${origin}";`);
  const config = load("event-config.js", {}, source);
  let requests = 0;
  const fetch = async () => {
    requests++;
    return { ok: true, json: async () => ({ status: "successful", payload: {} }) };
  };
  const { BotWorker } = load("bot-worker.js", {
    "./event-config": config,
    "./jackpot-monitor": { jackpotMonitor: { getJackpot: () => 3134, getMiniJackpot: () => 0 } },
    globals: { fetch },
  });
  const bot = new BotWorker(1, "sessionid=fake", "Test");
  bot.running = true;
  assert.equal(await bot._fireSpinApi(), false);
  assert.equal(bot.running, false);
  assert.equal(bot.totalSpins, 0);
  assert.equal(requests, 1);
});

test("vqtg first-spin sends the supplied payload once and locks that bot", async () => {
  const origin = "https://vqtg.fconline.garena.vn";
  const source = fs.readFileSync(path.join(__dirname, "..", "event-config.js"), "utf8")
    .replace(/^const BASE_URL = "https:\/\/[^\"]+";/m, `const BASE_URL = "${origin}";`);
  const config = load("event-config.js", {}, source);
  let resolveSpin;
  const calls = [];
  const fetch = (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/api/reward/spin")) return new Promise(resolve => { resolveSpin = resolve; });
    return Promise.resolve({ ok: true, json: async () => ({
      user: { fc: 1800 }, user_status: { first_spin: 1, paid_spin_count: 0 },
    }) });
  };
  const { BotWorker } = load("bot-worker.js", {
    "./event-config": config,
    "./jackpot-monitor": { jackpotMonitor: { getJackpot: () => 0, getMiniJackpot: () => 0 } },
    globals: { fetch },
  });
  const bot = new BotWorker(1, "sessionid=fake", "Test");
  await bot._fetchAccountData();
  assert.equal(bot.getStatus().canFirstSpin, true);
  const first = bot.spinFirstTime();
  assert.equal(bot.getStatus().canFirstSpin, false);
  assert.equal((await bot.spinFirstTime()).success, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, `${origin}/api/reward/spin`);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    spin_type: 1, payment_type: 1, use_topup_deal: false, is_free: false,
  });
  resolveSpin({ ok: true, json: async () => ({
    status: "successful",
    payload: { fc: 2026, user_status: { first_spin: 0, paid_spin_count: 1 }, receive_reward_infos: [
      { reward_id: 53, item_name: "Xúc Xắc Chỉ Định" },
    ] },
  }) });
  assert.equal((await first).success, true);
  assert.equal(bot.getStatus().canFirstSpin, false);
  assert.equal(bot.getStatus().firstSpinCompleted, true);
  assert.equal(bot.totalSpins, 1);
  assert.equal(bot.lastKnownFc, 2026);
  assert.equal(bot.lastRewards[0].items, "Xúc Xắc Chỉ Định");
  assert.equal((await bot.spinFirstTime()).success, false);
  assert.equal(calls.filter(call => call.url.endsWith("/api/reward/spin")).length, 1);
});

for (const [burst, nextJackpot, expected] of [[true, 17000, 5], [false, 17000, 1], [true, 1000, 5]]) {
  test(`spin burst=${burst}, next jackpot=${nextJackpot}: ${expected} calls`, async () => {
    let jackpot = 15000;
    const { BotWorker } = load('bot-worker.js', {
      './jackpot-monitor': { jackpotMonitor: { getJackpot: () => jackpot, getLatestJackpotWin: () => null } },
      './event-config': { BASE_URL: '', event: {} },
    });
    const bot = new BotWorker('test', '', 'test', { minJackpot: 14000, maxJackpot: 16500, spinsPerTurn: 5, spinBurst: burst });
    bot.running = true;
    bot._loopId = 1;
    let calls = 0, sleeps = 0;
    bot._fireSpinApi = async () => { calls++; jackpot = nextJackpot; return true; };
    bot._sleep = async () => { if (++sleeps >= 8) bot.running = false; };
    await bot._runLoop(1);
    assert.equal(calls, expected);
    if (expected === 5 && nextJackpot === 17000) assert.equal(bot.waitingNextTurn, true);
  });
}

test('burst dispatches all requests before any response and does not retry failures', async () => {
  const { BotWorker } = load('bot-worker.js', {
    './jackpot-monitor': { jackpotMonitor: { getJackpot: () => 15000 } },
    './event-config': { BASE_URL: '', event: {} },
  });
  const bot = new BotWorker('test', '', 'test', { minJackpot: 14000, maxJackpot: 16500, spinsPerTurn: 5, baseInterval: 0, spinBurst: true });
  bot.running = true;
  bot._loopId = 1;
  const pending = [];
  bot._fireSpinApi = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
  bot._sleep = async () => { bot.running = false; };
  const loop = bot._runLoop(1);
  assert.equal(pending.length, 5);
  // The loop can finish while every response is still unresolved.
  await loop;
  pending[0].reject(new Error('network failure'));
  pending[1].resolve(false);
  for (const request of pending.slice(2)) request.resolve(true);
  await loop;
  assert.equal(pending.length, 5);
  assert.equal(bot.waitingNextTurn, true);
});

test('unchecked burst waits for each response before dispatching another request', async () => {
  const { BotWorker } = load('bot-worker.js', {
    './jackpot-monitor': { jackpotMonitor: { getJackpot: () => 15000 } },
    './event-config': { BASE_URL: '', event: {} },
  });
  const bot = new BotWorker('test', '', 'test', { minJackpot: 14000, maxJackpot: 16500, spinsPerTurn: 5, spinBurst: false });
  bot.running = true;
  bot._loopId = 1;
  let calls = 0, resolveResponse;
  bot._fireSpinApi = () => { calls++; return new Promise(resolve => { resolveResponse = resolve; }); };
  bot._sleep = async () => { bot.running = false; };
  const loop = bot._runLoop(1);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(bot.turnSpins, 0);
  resolveResponse(true);
  await loop;
  assert.equal(calls, 1);
  assert.equal(bot.turnSpins, 1);
});

test('real burst request builder sends identical URL, headers and body for all five calls', async () => {
  const config = selectConfig('bilac');
  const requests = [], responses = [];
  const { BotWorker } = load('bot-worker.js', {
    './event-config': config,
    './jackpot-monitor': { jackpotMonitor: { getJackpot: () => 15000 } },
    globals: { fetch: (url, options) => {
      requests.push(JSON.parse(JSON.stringify({ url, options })));
      return new Promise(resolve => responses.push(resolve));
    } },
  });
  const bot = new BotWorker('test', 'sessionid=fake; csrftoken=fake', 'test', {
    minJackpot: 14000, maxJackpot: 16500, spinBurst: true, spinsPerTurn: 5, baseInterval: 0,
  });
  bot.running = true;
  bot._loopId = 1;
  bot._sleep = async () => { bot.running = false; };
  const loop = bot._runLoop(1);
  assert.equal(requests.length, 5);
  for (const request of requests) assert.deepEqual(request, requests[0]);
  assert.equal(requests[0].url, 'https://bilac.fconline.garena.vn/api/user/spin');
  assert.deepEqual(JSON.parse(requests[0].options.body), { spin_type: 2, payment_type: 1 });
  responses[0]({ ok: true, status: 200, json: async () => ({ status: 'successful' }) });
  for (const resolve of responses.slice(1)) resolve({ ok: false, status: 500, text: async () => '<h1>Server Error (500)</h1>' });
  await loop;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bot.totalSpins, 1);
  assert.equal(requests.length, 5);
  assert.equal(bot.logs.filter(line => line.includes('HTTP 500')).length, 4);
});

for (const interval of [100, 200]) {
  test(`paced burst sends every ${interval}ms without waiting for responses`, async () => {
    const { BotWorker } = load('bot-worker.js', {
      './jackpot-monitor': { jackpotMonitor: { getJackpot: () => 15000 } },
      './event-config': { BASE_URL: '', event: {} },
    });
    const bot = new BotWorker('test', '', 'test', { minJackpot: 14000, maxJackpot: 16500, spinsPerTurn: 5, spinBurst: true, baseInterval: interval });
    bot.running = true;
    bot._loopId = 1;
    const responses = [], times = [], waits = [];
    let now = 0;
    bot._fireSpinApi = () => { times.push(now); return new Promise(resolve => responses.push(resolve)); };
    bot._sleep = ms => {
      if (responses.length === 5) { bot.running = false; return Promise.resolve(); }
      return new Promise(resolve => waits.push(() => { now += ms; resolve(); }));
    };
    const loop = bot._runLoop(1);
    assert.equal(responses.length, 1);
    for (let i = 1; i < 5; i++) {
      assert.equal(waits.length, 1);
      waits.shift()();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(responses.length, i + 1);
    }
    assert.deepEqual(times, [0, interval, interval * 2, interval * 3, interval * 4]);
    for (const resolve of responses) resolve(true);
    await loop;
    assert.equal(bot.turnSpins, 5);
  });
}
