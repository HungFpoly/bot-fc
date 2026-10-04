const express = require("express");
const path = require("path");
if (!process.env.ELECTRON) require("dotenv").config();
const { BotWorker, setBroadcast } = require("./bot-worker");
const { jackpotMonitor } = require("./jackpot-monitor");
const { GarenaAuth } = require("./garena-auth");
const { event } = require("./event-config");
const { BotScheduler } = require("./bot-scheduler");
const { createTelegramNotifiers } = require('./telegram-notifier');
const telegramNotifiers = createTelegramNotifiers();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/event", (req, res) => {
  res.json({ name: event.name });
});

const workers = new Map();
const { JackpotRanges, validateRange } = require('./jackpot-range');
const jackpotRanges = new JackpotRanges({
  minJackpot: Number(process.env.MIN_JACKPOT) || 11870,
  maxJackpot: Number(process.env.MAX_JACKPOT) || 0,
});
const scheduler = new BotScheduler(workers);
let stopGeneration = 0;
setInterval(() => { void scheduler.pump(); }, 100);
app.get('/api/config', (req, res) => res.json({ ...scheduler.config, ...jackpotRanges.shared }));
app.use(['/api/bots/add', '/api/bots/add-bulk', '/api/login-and-run'], (req, res, next) => {
  if (req.method !== 'POST') return next();
  try { scheduler.configure(req.body.config); next(); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
jackpotMonitor.setCookieProvider((currentCookie) => {
  const active = [...workers.values()].filter(worker => worker.running && worker.cookie);
  const fallback = active.find(worker => worker.cookie !== currentCookie)
    || [...workers.values()].find(worker => worker.cookie && worker.cookie !== currentCookie);
  return fallback?.cookie || null;
});

// Config cấp API — chỉ đọc từ .env, KHÔNG nhận từ client / không hiện trên UI
// Event-specific payloads are defined in event-config.js.
function apiConfig() {
  return {
    spinNum:     parseInt(process.env.SPIN_NUM, 10) || 10,
    spinType:    parseInt(process.env.BILAC_SPIN_TYPE, 10) || 2,
    spinConfId:  parseInt(process.env.SPIN_CONF_ID, 10) || 5,
    paymentType: process.env.PAYMENT_TYPE || "fc",
  };
}

// Gộp config từ client với config API; client không ghi đè được config API
function resolveConfig(clientConfig = {}) {
  const { spinType, spinConfId, spinNum, paymentType, ...safe } = clientConfig || {};
  return { ...jackpotRanges.shared, ...safe, ...apiConfig() };
}

// SSE clients
const sseClients = new Set();

// Broadcast tất cả events xuống browser
function broadcast(type, data) {
  if (type === 'jackpot_win') {
    for (const notifier of telegramNotifiers) void notifier.notify(data, event.name);
  }
  const msg = `data: ${JSON.stringify({ type, data })}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch (_) {}
  }
}

// Wire up jackpot monitor và bot worker
jackpotMonitor.onJackpotChange = (value) => broadcast("jackpot", { value });
jackpotMonitor.onJackpotBust = ({ from, to, winner, prize, time }) => {
  const timeStr = time.toLocaleTimeString("vi-VN");
  console.log(`[Server] 💥 HŨ NỔ lúc ${timeStr}: ${from} → ${to} FC | 🏆 ${winner} (${prize})`);
  broadcast("bust", { from, to, winner, prize, time: timeStr });
};
jackpotMonitor.onOwnJackpot = ({ nickname, uid, prize, parsedValue }) => {
  // Khi có người nổ hũ, check tất cả bot xem có ai trùng nickname không
  console.log(`[Server] 🔍 Checking if ${nickname} matches any bot...`);
  for (const [, worker] of workers) {
    if (worker.matchesJackpotWinner({ nickname, uid }) && worker.running) {
      worker.jackpotWins++;
      console.log(`[Server] 🏆 Bot ${worker.label} (${nickname}) TRÚNG HŨ ${prize} → DỪNG BOT!`);
      worker._log(`🏆🏆🏆 BẠN ĂN HŨ ${prize}! BOT TẰM DỪNG! 🏆🏆🏆`);
      broadcast("jackpot_win", { ...worker.getStatus(), type: "grand", prize });
      worker.stop();
    }
  }
};
jackpotMonitor.onMiniJackpot = ({ nickname, prize, parsedValue, time }) => {
  const timeStr = time.toLocaleTimeString("vi-VN");
  console.log(`[Server] 🎊 MINI JACKPOT: ${nickname} (${prize})`);
  broadcast("mini_bust", { winner: nickname, prize, value: parsedValue, time: timeStr });

  // Mini Jackpot không dừng bot; chỉ thông báo nếu nickname trùng tài khoản đang chạy.
  for (const [, worker] of workers) {
    if (worker.matchesJackpotWinner({ nickname }) && worker.running) {
      worker._log(`🎊 BẠN TRÚNG MINI JACKPOT ${prize}! Bot tiếp tục chạy.`);
      broadcast("jackpot_win", { ...worker.getStatus(), type: "mini", prize });
    }
  }
};
setBroadcast(broadcast);

// Broadcast snapshot tất cả bots mỗi 5s để đảm bảo UI đồng bộ
setInterval(() => {
  if (sseClients.size === 0) return;
  const bots = [];
  for (const [, w] of workers) bots.push(w.getStatus());
  if (bots.length > 0) broadcast("snapshot", { bots });
}, 5000);

// SSE endpoint - browser connect vào đây để nhận real-time events
app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Gửi trạng thái hiện tại ngay khi connect
  const bots = [];
  for (const [, w] of workers) bots.push(w.getStatus());
  res.write(`data: ${JSON.stringify({ type: "init", data: { jackpot: jackpotMonitor.getJackpot(), miniJackpot: jackpotMonitor.getMiniJackpot(), bots } })}\n\n`);
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

// API: Lấy danh sách tất cả bot đang chạy
app.get("/api/bots", (req, res) => {
  const list = [];
  for (const [id, worker] of workers) {
    list.push(worker.getStatus());
  }
  res.json(list);
});

// API: Thêm và khởi chạy bot mới
app.post("/api/bots/add", async (req, res) => {
  const { cookie, label, config } = req.body;

  if (!cookie) {
    return res.status(400).json({ error: "Thiếu cookie" });
  }

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const worker = new BotWorker(id, cookie, label || `Acc #${workers.size + 1}`, resolveConfig(config));
  workers.set(id, worker);
  const started = await scheduler.enqueue(worker);

  // Khởi động JackpotMonitor nếu chưa chạy
  if (!jackpotMonitor.running) {
    jackpotMonitor.setCookie(cookie);
    jackpotMonitor.start();
  }

  res.json({ success: true, id, started, message: started
    ? `Bot ${label || id} đã khởi chạy`
    : `Bot ${label || id} đã thêm; cần hoàn tất lượt quay đầu trước khi chạy` });
});

// API: Thêm nhiều bot cùng lúc
app.post("/api/bots/add-bulk", async (req, res) => {
  const { accounts, config } = req.body;
  const generation = stopGeneration;

  if (!accounts || !Array.isArray(accounts) || accounts.length === 0) {
    return res.status(400).json({ error: "Thiếu danh sách accounts" });
  }

  const results = [];
  for (const [index, acc] of accounts.entries()) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + index;
    const label = acc.label || `Acc #${workers.size + 1}`;
    const worker = new BotWorker(id, acc.cookie, label, resolveConfig(config || acc.config));
    workers.set(id, worker);
    const started = generation === stopGeneration && await scheduler.enqueue(worker);
    results.push({ id, label, started });

    // Khởi động JackpotMonitor với cookie acc đầu tiên
    if (!jackpotMonitor.running) {
      jackpotMonitor.setCookie(acc.cookie);
      jackpotMonitor.start();
    }
  }

  res.json({ success: true, count: results.length, bots: results });
});

// API: Dừng một bot
app.post("/api/bots/:id/first-spin", async (req, res) => {
  const worker = workers.get(req.params.id);
  if (!worker) return res.status(404).json({ error: "Không tìm thấy bot" });
  const result = await worker.spinFirstTime();
  res.status(result.success ? 200 : 409).json(result);
});

app.post("/api/bots/:id/stop", (req, res) => {
  const worker = workers.get(req.params.id);
  if (!worker) return res.status(404).json({ error: "Không tìm thấy bot" });
  worker.stop();
  res.json({ success: true, message: `Bot ${worker.label} đã dừng` });
});

// API: Khởi động lại một bot
app.post("/api/bots/:id/start", async (req, res) => {
  const worker = workers.get(req.params.id);
  if (!worker) return res.status(404).json({ error: "Không tìm thấy bot" });
  const started = await scheduler.enqueue(worker);
  if (!started) return res.status(409).json({ success: false, error: worker.getStatus().lastLog });
  res.json({ success: true, message: `Bot ${worker.label} đã chạy lại` });
});

// API: Xóa một bot
app.delete("/api/bots/:id", (req, res) => {
  const worker = workers.get(req.params.id);
  if (!worker) return res.status(404).json({ error: "Không tìm thấy bot" });
  worker.stop();
  workers.delete(req.params.id);
  res.json({ success: true, message: `Bot ${worker.label} đã xóa` });
});

// API: Dừng tất cả
app.post('/api/bots/start-all', async (req, res) => {
  const generation = stopGeneration;
  for (const worker of workers.values()) {
    if (generation !== stopGeneration) break;
    await scheduler.enqueue(worker);
  }
  res.json({ success: true });
});

app.post("/api/bots/stop-all", (req, res) => {
  stopGeneration++;
  for (const [, worker] of workers) {
    worker.stop();
  }
  res.json({ success: true, message: "Đã dừng tất cả bot" });
});

// API: Cập nhật config chung
app.post('/api/bots/:id/jackpot-range', (req, res) => {
  const worker = workers.get(req.params.id);
  if (!worker) return res.status(404).json({ error: 'Không tìm thấy bot' });
  try { jackpotRanges.configureWorker(worker, req.body); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  broadcast('snapshot', { bots: [...workers.values()].map(bot => bot.getStatus()) });
  res.json({ success: true, bot: worker.getStatus() });
});

app.post("/api/config", (req, res) => {
  // SPIN_NUM / SPIN_CONF_ID / PAYMENT_TYPE là config cấp API lấy từ .env.
  const { minJackpot, maxJackpot, spinsPerTurn, baseInterval = 200, spinBurst } = req.body;
  if (spinsPerTurn !== undefined && (!Number.isInteger(spinsPerTurn) || spinsPerTurn < 1 || spinsPerTurn > 50)) return res.status(400).json({ error: "Số lần spam phải từ 1 đến 50" });
  if (spinBurst !== undefined && typeof spinBurst !== "boolean") return res.status(400).json({ error: "Spin liên tiếp không hợp lệ" });
  if (!Number.isInteger(baseInterval) || baseInterval < 0 || baseInterval > 60000) {
    return res.status(400).json({ error: "Thời gian gọi API phải từ 0 đến 60000 ms" });
  }
  const range = { ...jackpotRanges.shared };
  if (minJackpot !== undefined) range.minJackpot = minJackpot;
  if (maxJackpot !== undefined) range.maxJackpot = maxJackpot;
  try { validateRange(range); scheduler.configure(req.body); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  console.log(`[Server] Cập nhật config: min=${minJackpot}, max=${maxJackpot}, spins=${spinsPerTurn}, apiInterval=${baseInterval}ms`);

  jackpotRanges.updateShared(range, workers.values());
  for (const [, worker] of workers) {
    worker.applyConfig({ spinsPerTurn, baseInterval, spinBurst });
  }

  // Đẩy snapshot ngay để UI phản ánh config mới, không phải chờ 5s
  const bots = [];
  for (const [, w] of workers) bots.push(w.getStatus());
  broadcast("snapshot", { bots });

  res.json({
    success: true,
    updated: workers.size,
    message: workers.size > 0
      ? `Đã cập nhật config cho ${workers.size} bot`
      : "Chưa có bot nào đang chạy",
  });
});

// API: Lấy log của một bot
app.get("/api/bots/:id/logs", (req, res) => {
  const worker = workers.get(req.params.id);
  if (!worker) return res.status(404).json({ error: "Không tìm thấy bot" });
  res.json({ logs: worker.getLogs() });
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Thiếu username hoặc password" });
  }

  const result = await GarenaAuth.login(username, password);
  res.json(result);
});

// API: Đăng nhập nhiều acc và khởi chạy bot luôn (SONG SONG)
app.post("/api/login-and-run", async (req, res) => {
  const { accounts, config } = req.body;
  const generation = stopGeneration;

  if (!accounts || !Array.isArray(accounts) || accounts.length === 0) {
    return res.status(400).json({ error: "Thiếu danh sách accounts" });
  }

  console.log(`[Server] Đăng nhập ${accounts.length} acc theo batch ${LOGIN_BATCH_SIZE}...`);

  const items = accounts.map((acc, i) => ({
    index: i,
    label: acc.label || `Acc #${i + 1}`,
    username: acc.username,
    password: acc.password,
  }));

  const loginResults = await loginBatch(items);

  const results = [];
  for (const item of loginResults) {
    const { index, label, username, result: loginResult } = item;
    if (loginResult.success) {
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + index;
      const worker = new BotWorker(id, loginResult.cookie, label, resolveConfig(config));
      workers.set(id, worker);
      const started = generation === stopGeneration && await scheduler.enqueue(worker);

      if (!jackpotMonitor.running) {
        jackpotMonitor.setCookie(loginResult.cookie);
        jackpotMonitor.start();
      }

      results.push({ id, label, username, status: started ? "ok" : "ready" });
    } else {
      results.push({ label, username, status: "failed", error: loginResult.error });
    }
  }

  const okCount = results.filter(r => r.status === "ok").length;
  console.log(`[Server] ✅ Hoàn tất: ${okCount}/${accounts.length} acc đăng nhập thành công`);
  res.json({ success: true, total: accounts.length, started: okCount, results });
});

// Login theo batch để tránh mở quá nhiều Chrome cùng lúc
// BATCH_SIZE = số Chrome mở song song tối đa
const LOGIN_BATCH_SIZE = parseInt(process.env.LOGIN_BATCH_SIZE) || 3;

async function loginBatch(accounts) {
  const { loginPool } = require('./login-pool');
  return loginPool(accounts, LOGIN_BATCH_SIZE, (username, password) => GarenaAuth.login(username, password));
}
function stopAll() {
  stopGeneration++;
  for (const [, worker] of workers) {
    worker.stop();
  }
  jackpotMonitor.stop();
}

// Khởi động server
function startApp(onReady) {
  app.listen(PORT, () => {
    console.log(`\n🚀 TCSS Multi-Bot đang chạy tại: http://localhost:${PORT}\n`);
    if (onReady) onReady();
    autoLoginFromEnv();
  });
}

// Nếu chạy trực tiếp (không qua Electron) → tự start
if (!process.env.ELECTRON) {
  startApp();
}

module.exports = { startApp, stopAll };

// Tự động login các acc từ .env khi khởi động
async function autoLoginFromEnv() {
  if (process.env.DISABLE_AUTO_LOGIN === '1') return;
  const generation = stopGeneration;
  const accounts = [];
  // Quét ACCOUNT_1 đến ACCOUNT_20 (bỏ qua số bị thiếu/comment)
  for (let i = 1; i <= 20; i++) {
    const raw = process.env[`ACCOUNT_${i}`];
    if (!raw) continue;
    const [username, ...passParts] = raw.split("|");
    const password = passParts.join("|");
    if (username && password) {
      accounts.push({ label: `Acc #${i}`, username: username.trim(), password: password.trim() });
    }
  }

  if (accounts.length === 0) return;

  const minJackpot   = parseInt(process.env.MIN_JACKPOT)    || 11870;
  const maxJackpot   = parseInt(process.env.MAX_JACKPOT)    || 0; // 0 = không giới hạn trên
  const spinsPerTurn = parseInt(process.env.SPINS_PER_TURN) || 3;
  const botConfig    = resolveConfig({ minJackpot, maxJackpot, spinsPerTurn });

  const zoneStr = maxJackpot > 0 ? `${minJackpot}-${maxJackpot} FC` : `>= ${minJackpot} FC`;
  console.log(`[Auto] Đăng nhập ${accounts.length} acc từ .env (sự kiện: ${event.name}, vùng bắn: ${zoneStr}, ${spinsPerTurn} lần gọi/turn, batch=${LOGIN_BATCH_SIZE})...`);

  const items = accounts.map((acc, idx) => ({ idx, acc }));
  const results = await loginBatch(items);

  for (const { idx, acc, result } of results) {
    if (result.success) {
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2,6) + idx;
      const worker = new BotWorker(id, result.cookie, acc.label, botConfig);
      workers.set(id, worker);
      const started = generation === stopGeneration && await scheduler.enqueue(worker);
      if (!jackpotMonitor.running) {
        jackpotMonitor.setCookie(result.cookie);
        jackpotMonitor.start();
      }
      console.log(`[Auto] ✅ ${acc.label} (${acc.username}) ${started ? "đã chạy" : "đã thêm, chờ quay lần đầu"}`);
    } else {
      console.log(`[Auto] ❌ ${acc.label} (${acc.username}): ${result.error}`);
    }
  }
}
