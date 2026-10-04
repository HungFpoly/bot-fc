/**
 * BotWorker - Mỗi instance quản lý 1 tài khoản BILAC (Sự kiện mới)
 * API: bilac.fconline.garena.vn
 * Nhận jackpot từ JackpotMonitor chung qua WebSocket
 *
 * === API SỰ KIỆN CŨ (VQSC) - GIỮ LẠI CHO SỰ KIỆN SAU ===
 * BASE_URL cũ: "https://vqsc.fconline.garena.vn"
 * GET  /api/app/me              → lấy thông tin tài khoản, socketUid
 * POST /api/app/me/get_balance  → { force: false } → lấy FC balance
 * POST /api/app/reward/spin     → { spinConfId, paymentType, spinNum, isFree }
 *      response: { userRewards[], userExtension, fc }
 * GET  /api/app/me/get_jackpot_infos → lấy info người trúng hũ
 * ================================================================
 */

const { jackpotMonitor } = require("./jackpot-monitor");

// Global broadcast function - được set bởi server.js
let _broadcast = null;
const activeWorkers = new Set();
function setBroadcast(fn) { _broadcast = fn; }

function broadcast(type, data) {
  if (_broadcast) _broadcast(type, data);
}

// === SỰ KIỆN SIEUXOAY (MỚI) ===
const { BASE_URL, event } = require("./event-config");

// === SỰ KIỆN CŨ (VQSC) - comment lại ===
// const BASE_URL = "https://vqsc.fconline.garena.vn";

class BotWorker {
  constructor(id, cookie, label, config = {}) {
    this.id = id;
    this.cookie = cookie;
    this.label = label;
    this.config = {
      MIN_JACKPOT: config.minJackpot ?? 11870,
      MAX_JACKPOT: config.maxJackpot || 0, // 0 = không giới hạn trên
      SPINS_PER_TURN: Number.isInteger(config.spinsPerTurn) && config.spinsPerTurn >= 1 && config.spinsPerTurn <= 50 ? config.spinsPerTurn : 5,
      SPIN_BURST: config.spinBurst === true,
      SPIN_NUM: config.spinNum || 10,
      SPIN_TYPE: config.spinType || 2,
      SPIN_CONF_ID: config.spinConfId || 5,
      PAYMENT_TYPE: config.paymentType || "fc",
      // Khoảng cách giữa các lần gọi API spin (mặc định 200 ms).
      BASE_INTERVAL_MS: Number.isFinite(Number(config.baseInterval))
        ? Math.max(0, Number(config.baseInterval))
        : 200,
      // === CŨ (VQSC) ===
      // SPIN_CONF_ID: config.spinConfId || 5,
      // SPIN_NUM: config.spinNum || 10,
      // PAYMENT_TYPE: config.paymentType || "fc",
    };

    this.running = false;
    this._pendingSpins = 0;
    this.starting = false;
    this._startCancelled = false;
    this.prevJackpot = 0;
    this.lastKnownFc = null;
    this.accountName = null;
    this.accountGameName = null;
    this.accountUid = null;
    this.totalSpins = 0;
    this.firstSpinCompleted = false;
    this.firstSpinPending = false;
    this.firstSpinChecked = false;
    this.jackpotWins = 0;
    this.turnSpins = 0;
    this.waitingNextTurn = false;
    this._lastWaitReason = null; // Chống spam log khi hũ ngoài vùng bắn
    this.lastRewards = [];
    this.logs = [];
    this.loopTimer = null;
    this.isApiChoked = false;
    this.csrfToken = this._extractCsrf(cookie);
    this._sleepResolve = null;
  }

  _extractCsrf(cookie) {
    const match = cookie.match(/csrftoken=([^;]+)/);
    return match ? match[1] : "";
  }

  _log(msg) {
    const entry = `[${new Date().toLocaleTimeString("vi-VN")}] ${msg}`;
    this.logs.push(entry);
    if (this.logs.length > 200) this.logs.shift();
    console.log(`[${this.label}] ${msg}`);
    broadcast("log", { id: this.id, log: entry });
  }

  getStatus() {
    return {
      id: this.id,
      label: this.label,
      running: this.running,
      queued: Boolean(this.queued),
      starting: this.starting,
      jackpot: jackpotMonitor.getJackpot(),
      miniJackpot: jackpotMonitor.getMiniJackpot(), // NEW
      fc: this.lastKnownFc,
      accountName: this.accountName,
      customJackpotRange: Boolean(this.customJackpotRange),
      accountGameName: this.accountGameName,
      totalSpins: this.totalSpins,
      firstSpinAvailable: Boolean(event.firstSpinPath),
      canFirstSpin: Boolean(event.firstSpinPath) && this.firstSpinChecked && !this.firstSpinCompleted && !this.firstSpinPending,
      firstSpinCompleted: this.firstSpinCompleted,
      firstSpinPending: this.firstSpinPending,
      jackpotWins: this.jackpotWins,
      turnSpins: this.turnSpins,
      waitingNextTurn: this.waitingNextTurn,
      lastRewards: this.lastRewards,
      config: this.config,
      zoneLabel: this.zoneLabel(),
      lastLog: this.logs.length > 0 ? this.logs[this.logs.length - 1] : "",
    };
  }

  getLogs() {
    return this.logs.slice(-100);
  }

  matchesJackpotWinner({ nickname, uid }) {
    return Boolean((nickname && (this.accountName === nickname || this.accountGameName === nickname))
      || (uid != null && this.accountUid === String(uid)));
  }

  async spinFirstTime() {
    if (!event.firstSpinPath) return { success: false, error: "Sự kiện này không có nút quay lần đầu" };
    if (!this.firstSpinChecked) await this._fetchAccountData();
    if (!this.firstSpinChecked) return { success: false, error: "Chưa xác minh được trạng thái quay đầu của tài khoản" };
    if (this.firstSpinCompleted) return { success: false, error: "Bot này đã quay lần đầu" };
    if (this.firstSpinPending) return { success: false, error: "Đang xử lý lượt quay lần đầu" };

    this.firstSpinPending = true;
    const stopVersion = this._stopVersion;
    broadcast("status", this.getStatus());
    try {
      const send = () => fetch(`${BASE_URL}${event.firstSpinPath}`, {
        method: "POST",
        headers: this._headers(),
        body: JSON.stringify(event.firstSpinPayload()),
      });
      const response = this.scheduler
        ? await this.scheduler.dispatch(() => this._stopVersion === stopVersion, send)
        : await send();
      if (!response) return { success: false, error: 'Đã dừng.' };
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        const error = `API quay trả HTTP ${response.status}${detail ? `: ${detail.slice(0, 100)}` : ""}`;
        this._log(`⚠️ ${error}`);
        return { success: false, error };
      }
      const result = await response.json();
      if (result?.status !== "successful") {
        const error = result?.message || result?.msg || String(result?.status || "response không có status");
        this._log(`⚠️ Quay lần đầu: ${error}`);
        return { success: false, error };
      }
      const data = result?.payload ?? result;
      if (!event.firstSpinSucceeded(data)) {
        const error = "Response chưa xác nhận lượt quay đầu thành công";
        this._log(`⚠️ ${error}`);
        return { success: false, error };
      }
      this.firstSpinCompleted = true;
      this.totalSpins++;
      const fc = event.firstSpinBalance(data);
      if (Number.isFinite(fc)) this.lastKnownFc = fc;
      const rewards = event.firstSpinRewards(data);
      if (rewards.length) {
        this.lastRewards.unshift({ time: new Date().toLocaleTimeString("vi-VN"), items: rewards.join(", ") });
        if (this.lastRewards.length > 20) this.lastRewards.length = 20;
      }
      this._log("✅ Quay lần đầu thành công; nút đã được khóa.");
      return { success: true };
    } catch (error) {
      this._log(`⚠️ Quay lần đầu thất bại: ${error.message}`);
      await this._fetchAccountData();
      if (this.firstSpinCompleted) {
        this._log("✅ Server đã ghi nhận lượt quay đầu; nút đã được khóa.");
        return { success: true };
      }
      return { success: false, error: error.message };
    } finally {
      this.firstSpinPending = false;
      broadcast("status", this.getStatus());
    }
  }

  // Mô tả vùng bắn hiện tại, dùng cho log và UI
  zoneLabel() {
    return this.config.MAX_JACKPOT > 0
      ? `${this.config.MIN_JACKPOT} - ${this.config.MAX_JACKPOT} FC`
      : `>= ${this.config.MIN_JACKPOT} FC (không giới hạn trên)`;
  }

  // Áp dụng config mới ngay khi bot đang chạy
  applyConfig({ minJackpot, maxJackpot, spinsPerTurn, baseInterval, spinBurst }) {
    if (minJackpot !== undefined) this.config.MIN_JACKPOT = minJackpot;
    if (maxJackpot !== undefined) this.config.MAX_JACKPOT = maxJackpot;
    if (spinsPerTurn !== undefined) this.config.SPINS_PER_TURN = spinsPerTurn;
    if (spinBurst !== undefined) this.config.SPIN_BURST = spinBurst;
    if (baseInterval !== undefined) this.config.BASE_INTERVAL_MS = baseInterval;

    // Updating settings must not grant another paid turn.
    if (this.turnSpins >= this.config.SPINS_PER_TURN) this.waitingNextTurn = true;
    // Xoá cờ chống spam để loop log lại trạng thái theo mốc mới
    this._lastWaitReason = null;

    this._log(`⚙️ ĐÃ CẬP NHẬT CONFIG: Vùng bắn ${this.zoneLabel()} | ${this.config.SPINS_PER_TURN} lần gọi/turn | API ${this.config.BASE_INTERVAL_MS}ms | ${JSON.stringify(event.spinPayload(this.config))}`);
    this._log(`✅ Config mới có hiệu lực; giữ số lượt đã gửi trong turn.`);
  }

  async start() {
    if (this.running || this.starting) return this.running;
    if (this._pendingSpins > 0) {
      this._log("⚠️ Còn request quay chưa có kết quả; chưa thể chạy lại.");
      return false;
    }
    this.starting = true;
    this._startCancelled = false;
    try {
    if (event.firstSpinPath) {
      await this._fetchAccountData();
      if (!this.firstSpinChecked) {
        this._log(`⚠️ ${event.name}: chưa xác minh được trạng thái quay đầu; bot chưa chạy.`);
        return false;
      }
      if (!this.firstSpinCompleted) {
        this._log(`⚠️ ${event.name}: hãy bấm Quay lần đầu trước khi chạy bot tự động.`);
        return false;
      }
    }
    if (!event.spinPath) {
      await this._fetchAccountData();
      await this._fetchBalance();
      this._log(`⚠️ ${event.name}: chưa có API quay; cần bổ sung request trước khi chạy bot.`);
      return false;
    }
    if (this._startCancelled) return false;
    for (const worker of activeWorkers) {
      if (worker !== this && ((this.accountUid && this.accountUid === worker.accountUid)
        || (this.cookie && this.cookie === worker.cookie))) {
        this._log("⚠️ Tài khoản này đang có bot chạy hoặc request quay chưa xong.");
        return false;
      }
    }
    activeWorkers.add(this);
    this.running = true;
    this._loopId = (this._loopId || 0) + 1; // Chống chạy 2 loop song song
    this._log("🚀 Bot khởi chạy...");
    this._log(`⚙️ Cấu hình: Vùng bắn ${this.zoneLabel()} | ${this.config.SPINS_PER_TURN} lần gọi/turn | API ${this.config.BASE_INTERVAL_MS}ms | ${JSON.stringify(event.spinPayload(this.config))}`);
    
    if (!event.firstSpinPath) await this._fetchAccountData();
    await this._fetchBalance();
    if (this._startCancelled) {
      this.running = false;
      if (!this._pendingSpins) activeWorkers.delete(this);
      return false;
    }
    if (this.lastKnownFc !== null) {
      this._log(`✅ Kết nối thành công! Ví: ${this.lastKnownFc} FC | Acc: ${this.accountName || "?"}`);
    } else {
      this._log(`⚠️ Không đọc được thông tin ví - kiểm tra lại cookie`);
    }
    this._startBalancePoller();
    this._runLoop(this._loopId);
    return true;
    } finally {
      this.starting = false;
    }
  }

  stop() {
    this._stopVersion = (this._stopVersion || 0) + 1;
    this.queued = false;
    this._startCancelled = true;
    this.running = false;
    if (!this._pendingSpins) activeWorkers.delete(this);
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
    if (this._sleepResolve) {
      const resolve = this._sleepResolve;
      this._sleepResolve = null;
      resolve();
    }
    if (this._balancePoller) {
      clearInterval(this._balancePoller);
      this._balancePoller = null;
    }
    this._log("🛑 Bot đã dừng");
  }

  // Poll FC mỗi 30s để ví luôn hiển thị đúng khi đang chờ hũ
  _startBalancePoller() {
    if (this._balancePoller) clearInterval(this._balancePoller);
    this._balancePoller = setInterval(async () => {
      if (!this.running) { clearInterval(this._balancePoller); return; }
      await this._fetchBalance();
      broadcast("status", this.getStatus());
    }, 30000);
  }

  /**
   * Lấy thông tin tài khoản theo event-config.js.
   */
  async _fetchAccountData() {
    if (event.firstSpinPath) this.firstSpinChecked = false;
    try {
      const response = await fetch(`${BASE_URL}${event.accountPath}`, {
        method: "GET",
        headers: this._headers(),
      });

      if (response.ok) {
        const res = await response.json();
        // Format: { user: { nickname, uid, fc, ... }, socket_account_id, ... }
        const data = res?.payload ?? res;
        const user = data?.user;

        console.log(`[${this.label}] _fetchAccountData name=${user?.nickname} uid=${user?.uid}`);

        if (user) {
          this.accountName = event.accountName
            ? event.accountName(data)
            : (user.nickname || user.name || user.uid || null);
          this.accountGameName = user.account_name || null;
          this.accountUid = user.uid != null ? String(user.uid) : null;
          if (user.fc !== undefined) this.lastKnownFc = user.fc;
        }
        if (event.firstSpinPath) {
          this.firstSpinChecked = (!res?.status || res.status === "successful")
            && event.firstSpinStateValid(data);
          if (this.firstSpinChecked && event.firstSpinDone(data)) this.firstSpinCompleted = true;
        }

        this._log(`ℹ️ Ví: ${this.lastKnownFc ?? "?"} FC | Acc: ${this.accountName || "?"}`);
        broadcast("status", this.getStatus());
      } else {
        this._log(`⚠️ API ${event.accountPath} trả về ${response.status}`);
      }
    } catch (err) {
      this._log(`❌ Lỗi đồng bộ tài khoản: ${err.message}`);
    }
  }

  /**
   * Lấy balance (FC) theo profile sự kiện.
   */
  async _fetchBalance() {
    try {
      const response = await fetch(`${BASE_URL}${event.balancePath}`, {
        method: event.balanceMethod,
        headers: this._headers(),
        ...(event.balanceBody ? { body: JSON.stringify(event.balanceBody) } : {}),
      });

      if (response.ok) {
        const res = await response.json();
        const fc = event.balance(res?.payload ?? res);
        if (fc !== undefined) this.lastKnownFc = fc;
      }
    } catch (_) {}
  }

  /**
   * Gọi API quay với endpoint và payload trong event-config.js.
   */
  async _fireSpinApi() {
    if (this.isApiChoked || !this.running) return false;
    if (!this.config.SPIN_BURST && this._pendingSpins > 0) return false;
    this._pendingSpins++;

    try {
      const payload = event.spinPayload(this.config);

      const send = () => fetch(`${BASE_URL}${event.spinPath}`, {
        method: "POST",
        headers: this._headers(),
        body: JSON.stringify(payload),
      });
      const response = this.scheduler
        ? await this.scheduler.dispatch(() => this.running, send)
        : await send();
      if (!response) return false;

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        console.log(`[${this.label}] ⚠️ Spin HTTP ${response.status} body:`, errText.slice(0, 300));
        this._log(`⚠️ Spin API lỗi HTTP ${response.status}: ${errText.slice(0, 100)}`);
        if (response.status === 403 || response.status === 401) {
          this._log(`🔒 ${response.status} - Cần đăng nhập lại`);
          this.stop();
        } else {
          this._log("⚠️ Lỗi server sau request trả phí; dừng bot để tránh gửi lại.");
          this.stop();
        }
        return false;
      }

      const res = await response.json();

      // HTTP 200 không đồng nghĩa lượt quay thành công. Kiểm tra status trước khi
      // cập nhật ví/thống kê để response lỗi có payload không bị tính nhầm là 1 spin.
      if (res?.status && res.status !== "successful") {
        const errMsg = res?.message || res?.msg || res?.status || "lỗi không rõ";
        this._log(`⚠️ Server: ${errMsg}`);
        if (/not enough|insufficient|hết.*fc|không đủ/i.test(errMsg)) {
          this._log(`💸 Hết FC! Dừng bot.`);
          this.stop();
        }
        this.stop();
        return false;
      }

      if (event.spinResponseValid && !event.spinResponseValid(res)) {
        this._log(`⚠️ Response ${event.name} chưa xác nhận lượt quay; dừng bot để tránh gửi lại request trả phí.`);
        this.stop();
        return false;
      }

      const data = res?.payload || res;

      if (!data) {
        console.log(`[${this.label}] ⚠️ Spin response JSON:`, JSON.stringify(res).slice(0, 500));
        this._log(`⚠️ Spin response không có payload`);
        return false;
      }

      // Cập nhật FC
      if (data.fc !== undefined || data.user?.fc !== undefined) {
        this.lastKnownFc = data.fc ?? data.user?.fc;
      }

      // Cập nhật jackpot từ spin response luôn (nhanh hơn chờ WS)
      const spinJackpot = event.jackpot?.(data) ?? data.jackpot_value;
      if (Number.isFinite(spinJackpot) && spinJackpot > 0) {
        jackpotMonitor.updateFromSpin(spinJackpot, data.mini_jackpot_value);
      }

      // Xử lý spin_results
      const spinResults = event.spinResults ? event.spinResults(data)
        : (Array.isArray(data.userRewards)
          ? data.userRewards
          : (Array.isArray(data.spin_results) ? data.spin_results : []));
      if (spinResults.length > 0) {
        this.totalSpins++;
        broadcast("status", this.getStatus());

        // Không dùng shoot_type để nhận diện jackpot: API có thể trả shoot_type=3
        // cho phần thưởng thường (ví dụ "Gói SPT 119+"), gây dừng bot nhầm.
        // Grand Jackpot thật được monitor socket xác nhận bằng nickname; ở đây chỉ
        // dùng tên giải rõ ràng để bổ sung log/UI nếu API trả đúng tên jackpot.
        const rewardSummary = spinResults
          .map(r => r.reward_name || r.name || r.item_name || `Reward #${r.rewardId ?? r.spin_result_reward_id ?? r.reward_id ?? r.id ?? "?"}`)
          .join(", ");

        const accPoint = data.user?.accumulation
          ?? data.userExtension?.accumulatedPoint
          ?? data.userExtension?.accumulation
          ?? "?";
        this._log(`🎁 Spin OK | Hũ: ${jackpotMonitor.getJackpot().toLocaleString()} FC | Ví: ${this.lastKnownFc} | Điểm: ${accPoint} | [${rewardSummary}]`);

        this.lastRewards.unshift({
          time: new Date().toLocaleTimeString("vi-VN"),
          items: `FC:${this.lastKnownFc} | [${rewardSummary}]`,
        });
        if (this.lastRewards.length > 5) this.lastRewards.pop();

        for (const r of spinResults) {
          const name = r.reward_name || r.name || r.item_name || "";
          const isMiniJackpot = /mini\s*(jackpot|hũ)/i.test(name);
          // "Giải đặc biệt FC/MC" cũng xuất hiện khi trúng mini; tên này
          // không đủ để xác nhận grand. Chờ monitor xác nhận người trúng.
          const isGrandJackpot = !isMiniJackpot &&
            /jackpot|nổ\s*hũ/i.test(name);

          if (isGrandJackpot || isMiniJackpot) {
            this._log(`🔍 RAW spin_result: ${JSON.stringify(r)}`);
          }

          if (isGrandJackpot) {
            this.jackpotWins++;
            broadcast("status", this.getStatus());
            this._log(`🏆 TRÚNG JACKPOT! ${name} → Dừng bot!`);
            broadcast("jackpot_win", { ...this.getStatus(), type: "grand", prize: name });
            this.stop();
            return true;
          } else if (isMiniJackpot) {
            this.jackpotWins++;
            broadcast("status", this.getStatus());
            this._log(`🎊 TRÚNG MINI JACKPOT! ${name} → Tiếp tục quay`);
            broadcast("jackpot_win", { ...this.getStatus(), type: "mini", prize: name });
            
          }
        }

        return true;
      }

      // Spin thành công nhưng không có spin_results (edge case)
      if (res?.status === "successful" || !res?.status) {
        this.totalSpins++;
        broadcast("status", this.getStatus());
        this._log(`🎁 Spin OK | FC: ${this.lastKnownFc}`);
        return true;
      }

      return false;
    } catch (err) {
      this._log(`❌ Lỗi spin: ${err.message}`);
      this.stop();
      return false;
    } finally {
      this._pendingSpins--;
      if (this.running && this.lastKnownFc !== null && Number(this.lastKnownFc) <= 0) this.stop();
      if (!this.running && !this._pendingSpins) activeWorkers.delete(this);
    }
  }

  async _runLoop(loopId) {
    while (this.running && this._loopId === loopId) {
      if (this.lastKnownFc !== null && Number(this.lastKnownFc) <= 0) {
        this._log('Hết FC! Dừng bot.');
        this.stop();
        break;
      }
      const jackpot = jackpotMonitor.getJackpot();

      // Phát hiện hũ người khác nổ → reset turn, chờ hũ tích lại
      if (this.prevJackpot > 0 && jackpot > 0 && jackpot < this.prevJackpot * 0.5) {
        const win = jackpotMonitor.getLatestJackpotWin(jackpot);
        const resetInfo = `Hũ reset (monitor): ${this.prevJackpot} → ${jackpot} FC`;
        const message = win
          ? `⚠️ Hũ nổ: ${win.nickname} trúng ${win.prize} | ${resetInfo}`
          : `⚠️ Hũ nổ (người khác): ${resetInfo}`;
        this._log(`${message} → Reset turn, chờ hũ tích lại`);
        this.turnSpins = 0;
        this.waitingNextTurn = false;
        this._lastWaitReason = null;
        this.prevJackpot = jackpot;
        
        continue;
      }

      if (jackpot === 0) {
        await this._sleep(2000);
        continue;
      }

      // Đang chờ turn mới
      if (this.waitingNextTurn) {
        if (jackpot < this.config.MIN_JACKPOT) {
          this.waitingNextTurn = false;
          this.turnSpins = 0;
          this._log(`🔄 Turn mới! Hũ: ${jackpot} FC - Chờ đạt mốc ${this.config.MIN_JACKPOT}`);
        } else {
          await this._sleep(1000);
        }
        this.prevJackpot = jackpot;
        continue;
      }

      // Hũ nằm trong vùng bắn → bắn
      if (this._inSpinZone(jackpot)) {
        this._lastWaitReason = null;
        if (this.turnSpins >= this.config.SPINS_PER_TURN) {
          this.waitingNextTurn = true;
          continue;
        }
        if (this.config.SPIN_BURST) {
          const count = this.config.SPINS_PER_TURN - this.turnSpins;
          const interval = this.config.BASE_INTERVAL_MS;
          this.waitingNextTurn = true;
          this.prevJackpot = jackpot;
          this._log(`🚀 Gửi ${count} request spin, cách nhau ${interval}ms, không chờ response | Hũ: ${jackpot} FC`);
          for (let i = 0; i < count; i++) {
            if (i > 0 && interval > 0) await this._sleep(interval);
            if (!this.running || this._loopId !== loopId) break;
            // Dispatch independently; responses are handled inside _fireSpinApi.
            void this._fireSpinApi().catch(err => this._log(`❌ Lỗi spin: ${err.message}`));
            this.turnSpins++;
          }
          this._log(`⏸️ Đã gửi ${this.turnSpins}/${count} request → Chờ turn sau; kết quả được cập nhật riêng`);
          if (!this.running || this._loopId !== loopId) break;
          continue;
        }
        this._log(`🚀 XẢ ĐẠN [${this.turnSpins + 1}/${this.config.SPINS_PER_TURN}] | Hũ: ${jackpot} FC | Ví: ${this.lastKnownFc || "?"} FC`);
        const success = await this._fireSpinApi();
        if (this._loopId !== loopId) break;
        if (!success) {
          this._log("⚠️ Lượt quay chưa được xác nhận; dừng, không tự gửi lại để tránh tốn FC.");
          this.stop();
          break;
        } else {
          this.turnSpins++;
        }

        if (this.turnSpins >= this.config.SPINS_PER_TURN) {
          this._log(`⏸️ Đã bắn ${this.config.SPINS_PER_TURN} lượt → Chờ turn sau`);
          this.waitingNextTurn = true;
        }

        // Giữ khoảng cách đã cấu hình giữa các request spin, kể cả retry.
        await this._sleep(this.config.BASE_INTERVAL_MS);
      } else {
        // Hũ ngoài vùng bắn → chờ. Chỉ log khi lý do chờ đổi, tránh spam
        const reason = jackpot < this.config.MIN_JACKPOT ? "below" : "above";
        if (this._lastWaitReason !== reason) {
          this._lastWaitReason = reason;
          if (reason === "below") {
            this._log(`💤 Hũ: ${jackpot} FC - Chờ đạt mốc ${this.config.MIN_JACKPOT} FC`);
          } else {
            this._log(`🛑 Hũ: ${jackpot} FC - Vượt mốc Max ${this.config.MAX_JACKPOT} FC → tạm ngừng bắn`);
          }
        }
        await this._sleep(1000);
      }

      this.prevJackpot = jackpot;
    }
  }

  // Hũ có nằm trong vùng được phép bắn không (MAX_JACKPOT = 0 → không giới hạn trên)
  _inSpinZone(jackpot) {
    if (jackpot < this.config.MIN_JACKPOT) return false;
    if (this.config.MAX_JACKPOT > 0 && jackpot > this.config.MAX_JACKPOT) return false;
    return true;
  }

  _headers() {
    const headers = {
      Accept: "*/*",
      "Accept-Language": "en-US,en;q=0.9,vi;q=0.8",
      "Content-Type": "application/json",
      Cookie: this.cookie,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
      Referer: `${BASE_URL}/`,
      Origin: BASE_URL,
    };
    if (this.csrfToken) headers["x-csrftoken"] = this.csrfToken;
    return headers;
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      this._sleepResolve = resolve;
      this.loopTimer = setTimeout(() => {
        this.loopTimer = null;
        this._sleepResolve = null;
        resolve();
      }, ms);
    });
  }

  // Subscribe to Mini Jackpot bust events from monitor
  _subscribeMiniEvents() {
    // Disabled: bot always uses fixed configuration.
  }

  // Handle Mini bust event và apply strategy mới
  _handleMiniBustEvent(event) {
    // Disabled: bot always uses fixed configuration.
  }

  // Apply strategy based on Mini bust range
  _applyMiniStrategy(miniValue, bustRangeK) {
    // Disabled: bot always uses fixed configuration.
  }

  // Parse Mini value from reward object (fallback nếu API không trả mini_jackpot_value)
  _parseMiniValueFromReward(reward) {
    // Try to extract value from reward object
    // Example: reward.value, reward.amount, etc.
    if (reward.value) return parseInt(reward.value);
    if (reward.amount) return parseInt(reward.amount);
    // Try to parse from reward_name if it contains number
    const match = (reward.reward_name || "").match(/(\d{1,2})[.,]?(\d{3})/);
    if (match) {
      return parseInt(match[1] + match[2]);
    }
    return 0;
  }
}

module.exports = { BotWorker, setBroadcast };
