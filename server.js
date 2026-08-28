const express = require("express");
const path = require("path");
if (!process.env.ELECTRON) require("dotenv").config();
const { BotWorker, setBroadcast } = require("./bot-worker");
const { jackpotMonitor } = require("./jackpot-monitor");
const { GarenaAuth } = require("./garena-auth");

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const workers = new Map();
jackpotMonitor.setCookieProvider((currentCookie) => {
  const active = [...workers.values()].filter(worker => worker.running && worker.cookie);
  const fallback = active.find(worker => worker.cookie !== currentCookie)
    || [...workers.values()].find(worker => worker.cookie && worker.cookie !== currentCookie);
  return fallback?.cookie || null;
});

// Config cấp API — chỉ đọc từ .env, KHÔNG nhận từ client / không hiện trên UI
// === SỰ KIỆN BONG VÀNG ===
function apiConfig() {
  return {
    spinNum:     parseInt(process.env.SPIN_NUM, 10) || 10,
    paymentType: process.env.PAYMENT_TYPE || "fc",
  };
}

// Gộp config từ client với config API; client không ghi đè được config API
function resolveConfig(clientConfig = {}) {
  const { spinType, spinConfId, spinNum, paymentType, ...safe } = clientConfig || {};
  return { ...safe, ...apiConfig() };
}

// SSE clients
const sseClients = new Set();

// Broadcast tất cả events xuống browser
function broadcast(type, data) {
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
jackpotMonitor.onOwnJackpot = ({ nickname, prize, parsedValue }) => {
  // Khi có người nổ hũ, check tất cả bot xem có ai trùng nickname không
  console.log(`[Server] 🔍 Checking if ${nickname} matches any bot...`);
  for (const [, worker] of workers) {
    if (worker.accountName && worker.accountName === nickname && worker.running) {
      console.log(`[Server] 🏆 Bot ${worker.label} (${nickname}) TRÚNG HŨ ${prize} → DỪNG BOT!`);
      worker._log(`🏆🏆🏆 BẠN ĂN HŨ ${prize}! BOT TẰM DỪNG! 🏆🏆🏆`);
      broadcast("jackpot_win", { ...worker.getStatus(), type: "grand" });
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
    if (worker.accountName && worker.accountName === nickname && worker.running) {
      worker._log(`🎊 BẠN TRÚNG MINI JACKPOT ${prize}! Bot tiếp tục chạy.`);
      broadcast("jackpot_win", { ...worker.getStatus(), type: "mini" });
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
app.post("/api/bots/add", (req, res) => {
  const { cookie, label, config } = req.body;

  if (!cookie) {
    return res.status(400).json({ error: "Thiếu cookie" });
  }

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const worker = new BotWorker(id, cookie, label || `Acc #${workers.size + 1}`, resolveConfig(config));
  workers.set(id, worker);
  worker.start();

  // Khởi động JackpotMonitor nếu chưa chạy
  if (!jackpotMonitor.running) {
    jackpotMonitor.setCookie(cookie);
    jackpotMonitor.start();
  }

  res.json({ success: true, id, message: `Bot ${label || id} đã khởi chạy` });
});

// API: Thêm nhiều bot cùng lúc
app.post("/api/bots/add-bulk", (req, res) => {
  const { accounts, config } = req.body;

  if (!accounts || !Array.isArray(accounts) || accounts.length === 0) {
    return res.status(400).json({ error: "Thiếu danh sách accounts" });
  }

  const results = [];
  accounts.forEach((acc, index) => {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + index;
    const label = acc.label || `Acc #${workers.size + 1}`;
    const worker = new BotWorker(id, acc.cookie, label, resolveConfig(config || acc.config));
    workers.set(id, worker);
    worker.start();
    results.push({ id, label });

    // Khởi động JackpotMonitor với cookie acc đầu tiên
    if (!jackpotMonitor.running) {
      jackpotMonitor.setCookie(acc.cookie);
      jackpotMonitor.start();
    }
  });

  res.json({ success: true, count: results.length, bots: results });
});

// API: Dừng một bot
app.post("/api/bots/:id/stop", (req, res) => {
  const worker = workers.get(req.params.id);
  if (!worker) return res.status(404).json({ error: "Không tìm thấy bot" });
  worker.stop();
  res.json({ success: true, message: `Bot ${worker.label} đã dừng` });
});

// API: Khởi động lại một bot
app.post("/api/bots/:id/start", (req, res) => {
  const worker = workers.get(req.params.id);
  if (!worker) return res.status(404).json({ error: "Không tìm thấy bot" });
  worker.start();
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
app.post("/api/bots/stop-all", (req, res) => {
  for (const [, worker] of workers) {
    worker.stop();
  }
  res.json({ success: true, message: "Đã dừng tất cả bot" });
});

// API: Cập nhật config chung
app.post("/api/config", (req, res) => {
  // Chỉ nhận config hiển thị trên UI. SPIN_NUM / SPIN_CONF_ID / PAYMENT_TYPE
  // là config cấp API, lấy từ .env nên bỏ qua nếu client có gửi.
  const { minJackpot, maxJackpot, spinsPerTurn } = req.body;
  console.log(`[Server] Cập nhật config: min=${minJackpot}, max=${maxJackpot}, spins=${spinsPerTurn}`);

  for (const [, worker] of workers) {
    worker.applyConfig({ minJackpot, maxJackpot, spinsPerTurn });
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
      worker.start();

      if (!jackpotMonitor.running) {
        jackpotMonitor.setCookie(loginResult.cookie);
        jackpotMonitor.start();
      }

      results.push({ id, label, username, status: "ok" });
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
  const results = [];
  for (let i = 0; i < accounts.length; i += LOGIN_BATCH_SIZE) {
    const batch = accounts.slice(i, i + LOGIN_BATCH_SIZE);
    console.log(`[Auth] Batch ${Math.floor(i/LOGIN_BATCH_SIZE)+1}: login ${batch.map(a=>a.username||a.acc?.username).join(", ")}...`);
    const batchResults = await Promise.all(batch.map(item => {
      // hỗ trợ cả {username,password,label} lẫn {idx,acc,result}
      if (item.acc) return GarenaAuth.login(item.acc.username, item.acc.password).then(r => ({ ...item, result: r }));
      return GarenaAuth.login(item.username, item.password).then(r => ({ ...item, result: r }));
    }));
    results.push(...batchResults);
  }
  return results;
}
function stopAll() {
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
  console.log(`[Auto] Đăng nhập ${accounts.length} acc từ .env (vùng bắn: ${zoneStr}, ${spinsPerTurn} lần gọi/turn, spinNum=${botConfig.spinNum}, batch=${LOGIN_BATCH_SIZE})...`);

  const items = accounts.map((acc, idx) => ({ idx, acc }));
  const results = await loginBatch(items);

  for (const { idx, acc, result } of results) {
    if (result.success) {
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2,6) + idx;
      const worker = new BotWorker(id, result.cookie, acc.label, botConfig);
      workers.set(id, worker);
      worker.start();
      if (!jackpotMonitor.running) {
        jackpotMonitor.setCookie(result.cookie);
        jackpotMonitor.start();
      }
      console.log(`[Auto] ✅ ${acc.label} (${acc.username}) đã chạy`);
    } else {
      console.log(`[Auto] ❌ ${acc.label} (${acc.username}): ${result.error}`);
    }
  }
}
