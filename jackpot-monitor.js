/**
 * JackpotMonitor - Kết nối WebSocket real-time để theo dõi jackpot (BILAC)
 *
 * WebSocket URL: wss://sock.bis.fo4.garena.vn/io/?account_id={socketUid}&EIO=4&transport=websocket
 * Message format:
 *   42["message",{"type":"jackpot_change","data":{"jackpotValue":21937}}]
 *   42["message",{"type":"jackpot_win","data":{"jackpotValue":254,"winValue":28230,"user":{"name":"..."}}}]
 *   42["message",{"type":"jackpot_win_mini","data":{"jackpotValue":8162,"winValue":901,"user":{"name":"..."}}}]
 *
 * === WS FORMAT CŨ (VQSC) - GIỮ LẠI CHO SỰ KIỆN SAU ===
 *   42["message",{"type":"jackpot_change","data":{"jackpotValue":9387}}]
 *   42["message",{"type":"prize_change","data":{"jackpot_prize":9387}}]
 * ================================================================
 *
 * === API CŨ (VQSC) - GIỮ LẠI CHO SỰ KIỆN SAU ===
 * BASE_URL: "https://vqsc.fconline.garena.vn"
 * GET  /api/app/me              → lấy socketUid, socketUrl
 * GET  /api/app/me/get_jackpot_infos → lấy info người trúng hũ
 * ================================================================
 */

const WebSocket = require("ws");

// === SỰ KIỆN SIEUXOAY (MỚI) ===
const { BASE_URL, event } = require("./event-config");

// === SỰ KIỆN CŨ (VQSC) - comment lại ===
// const BASE_URL = "https://vqsc.fconline.garena.vn";
// WS_HOST lấy từ socketUrl trong /api/app/me response

class JackpotMonitor {
  constructor() {
    this.jackpot = 0;
    this.miniJackpot = 0; // NEW: Track Mini Jackpot value
    this.running = false;
    this.cookie = null;
    this.csrfToken = "";
    this.socketUid = null;
    this.ws = null;
    this.pingInterval = null;
    this.reconnectTimer = null;
    this.onJackpotChange = null;
    this.onJackpotBust = null;
    this.onOwnJackpot = null; // NEW: callback khi chính mình nổ hũ
    this.onMiniJackpot = null;
    this.onMiniJackpotBust = null; // NEW: callback khi Mini nổ
    this._miniBustListeners = new Set();
    this._cookieProvider = null;
    this._pendingWinner = null;
    this._recentReset = null;
    this._lastBustKey = null;
    this._recentJackpotWins = new Map();
    this._latestJackpotWin = null;
    this._lastMiniBustKey = null; // NEW: dedup Mini bust events
    this._lastMiniEvent = null;
  }

  setCookie(cookie) {
    this.cookie = cookie;
    const match = cookie.match(/csrftoken=([^;]+)/);
    this.csrfToken = match ? match[1] : "";
  }

  setCookieProvider(provider) {
    this._cookieProvider = typeof provider === "function" ? provider : null;
  }

  rotateCookie() {
    if (!this._cookieProvider) return false;
    const cookie = this._cookieProvider(this.cookie);
    if (!cookie || cookie === this.cookie) return false;
    this.setCookie(cookie);
    console.log("[JackpotMonitor] Rotated to another bot cookie");
    return true;
  }

  addMiniBustListener(listener) {
    if (typeof listener === "function") this._miniBustListeners.add(listener);
  }

  removeMiniBustListener(listener) {
    this._miniBustListeners.delete(listener);
  }

  getJackpot() {
    return this.jackpot;
  }

  getMiniJackpot() {
    return this.miniJackpot;
  }

  getLatestJackpotWin(resetValue) {
    const win = this._latestJackpotWin;
    if (!win || Date.now() - win.time > 30000) return null;
    return win.resetValue === resetValue ? win : null;
  }

  updateFromSpin(value, miniValue) {
    if (typeof value === "number" && value > 0) {
      this._setJackpot(value);
    }
    // Mini Jackpot strategy is disabled; keep the fixed bot configuration.
  }

  _setJackpot(value) {
    if (value > 0 && value !== this.jackpot) {
      // Phát hiện nổ hũ: jackpot giảm >50%
      if (this.jackpot > 0 && value < this.jackpot * 0.5) {
        console.log(`[JackpotMonitor] 💥 HŨ NỔ! ${this.jackpot} → ${value} FC`);
        this._recentReset = { from: this.jackpot, to: value, time: new Date() };
        if (!this._emitPendingWinner(this.jackpot, value)) {
          this._fetchJackpotWinner(this.jackpot, value);
        } else {
          this._recentReset = null;
        }
      }
      this.jackpot = value;
      console.log(`[JackpotMonitor] 🎰 Jackpot: ${value} FC`);
      if (this.onJackpotChange) this.onJackpotChange(value);
    } else if (value > 0 && this.jackpot === 0) {
      this.jackpot = value;
      if (this.onJackpotChange) this.onJackpotChange(value);
    }
  }

  _emitPendingWinner(fromValue, toValue) {
    const winner = this._pendingWinner;
    if (!winner) return false;
    this._pendingWinner = null;
    if (Date.now() - winner.time.getTime() > 30000) return false;
    if (this.onJackpotBust) {
      this.onJackpotBust({
        from: fromValue,
        to: toValue,
        winner: winner.nickname,
        prize: winner.prize,
        time: winner.time,
      });
    }
    return true;
  }

  _emitWinnerAfterRecentReset(winner) {
    const reset = this._recentReset;
    if (!reset || Date.now() - reset.time.getTime() > 30000) {
      this._recentReset = null;
      return false;
    }
    this._recentReset = null;
    if (this.onJackpotBust) {
      this.onJackpotBust({
        from: reset.from,
        to: reset.to,
        winner: winner.nickname,
        prize: winner.prize,
        time: winner.time,
      });
    }
    return true;
  }

  _isDuplicateJackpotWin(nickname, prize) {
    const now = Date.now();
    const key = `${String(nickname).trim().toLowerCase()}_${prize}`;
    const last = this._recentJackpotWins.get(key);
    if (last && now - last < 60000) return true;
    this._recentJackpotWins.set(key, now);
    for (const [oldKey, time] of this._recentJackpotWins) {
      if (now - time >= 60000) this._recentJackpotWins.delete(oldKey);
    }
    return false;
  }

  _setMiniJackpot(value) {
    if (value > 0 && value !== this.miniJackpot) {
      // Phát hiện Mini nổ: giảm >50%
      if (this.miniJackpot > 0 && value < this.miniJackpot * 0.5) {
        console.log(`[JackpotMonitor] 🎊 MINI HŨ NỔ! ${this.miniJackpot} → ${value} FC`);
        this._handleMiniBust(this.miniJackpot, value);
      }
      this.miniJackpot = value;
      console.log(`[JackpotMonitor] 🎁 Mini Jackpot: ${value} FC`);
    } else if (value > 0 && this.miniJackpot === 0) {
      this.miniJackpot = value;
    }
  }

  _handleMiniBust(fromValue, toValue) {
    // Xác định range Mini nổ (10k, 11k, 12k, 13k)
    const bustRange = Math.floor(fromValue / 1000);
    const bustKey = `mini_${bustRange}k`;

    // Dedup để tránh spam
    if (bustKey === this._lastMiniBustKey) {
      console.log(`[JackpotMonitor] ⏭️ Skip duplicate Mini bust: ${bustKey}`);
      return;
    }

    this._lastMiniBustKey = bustKey;

    console.log(`[JackpotMonitor] 📊 Mini nổ ở mốc ${bustRange}k (~${fromValue} FC) → Điều chỉnh strategy`);

    // Broadcast Mini bust event với recommended Grand JP range
    {
      let minGrand, maxGrand;
      
      if (bustRange === 10) {
        // Mini nổ 10,000-10,999 → Set Grand 13,000-14,500
        minGrand = 13000;
        maxGrand = 14500;
      } else if (bustRange === 11) {
        // Mini nổ 11,000-11,999 → Set Grand 14,200-15,500
        minGrand = 14200;
        maxGrand = 15500;
      } else if (bustRange === 12) {
        // Mini nổ 12,000-12,999 → Set Grand 15,200-16,500
        minGrand = 15200;
        maxGrand = 16500;
      } else if (bustRange === 13) {
        // Mini nổ 13,000-13,999 → Set Grand 17,200-18,500
        minGrand = 17200;
        maxGrand = 18500;
      } else {
        // Unknown range → không thay đổi
        console.log(`[JackpotMonitor] ⚠️ Mini nổ ngoài range tracking (${bustRange}k) → Không điều chỉnh`);
        return;
      }

      console.log(`[JackpotMonitor] 🎯 Recommend Grand JP range: ${minGrand}-${maxGrand} FC (max 3 spins)`);
      
      const event = {
        from: fromValue,
        to: toValue,
        bustRange: `${bustRange}k`,
        recommendedMin: minGrand,
        recommendedMax: maxGrand,
        recommendedSpins: 3,
        time: new Date()
      };
      if (this.onMiniJackpotBust) this.onMiniJackpotBust(event);
      for (const listener of this._miniBustListeners) {
        try { listener(event); }
        catch (err) { console.log(`[JackpotMonitor] Mini listener error: ${err.message}`); }
      }
    }
  }

  async _fetchJackpotWinner(fromValue, toValue) {
    // Chờ 2s để server kịp update billboard
    await new Promise(r => setTimeout(r, 2000));

    let winner = null; // Đổi từ "???" thành null để skip broadcast nếu không tìm được
    let prizeValue = `${fromValue.toLocaleString()} FC`;

    // Fallback lấy winner khi socket không kịp gửi event.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const response = await this._fetchWithCookieFallback(`${BASE_URL}${event.jackpotPath}`, {
          method: "GET",
          headers: this._headers(),
        });

        if (response.ok) {
          const res = await response.json();
          // payload.jackpot_billboard: { value: "16.052 FC", nickname: "cloi2301" }
          const data = res?.payload ?? res;
          const billboard = event.jackpotBillboard
            ? event.jackpotBillboard(data)
            : data?.jackpot_billboard;
          console.log(`[JackpotMonitor] _fetchJackpotWinner attempt ${attempt+1}: billboard=${JSON.stringify(billboard)} lastKey=${this._lastBustKey}`);
          
          if (billboard?.nickname && billboard?.value) {
            // Parse value string: "16.052 FC" hoặc "1460 FC" → số nguyên
            const valueStr = billboard.value.toString();
            // Loại bỏ " FC" và khoảng trắng, sau đó xóa dấu chấm/phẩy phân cách hàng nghìn
            const numericStr = valueStr.replace(/\s*FC$/i, '').trim().replace(/[.,]/g, '');
            const parsedValue = parseInt(numericStr, 10) || 0;
            
            // Dedup key: group theo 100 FC để tránh spam (vì billboard có thể lag)
            // VD: 16052 FC và 16100 FC cùng key → chỉ hiện 1 lần
            const groupedValue = Math.floor(parsedValue / 100) * 100;
            const bustKey = `${billboard.nickname}_${groupedValue}`;
            console.log(`[JackpotMonitor] 🔍 Parse: "${valueStr}" → ${parsedValue} FC (group=${groupedValue}) | bustKey=${bustKey} | lastKey=${this._lastBustKey}`);
            
            if (bustKey !== this._lastBustKey && parsedValue > 0) {
              if (this._isDuplicateJackpotWin(billboard.nickname, parsedValue)) break;
              winner = billboard.nickname;
              prizeValue = billboard.value; // Giữ nguyên format gốc "16.052 FC"
              this._lastBustKey = bustKey;
              console.log(`[JackpotMonitor] 🏆 Người trúng hũ: ${winner} - ${prizeValue}`);
              if (event.jackpotBillboard && this.onOwnJackpot) {
                this.onOwnJackpot({ nickname: winner, prize: prizeValue, parsedValue });
              }
              break;
            } else if (bustKey === this._lastBustKey) {
              console.log(`[JackpotMonitor] ⏭️ Skip duplicate: ${bustKey}`);
            }
          } else {
            console.log(`[JackpotMonitor] ⚠️ Billboard thiếu thông tin: ${JSON.stringify(billboard)}`);
          }
        }
      } catch (err) {
        console.log(`[JackpotMonitor] ❌ Fetch winner error: ${err.message}`);
      }

      if (attempt < 4) await new Promise(r => setTimeout(r, 2500));
    }

    // CHỈ broadcast nếu tìm được winner (không broadcast "???")
    if (winner && this.onJackpotBust) {
      console.log(`[JackpotMonitor] 📢 Broadcasting bust: ${winner} (${prizeValue}) | from=${fromValue} to=${toValue}`);
      this.onJackpotBust({ from: fromValue, to: toValue, winner, prize: prizeValue, time: new Date() });
    } else {
      console.log(`[JackpotMonitor] ⏭️ Skip bust broadcast (winner not found or duplicate)`);
    }
  }

  async start() {
    if (this.running) return;
    if (!this.cookie) {
      console.log("[JackpotMonitor] Chưa có cookie, chờ...");
      return;
    }
    this.running = true;
    console.log("[JackpotMonitor] 🟢 Khởi động...");

    // Lấy socket_account_id từ /api/user/get
    await this._fetchSocketInfo();

    if (this.socketUid) {
      this._connectWebSocket();
    } else {
      console.log("[JackpotMonitor] ⚠️ Không lấy được socketUid, dùng polling fallback");
      this._pollFallback();
    }
  }

  stop() {
    this.running = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    console.log("[JackpotMonitor] 🔴 Đã dừng");
  }

  /**
   * Lấy ID socket từ /api/user/get.
   * Response: { socket_account_id, socket_env, jackpot_value, user, ... }
   */
  async _fetchSocketInfo() {
    try {
      const response = await this._fetchWithCookieFallback(`${BASE_URL}${event.accountPath}`, {
        method: "GET",
        headers: this._headers(),
      });

      if (response.ok) {
        const res = await response.json();
        const data = res?.payload ?? res;

        this.socketUid = event.socketId(data) ?? null;
        this.socketUrl = event.socketUrl(data);
        if (!this.socketUrl) this.socketUid = null;

        const jackpot = event.jackpot ? event.jackpot(data) : data?.jackpot_value;
        if (Number.isFinite(jackpot) && jackpot >= 0) {
          this._setJackpot(jackpot);
        }

        if (this.socketUid) {
          console.log(`[JackpotMonitor] socketUid: ${this.socketUid}`);
        } else {
          console.log(`[JackpotMonitor] ⚠️ Không tìm thấy socketUid`);
        }
      }
    } catch (err) {
      console.log(`[JackpotMonitor] Lỗi fetch socket info: ${err.message}`);
    }
  }

  _connectWebSocket() {
    // BILAC: dùng WS_HOST cố định
    const url = new URL(this.socketUrl);
    url.protocol = url.protocol === "http:" ? "ws:" : url.protocol === "https:" ? "wss:" : url.protocol;
    if (url.pathname === "/") url.pathname = "/io/";
    url.searchParams.set("account_id", this.socketUid);
    url.searchParams.set("EIO", "4");
    url.searchParams.set("transport", "websocket");
    console.log(`[JackpotMonitor] 🔌 Kết nối WebSocket: ${url}`);

    this.ws = new WebSocket(url.href, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
        Origin: BASE_URL,
        Cookie: this.cookie,
        Referer: `${BASE_URL}/`,
      },
    });

    this.ws.on("open", () => {
      console.log("[JackpotMonitor] ✅ WebSocket đã kết nối!");
      this.pingInterval = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send("3");
        }
      }, 25000);
    });

    this.ws.on("message", (data) => {
      const raw = data.toString();
      if (!raw.startsWith("0") && raw !== "2" && raw !== "3") {
        console.log(`[JackpotMonitor] RAW: ${raw.slice(0, 150)}`);
      }
      this._handleMessage(raw);
    });

    this.ws.on("close", (code, reason) => {
      console.log(`[JackpotMonitor] ⚡ WS đóng: ${code} ${reason}`);
      this._cleanup();
      // A disconnected socket cannot confirm that the last pool value is current.
      this.jackpot = 0;
      if (this.onJackpotChange) this.onJackpotChange(0);
      if (this.running) {
        const cookieChanged = this.rotateCookie();
        console.log("[JackpotMonitor] Reconnect sau 5s...");
        this.reconnectTimer = setTimeout(async () => {
          if (!this.running) return;
          if (cookieChanged) await this._fetchSocketInfo();
          if (this.socketUid) this._connectWebSocket();
          else this._pollFallback();
        }, 5000);
      }
    });

    this.ws.on("error", (err) => {
      console.log(`[JackpotMonitor] ❌ WS lỗi: ${err.message}`);
    });
  }

  _handleMessage(data) {
    if (data === "2") {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send("3");
      }
      return;
    }

    if (data.startsWith("0")) {
      try {
        const config = JSON.parse(data.slice(1));
        if (config.pingInterval) {
          if (this.pingInterval) clearInterval(this.pingInterval);
          this.pingInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
              this.ws.send("3");
            }
          }, config.pingInterval);
          console.log(`[JackpotMonitor] WS config: pingInterval=${config.pingInterval}ms`);
        }
      } catch (_) {}

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send("40");
        console.log(`[JackpotMonitor] Sent Socket.IO connect packet (40)`);
      }
      return;
    }

    // Socket.IO message parsing
    if (data.startsWith("42") || data.startsWith("4")) {
      try {
        const jsonStr = data.replace(/^\d+/, "");
        const arr = JSON.parse(jsonStr);

        if (Array.isArray(arr)) {
          const packet = arr[1];

          // === FORMAT MỚI (BILAC) ===
          // 42["message",{"content":{"env":"live","type":"jackpot_value","value":9044}}]
          const content = packet?.content;

          // Không dùng biến động pool Mini cho strategy, nhưng vẫn xử lý riêng
          // event mini_jackpot bên dưới để hiển thị người trúng.
          if (content && content.type === "mini_jackpot_value") {
            return;
          }
          
          // TYPE 1: jackpot_value - cập nhật giá trị hũ
          if (content && content.type === "jackpot_value" && typeof content.value === "number") {
            if (content.value > 0) {
              this._setJackpot(content.value);
              return;
            }
          }

          // TYPE 1b: mini_jackpot_value - cập nhật giá trị Mini hũ
          if (content && content.type === "mini_jackpot_value" && typeof content.value === "number") {
            if (content.value > 0) {
              this._setMiniJackpot(content.value);
              return;
            }
          }
          
          // TYPE 2: jackpot - event nổ hũ có nickname
          // 42["message",{"content":{"env":"live","type":"jackpot","value":"17.698 FC","nickname":"RIOJACKPOTxSSSX2"}}]
          const jackpotNickname = content?.nickname || content?.data?.account_name;
          const jackpotValue = content?.value ?? content?.data?.jackpot_prize;
          const jackpotUid = content?.data?.uid;
          if (content?.type === "jackpot" && jackpotNickname && jackpotValue) {
            console.log(`[JackpotMonitor] 🎰 JACKPOT EVENT: ${jackpotNickname} trúng ${jackpotValue}`);
            
            // Parse value từ string "17.698 FC" → số
            const valueStr = jackpotValue.toString();
            const numericStr = valueStr.replace(/\s*FC$/i, '').trim().replace(/[.,]/g, '');
            const parsedValue = parseInt(numericStr, 10) || 0;
            
            // Broadcast bust event cho tất cả (kể cả chính mình)
            if (parsedValue > 0) {
              const bustKey = content.data
                ? `${jackpotUid || jackpotNickname}_${parsedValue}`
                : `${jackpotNickname}_${Math.floor(parsedValue / 100) * 100}`;
              if (bustKey !== this._lastBustKey) {
                if (this._isDuplicateJackpotWin(jackpotNickname, parsedValue)) return;
                this._lastBustKey = bustKey;
                console.log(`[JackpotMonitor] 🏆 Broadcasting jackpot event: ${jackpotNickname} - ${jackpotValue}`);
                
                // Broadcast bust feed
                const winnerEvent = {
                  nickname: jackpotNickname,
                  prize: typeof jackpotValue === "number" ? `${jackpotValue.toLocaleString("vi-VN")} FC` : jackpotValue,
                  time: new Date(),
                };
                if (!this._emitWinnerAfterRecentReset(winnerEvent)) {
                  this._pendingWinner = winnerEvent;
                }
                
                // Broadcast "own jackpot" để bot worker check nickname và dừng
                if (this.onOwnJackpot) {
                  this.onOwnJackpot({ 
                    nickname: jackpotNickname,
                    uid: jackpotUid,
                    prize: winnerEvent.prize,
                    parsedValue,
                  });
                }
              }
            }
            return;
          }

          // TYPE 2b: mini_jackpot - event Mini nổ hũ có nickname
          // 42["message",{"content":{"env":"live","type":"mini_jackpot","value":"1.348 FC","nickname":"Hoanganhhihii"}}]
          // NOTE: value là phần thưởng (không quan trọng)
          // QUAN TRỌNG: Lấy Grand JP hiện tại (this.jackpot) làm mốc Mini nổ!
          if (content && content.type === "mini_jackpot" && content.nickname && content.value) {
            console.log(`[JackpotMonitor] 🎊 MINI JACKPOT EVENT: ${content.nickname} trúng ${content.value}`);

            const valueStr = content.value.toString();
            const numericStr = valueStr.replace(/\s*FC$/i, "").trim().replace(/[.,]/g, "");
            const parsedValue = parseInt(numericStr, 10) || 0;
            const miniEventKey = `${content.nickname}_${parsedValue}`;
            const isDuplicate = this._lastMiniEvent?.key === miniEventKey
              && Date.now() - this._lastMiniEvent.time < 30000;

            if (!isDuplicate) {
              this._lastMiniEvent = { key: miniEventKey, time: Date.now() };
              if (this.onMiniJackpot) {
                this.onMiniJackpot({
                  nickname: content.nickname,
                  prize: content.value,
                  parsedValue,
                  time: new Date(),
                });
              }
            }
            
            // Lấy Grand JP hiện tại = mốc Mini nổ
            const miniPoolValue = this.jackpot || 0;
            console.log(`[JackpotMonitor] 📊 Grand JP hiện tại: ${miniPoolValue} FC → Mini nổ ở mốc này`);
            
            // Chỉ xử lý Mini trong range 10k-14k
            if (miniPoolValue >= 10000 && miniPoolValue < 14000) {
              const bustRange = Math.floor(miniPoolValue / 1000);
              console.log(`[JackpotMonitor] 🎯 Mini nổ ở mốc ${bustRange}k (${miniPoolValue} FC) → Xử lý bust`);
              this._handleMiniBust(miniPoolValue, 0);
            } else if (miniPoolValue >= 14000) {
              console.log(`[JackpotMonitor] ⚠️ Mini nổ ở ${miniPoolValue} FC (>14k) → Không tracking`);
            } else {
              console.log(`[JackpotMonitor] ⏭️ Mini nổ ở ${miniPoolValue} FC (<10k) → Skip (chờ đạt 10k+)`);
            }
            return;
          }

          // === FORMAT CŨ (VQSC) - giữ lại để tương thích ===
          // 42["message",{"type":"jackpot_change","data":{"jackpotValue":9387}}]
          const legacy = packet?.content || packet;

          if (legacy?.type === "jackpot_win") {
            const event = legacy.data || {};
            const jackpotValue = event.jackpotValue;
            const winValue = event.winValue;
            const nickname = event.user?.name || event.user?.uid;

            // Cập nhật hũ trước để tạo mốc reset; winner bên dưới sẽ được ghép
            // với mốc này để broadcast đúng người trúng hũ.
            if (typeof jackpotValue === "number" && jackpotValue > 0) {
              this._setJackpot(jackpotValue);
            }

            if (nickname && typeof winValue === "number" && winValue > 0) {
              const prize = `${winValue.toLocaleString("vi-VN")} FC`;
              const bustKey = `${nickname}_${winValue}`;
              if (bustKey !== this._lastBustKey) {
                this._lastBustKey = bustKey;
                this._latestJackpotWin = {
                  nickname,
                  prize,
                  parsedValue: winValue,
                  resetValue: jackpotValue,
                  time: Date.now(),
                };
                const winnerEvent = { nickname, prize, time: new Date() };
                if (!this._emitWinnerAfterRecentReset(winnerEvent)) {
                  this._pendingWinner = winnerEvent;
                }
                if (this.onOwnJackpot) {
                  this.onOwnJackpot({ nickname, prize, parsedValue: winValue });
                }
              }
            }
            return;
          }

          if (legacy?.type === "jackpot_win_mini") {
            const event = legacy.data || {};
            const jackpotValue = event.jackpotValue;
            const winValue = event.winValue;
            const nickname = event.user?.name || event.user?.uid;

            if (typeof jackpotValue === "number" && jackpotValue > 0) {
              this._setMiniJackpot(jackpotValue);
            }
            if (nickname && typeof winValue === "number" && winValue > 0) {
              const prize = `${winValue.toLocaleString("vi-VN")} FC`;
              const miniEventKey = `${nickname}_${winValue}`;
              const isDuplicate = this._lastMiniEvent?.key === miniEventKey
                && Date.now() - this._lastMiniEvent.time < 30000;
              if (!isDuplicate) {
                this._lastMiniEvent = { key: miniEventKey, time: Date.now() };
                if (this.onMiniJackpot) {
                  this.onMiniJackpot({ nickname, prize, parsedValue: winValue, time: new Date() });
                }
              }
            }
            return;
          }

          if (legacy && legacy.type === "jackpot_change" && legacy.data?.jackpotValue) {
            const val = legacy.data.jackpotValue;
            if (val > 0) {
              this._setJackpot(val);
              return;
            }
          }

          // 42["message",{"type":"prize_change","data":{"jackpot_prize":9387}}]
          if (legacy && legacy.type === "prize_change" && legacy.data?.jackpot_prize) {
            const val = legacy.data.jackpot_prize;
            if (val > 0) {
              this._setJackpot(val);
              return;
            }
          }
        }
      } catch (_) {}
    }
  }

  _cleanup() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  // Fallback: poll API nếu WS không kết nối được
  async _pollFallback() {
    while (this.running) {
      try {
        const response = await this._fetchWithCookieFallback(`${BASE_URL}${event.jackpotPath}`, {
          method: "GET",
          headers: this._headers(),
        });

        if (response.ok) {
          const res = await response.json();
          const data = res?.payload ?? res;
          const val = event.jackpot ? event.jackpot(data) : data?.jackpot_value ?? data?.jackpotValue;
          if (typeof val === "number" && val > 0) {
            this._setJackpot(val);
          }
        }
      } catch (_) {}

      await new Promise(r => setTimeout(r, 3000));
    }
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

  async _fetchWithCookieFallback(url, options) {
    let response = await fetch(url, options);
    if ((response.status === 401 || response.status === 403) && this.rotateCookie()) {
      response = await fetch(url, { ...options, headers: this._headers() });
    }
    return response;
  }
}

const monitor = new JackpotMonitor();
module.exports = { jackpotMonitor: monitor };
