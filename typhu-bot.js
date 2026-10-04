(() => {
  // Standalone browser-console bot for typhu.fconline.garena.vn.
  window.stopTyphuBot?.();
  const CONFIG = {
    MIN_JACKPOT: 13500,        // 🎯 [CẤU HÌNH] Đạt mốc FC này là bắt đầu xả đạn
    MAX_JACKPOT: 16500,        // 🎯 [CẤU HÌNH] Dừng quay khi hũ vượt mốc này
    FC_PER_CLICK: 190,
    MAX_FC_TO_SPEND: 0,
    STOP_ON_JACKPOT_RESET: false,
    RESET_DROP_PERCENT: 0.5,
    POPUP_WAIT_MS: 350,
    POPUP_VISIBLE_MS: 350,
    SPIN_INTERVAL_MS: 350,
    MY_USERNAME: "",
    DEBUG: true,
  };

  let running = true;
  let lastWinnerText = "";
  let myName = CONFIG.MY_USERNAME;
  let startFc = null;
  let prevJackpot = 0;
  let lastLoggedJp = -1;
  let freeSpinExhausted = false; // set true khi bấm free mà không có phản hồi (hết lượt)
  let freeSpinFailStreak = 0;

  const stats = { clicks: 0, fcSpentEst: 0, fcSpentReal: 0, fullJackpot: 0, miniJackpot: 0 };
  const log = (...a) => CONFIG.DEBUG && console.log("[TYPHU]", ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function detectMyUsername() {
    // HTML mới: <div class="_header__info_n2quk_2196">HI<span class="nickname">fco349872</span></div>
    // HTML cũ: <div class="_header__info__name_ap7cy_2121">Hi <span class="nickname">gBFwRo6WPLqbt6UT</span>...</div>
    const nick = document.querySelector('[class*="header__info"] .nickname, .nickname');
    if (nick) {
      const t = (nick.innerText || "").trim();
      if (t) return t;
    }
    for (const n of document.querySelectorAll("a, span, div, li")) {
      const m = (n.innerText || "").trim().match(/^Hi\s+([^\s|]+)/);
      if (m && m[1].length <= 30) return m[1].trim();
    }
    return "";
  }

  // Số dư FC:
  // HTML mẫu: <div class="spin__play__info-money"><div>FC: 2.756 <a>...</a></div><div>MC: 0 <a>...</a></div></div>
  // Hoặc cũ: <div class="spin__actions__user-money"><span>FC Có: 2.566 FC</span></div>
  // Hoặc: <div class="_top-up__left_..."><p>FC: 2.756 <a>...</a></p></div>
  function getFcBalance() {
    for (const span of document.querySelectorAll('.spin__actions__user-money span')) {
      const match = (span.textContent || '').match(/^FC\s*Có:\s*([\d.,]+)\s*FC/i);
      if (match) return Number(match[1].replace(/[.,]/g, ''));
    }
    // Mới nhất: _spin-action__wallet_ chứa 2 item (FC, MC), phân biệt bằng background-image fc-bg.png/mc-bg.png
    // HTML: <div class="_spin-action__wallet_..."><div class="_spin-action__wallet-item_..." style="background-image: url(&quot;/images/fc-bg.png&quot;);"><span class="_spin-action__wallet-value_...">2.576</span></div>...</div>
    const wallet = document.querySelector('[class*="spin-action__wallet"]');
    if (wallet) {
      for (const item of wallet.querySelectorAll('[class*="wallet-item"]')) {
        const bg = item.getAttribute("style") || "";
        if (/fc-bg/i.test(bg)) {
          const val = item.querySelector('[class*="wallet-value"]');
          if (val) {
            const v = parseInt((val.innerText || "").replace(/\./g, "").replace(/,/g, ""), 10);
            if (!isNaN(v)) return v;
          }
        }
      }
    }

    // Mới: spin__play__info-money
    const infoMoney = document.querySelector('.spin__play__info-money, [class*="spin__play__info-money"]');
    if (infoMoney) {
      for (const div of infoMoney.querySelectorAll("div")) {
        const m = (div.innerText || "").match(/^FC:\s*([\d.,]+)/i);
        if (m) {
          const v = parseInt(m[1].replace(/\./g, "").replace(/,/g, ""), 10);
          if (!isNaN(v)) return v;
        }
      }
    }

    let el = document.querySelector('[class*="user-money"] span');
    if (el) {
      const m = (el.innerText || "").match(/([\d.]+)/);
      if (m) {
        const v = parseInt(m[1].replace(/\./g, ""), 10);
        if (!isNaN(v)) return v;
      }
    }

    for (const p of document.querySelectorAll('[class*="top-up__left"] p, [class*="info-money"] div')) {
      const m = (p.innerText || "").match(/^FC:\s*([\d.,]+)/i);
      if (m) {
        const v = parseInt(m[1].replace(/\./g, "").replace(/,/g, ""), 10);
        if (!isNaN(v)) return v;
      }
    }

    return null;
  }

  function parseCellFc(el) {
    if (!el) return NaN;
    const m = (el.innerText || "").match(/([\d.]+)\s*FC/i);
    return m ? parseInt(m[1].replace(/\./g, ""), 10) : NaN;
  }

  // Hũ = ô Ultimate Prize
  // HTML mẫu mới: <div class="_jackpot__item_12bkw_2073"><span>4.753  FC</span></div>
  // HTML cũ: <div class="_jackpot-value__item_1wpdg_2105"><span>3.829  FC</span></div>
  function getJackpotValue() {
    const typhu = document.querySelector('.spin__block__item--21.special .text-special');
    if (typhu) {
      const value = parseCellFc(typhu);
      return Number.isFinite(value) ? value : 0;
    }
    // Mới nhất: <div class="_jackpot-value_dicvt_2131"><div class="_jackpot-value__item_dicvt_2141"><span>8.093 FC</span></div></div>
    let v = parseCellFc(document.querySelector('[class*="jackpot-value__item"] span'));
    if (!isNaN(v) && v > 0) return v;

    // Mới: jackpot__item (không có "value")
    v = parseCellFc(document.querySelector('[class*="jackpot__item"] span'));
    if (!isNaN(v) && v > 0) return v;

    // Cũ: jackpot-value__item
    v = parseCellFc(document.querySelector('[class*="jackpot-value__item"] span, [class*="jackpot-value"] span'));
    if (!isNaN(v) && v > 0) return v;

    v = parseCellFc(document.querySelector('[class*="spin__block__item--21"] [class*="text-special"]'));
    if (!isNaN(v) && v > 0) return v;

    let max = 0;
    for (const el of document.querySelectorAll('[class*="spin__block__item"][class*="special"] [class*="text-special"]')) {
      const n = parseCellFc(el);
      if (!isNaN(n) && n > max) max = n;
    }
    return max;
  }

  // HTML mẫu mới nhất:
  // <div class="_jackpot-congrat_1xua2_2131"><div class="_jackpot-congrat__item_1xua2_2138">Chúc mừng HLV <strong>Vân Mây</strong> đã trúng Ultimate Prize 12.348</div></div>
  // HTML mẫu mới:
  // <div class="jackpot-congrat__info">Chúc mừng HLV <strong>VmYOXNjzo</strong> đã trúng Ultimate Prize 12.199 FC</div>
  // HTML cũ:
  // <div class="_jackpot-congrat__item_cdyny_2105">...<div class="...item-content...">Chúc mừng HLV <strong>...</strong> đã trúng Ultimate Prize 10.143 FC</div></div>
  const normSpace = (s) => s.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();

  const seenWinners = new Set();
  function detectWinner() {
    for (const el of document.querySelectorAll('[class*="jackpot-congrat__info"], [class*="jackpot-congrat__item"]')) {
      const text = normSpace(el.innerText || el.textContent || '');
      if (!/Ultimate Prize|Mini Prize/.test(text) || seenWinners.has(text)) continue;
      seenWinners.add(text);
      if (seenWinners.size > 100) seenWinners.delete(seenWinners.values().next().value);
      const winner = normSpace(el.querySelector('strong')?.textContent || '');
      const mini = text.includes('Mini Prize');
      log(mini ? 'MINI PRIZE:' : 'ULTIMATE PRIZE:', winner, text);
      if (myName && winner === normSpace(myName)) {
        if (mini) { stats.miniJackpot++; }
        else { stats.fullJackpot++; stop('CHÍNH ACC NÀY NỔ HŨ'); }
      }
    }
  }
  // Nút quay 190FC
  // HTML mẫu mới: <div class="spin__play__mid"><a href="#"><img src="/images/spin10.png"><span>190 FC</span></a>...</div>
  // HTML cũ: <a class="btn-spin btn-spin--10"><span class="paid">190FC</span><span>10 lần</span></a>
  // Hoặc: <a class="_spin-play-type__btn_4biif_2121 _btn-10_4biif_2176"><span>190 FC</span>10 lần</a>
  // Tìm nút "Chơi miễn phí 10 lần" (spin10) để click tiêu lượt free
  // HTML: <a href="#"><img src="/images/spin10.png"><span class="free">Chơi miễn phí</span></a>
  function findFreeSpinButton() {
    const actions = document.querySelector('.spin__actions__plays');
    if (actions) {
      const remaining = document.querySelector('.spin__actions__free-spin')?.textContent.match(/:\s*(\d+)/);
      const button = actions.querySelector('a.btn-spin--1');
      return remaining && Number(remaining[1]) > 0 && button?.querySelector('.free')
        && buttonAvailable(button) ? button : null;
    }
    // Mới nhất: nút quay free không có text, nhận diện qua background-image btn-spin-free.png
    // HTML: <a class="_spin-action__spin_..." style="...background-image: url(&quot;/images/btn-spin-free.png&quot;);"></a>
    const btnsWrap = document.querySelector('[class*="spin-action__buttons"]');
    if (btnsWrap) {
      for (const a of btnsWrap.querySelectorAll('a[class*="spin-action__spin"]')) {
        if (/btn-spin-free/i.test(a.getAttribute("style") || "")) return a;
      }
    }

    const mid = document.querySelector('.spin__play__mid, [class*="spin__play__mid"]');
    if (!mid) return null;
    const links = mid.querySelectorAll("a");
    for (const a of links) {
      // Tìm nút có img spin10
      const img = a.querySelector('img[src*="spin10"]');
      if (!img) continue;
      // Kiểm tra có span.free hoặc text "miễn phí"
      const freeSpan = a.querySelector("span.free");
      if (freeSpan) return a;
      // Fallback: check text
      const spans = a.querySelectorAll("span");
      for (const s of spans) {
        const txt = s.textContent.replace(/\s+/g, " ").trim().toLowerCase();
        if (txt.includes("miễn phí")) return a;
      }
    }
    return null;
  }

  function findSpinButton() {
    const actions = document.querySelector('.spin__actions__plays');
    if (actions) {
      const button = actions.querySelector('a.btn-spin--10');
      const price = button?.querySelector('.paid')?.textContent.replace(/\s/g, '');
      return price === '190FC' && buttonAvailable(button) ? button : null;
    }
    // Mới nhất: <div class="_spin-action__buttons_..."><a class="_spin-action__spin_..."><span class="_spin-action__spin-title_...">180FC</span></a>...</div>
    const btnsWrap = document.querySelector('[class*="spin-action__buttons"]');
    if (btnsWrap) {
      for (const s of btnsWrap.querySelectorAll('[class*="spin-action__spin-title"]')) {
        if (s.textContent.replace(/\s+/g, "").match(/^180FC$/i)) {
          return s.closest("a");
        }
      }
    }

    // Mới: spin__play__mid chứa các <a> với <span>190 FC</span> (bản cũ hơn dùng 190FC)
    const mid = document.querySelector('.spin__play__mid, [class*="spin__play__mid"]');
    if (mid) {
      const spans = mid.querySelectorAll("a span");
      for (const s of spans) {
        if (s.textContent.replace(/\s+/g, "").match(/^180FC$|^190FC$/i)) {
          return s.closest("a");
        }
      }
    }

    // Cũ
    let btn = document.querySelector('a[class*="btn-spin--10"], a[class*="btn-10"]');
    if (btn) return btn;
    const span = [...document.querySelectorAll('a[class*="btn-spin"] span, a[class*="spin-play-type__btn"] span')]
      .find((s) => s.textContent.replace(/\s+/g, "").match(/^180FC$|^190FC$/i));
    return span ? span.closest("a") : null;
  }

  function selectPaidSpin() {
    const wrap = document.querySelector('.spin__actions__voucher-spin');
    const voucher = wrap?.querySelector('a.btn-voucher-spin');
    const progress = wrap?.querySelector('.total-spin-used p')?.textContent.match(/(\d+)\s*\/\s*(\d+)/);
    const used = voucher?.textContent.match(/Đã sử dụng\s*(\d+)\s*\/\s*(\d+)/i);
    // Read direct text only: the nested span contains the crossed-out 190 price.
    const priceText = [...(voucher?.querySelector('p')?.childNodes || [])]
      .filter(node => node.nodeType === 3).map(node => node.textContent).join(' ');
    const price = priceText.match(/(\d+)\s*FC\s*\//i);
    if (voucher && buttonAvailable(voucher) && progress && Number(progress[2]) > 0
      && Number(progress[1]) >= Number(progress[2]) && used && Number(used[1]) < Number(used[2])
      && price && Number(price[1]) === 100) {
      return { button: voucher, cost: 100, label: 'Voucher 100 FC / 10 lần' };
    }
    const button = findSpinButton();
    return button ? { button, cost: CONFIG.FC_PER_CLICK, label: '190 FC / 10 lần' } : null;
  }

  function buttonAvailable(el) {
    return el && !el.matches('.locked, .disable, .disabled, [disabled], [aria-disabled="true"]')
      && getComputedStyle(el).pointerEvents !== 'none';
  }

  function fireClick(el) {
    const opts = { bubbles: true, cancelable: true, view: window };
    try { el.dispatchEvent(new PointerEvent("pointerdown", opts)); } catch (e) {}
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    try { el.dispatchEvent(new PointerEvent("pointerup", opts)); } catch (e) {}
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  }

  function clickSpin() {
    if (!running) return false;
    const choice = selectPaidSpin();
    if (!choice) { log('Chờ nút voucher hoặc nút 190 FC mở'); return false; }
    const { button: btn, cost, label } = choice;
    const fc = getFcBalance();
    if (fc == null || fc < cost) {
      stop('Số dư FC không đủ hoặc chưa đọc được');
      return false;
    }
    if (CONFIG.MAX_FC_TO_SPEND > 0 && stats.fcSpentEst + cost > CONFIG.MAX_FC_TO_SPEND) {
      stop('Chạm giới hạn chi tiêu');
      return false;
    }
    if (!buttonAvailable(btn)) return false;
    const payment = document.querySelector('.spin__actions__payment-type');
    if (payment && ![...payment.querySelectorAll('a')].some(link =>
      link.querySelector('strong')?.textContent.trim() === 'FC' && link.querySelector('img[src$="/checked.png"]'))) {
      stop('Hãy chọn Chơi bằng FC trước khi chạy bot');
      return false;
    }
    fireClick(btn);
    stats.clicks++;
    stats.fcSpentEst += cost;
    log('Đã bấm:', label);
    return true;
  }

  function popupOpen() {
    const sw = document.querySelector(".swal2-popup.swal2-modal");
    if (sw && getComputedStyle(sw).display !== "none") return true;
    if (document.querySelector(".ReactModal__Overlay--after-open")) return true;
    return !!document.querySelector(".modal-received-gifts, .modal-received-gift");
  }

  // Bỏ dấu tiếng Việt để so khớp text không phụ thuộc font/encoding
  function normalizeVN(s) {
    return (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  }

  // Banner đỏ: "Bạn đã hết lượt quay miễn phí" - đây là toast, không khớp popupOpen()
  // nên phải detect riêng bằng nội dung text.
  function hasFreeSpinExhaustedToast() {
    const text = normalizeVN(document.body.innerText || "");
    return text.includes("het luot quay mien phi") || text.includes("het luot mien phi");
  }

  // Chờ tối đa maxMs để xác định kết quả sau khi bấm nút free:
  // "exhausted" = banner báo hết lượt free, "popup" = có popup thưởng thật, "none" = không có gì
  async function waitForFreeSpinResult(maxMs) {
    const start = Date.now();
    while (Date.now() - start < maxMs && running) {
      if (hasFreeSpinExhaustedToast()) return "exhausted";
      if (popupOpen()) return "popup";
      await sleep(80);
    }
    return "none";
  }

  // Cờ chống việc gọi forceClosePopup() nhiều lần liên tiếp trong lúc modal
  // đang trong quá trình transition đóng (chưa unmount khỏi DOM). Nếu không có
  // cờ này, loop() có thể gọi hàm này (và trigger requestClose) hàng chục lần/giây,
  // khiến React gọi API (VD: claim_accumulate) lặp lại liên tục -> 429/400.
  let closingPopup = false;

  // HTML: <div class="ReactModal__Content ... modal-history"><div class="modal-description">
  //   <h2>Lịch sử nhận quà</h2>...<table class="table-history">...</table>...</div></div>
  // Modal Lịch sử không có nút đóng trong nội dung. Theo stack trace thực tế
  // (Y.A.handleOverlayOnClick), cách đóng đúng là CLICK vào chính overlay
  // (react-modal chỉ đóng khi event.target === overlay, không phải Escape).
  function forceClosePopup() {
    if (closingPopup) return; // đang trong quá trình đóng, chờ modal biến mất hẳn

    const popup = document.querySelector(".swal2-popup.swal2-modal");
    if (popup && getComputedStyle(popup).display !== "none") {
      const msg = popup.querySelector(".swal2-html-container")?.innerText.trim() || "";
      closingPopup = true;
      (popup.querySelector(".swal2-confirm") || popup.querySelector(".swal2-close"))?.click();
      log("Đóng popup:", msg || "thông báo");
      if (/không đủ FC/i.test(msg)) stop("hết FC");
      setTimeout(() => { closingPopup = false; }, 400);
      return;
    }

    const overlay = document.querySelector(".ReactModal__Overlay--after-open");
    if (overlay) {
      const isHistoryModal = !!overlay.querySelector('[class*="modal-history"], [class*="received-gifts"], [class*="btn-his"]');
      if (isHistoryModal) log("Đóng popup: Lịch sử quà tặng");

      closingPopup = true;
      const closeBtn = overlay.querySelector('[class*="close"], [class*="btn-close"], button[aria-label*="lose"], button[aria-label*="óng"]');
      if (closeBtn) {
        closeBtn.click();
      } else {
        // Click trực tiếp vào overlay (không phải bên trong content) để trigger
        // handleOverlayOnClick của react-modal. Đây là cách đóng thật đã xác nhận qua log.
        const opts = { bubbles: true, cancelable: true, view: window };
        overlay.dispatchEvent(new MouseEvent("mousedown", opts));
        overlay.dispatchEvent(new MouseEvent("mouseup", opts));
        overlay.dispatchEvent(new MouseEvent("click", opts));
      }
      // Đợi transition đóng xong (site dùng animation swing-in/out) trước khi cho phép gọi lại
      setTimeout(() => { closingPopup = false; }, 600);
    }
  }

  const inSpinZone = (jp) => jp > 0 && jp >= CONFIG.MIN_JACKPOT && (CONFIG.MAX_JACKPOT === 0 || jp <= CONFIG.MAX_JACKPOT);
  const jackpotReset = (o, n) => o > 0 && n > 0 && n < o * CONFIG.RESET_DROP_PERCENT;
  const budgetExceeded = () => CONFIG.MAX_FC_TO_SPEND > 0 && stats.fcSpentEst >= CONFIG.MAX_FC_TO_SPEND;

  function stop(reason) {
    if (!running) return;
    running = false;
    const realFc = getFcBalance();
    if (startFc != null && realFc != null) stats.fcSpentReal = startFc - realFc;
    log(`===== DỪNG BOT (${reason}) =====`);
    log(`Acc: ${myName || "?"} | ${stats.clicks} lần bấm | tiêu thật ~${stats.fcSpentReal} FC (ước tính ${stats.fcSpentEst}) | nổ full: ${stats.fullJackpot}`);
  }

  async function waitForPopup(maxMs) {
    const start = Date.now();
    while (Date.now() - start < maxMs && running) {
      if (popupOpen()) return true;
      await sleep(100);
    }
    return false;
  }

  async function spinCycle(jackpot) {
    if (popupOpen()) { forceClosePopup(); await sleep(150); }
    if (!clickSpin()) { await sleep(500); return; }
    log(`SPIN #${stats.clicks} @ hũ ${jackpot}`);

    if (await waitForPopup(CONFIG.POPUP_WAIT_MS)) {
      await sleep(CONFIG.POPUP_VISIBLE_MS);
      detectWinner();
      if (!running) return;
      forceClosePopup();
    }
    await sleep(CONFIG.SPIN_INTERVAL_MS);
  }

  async function loop() {
    while (running) {
      if (popupOpen()) { forceClosePopup(); await sleep(200); continue; }

      detectWinner();
      if (!running) return;
      const jackpot = getJackpotValue();

      if (jackpot !== lastLoggedJp) {
        const fcNow = getFcBalance();
        log(`HŨ: ${jackpot} FC | Số dư: ${fcNow != null ? fcNow + " FC" : "?"} ${inSpinZone(jackpot) ? "-> QUAY" : jackpot < CONFIG.MIN_JACKPOT ? "-> chờ tới " + CONFIG.MIN_JACKPOT : "-> vượt " + CONFIG.MAX_JACKPOT + ", chờ"}`);
        lastLoggedJp = jackpot;
      }

      // Nếu có lượt miễn phí -> click tiêu hết lượt free trước
      // Lưu ý: nút free luôn tồn tại trong DOM (không bị xóa/đổi ảnh khi hết lượt),
      // nên phải tự phát hiện "hết free" bằng việc bấm mà không có popup phản hồi.
      const freeBtn = !freeSpinExhausted && findFreeSpinButton();
      if (freeBtn) {
        fireClick(freeBtn);
        const result = await waitForFreeSpinResult(CONFIG.POPUP_WAIT_MS);

        if (result === "exhausted") {
          freeSpinExhausted = true;
          log(`Banner "hết lượt quay miễn phí" -> chuyển sang quay ${CONFIG.FC_PER_CLICK}FC`);
          // Tự kiểm tra lại free spin sau 5 phút (phòng trường hợp được cấp lượt mới, ví dụ theo ngày)
          setTimeout(() => {
            freeSpinExhausted = false;
            freeSpinFailStreak = 0;
            log(`Kiểm tra lại lượt miễn phí...`);
          }, 5 * 60 * 1000);
          // Không continue -> rơi xuống nhánh quay trả phí ở dưới trong cùng vòng loop
        } else if (result === "popup") {
          freeSpinFailStreak = 0;
          log(`FREE SPIN click (tiêu lượt miễn phí)`);
          await sleep(CONFIG.POPUP_VISIBLE_MS);
          detectWinner();
          forceClosePopup();
          await sleep(CONFIG.SPIN_INTERVAL_MS);
          continue;
        } else {
          freeSpinFailStreak++;
          log(`FREE SPIN click không có phản hồi (lần ${freeSpinFailStreak})`);
          if (freeSpinFailStreak >= 3) {
            freeSpinExhausted = true;
            log(`Free spin liên tục không phản hồi -> chuyển sang quay ${CONFIG.FC_PER_CLICK}FC`);
            setTimeout(() => {
              freeSpinExhausted = false;
              freeSpinFailStreak = 0;
              log(`Kiểm tra lại lượt miễn phí...`);
            }, 5 * 60 * 1000);
          }
          // Không continue -> rơi xuống nhánh quay trả phí ở dưới trong cùng vòng loop
        }
      }

      if (CONFIG.STOP_ON_JACKPOT_RESET && jackpotReset(prevJackpot, jackpot)) {
        stop("HŨ ĐÃ NỔ (reset)");
        break;
      }
      prevJackpot = jackpot;

      if (budgetExceeded()) { stop("chạm trần ngân sách"); break; }

      if (inSpinZone(jackpot)) {
        await spinCycle(jackpot);
      } else {
        await sleep(500);
      }
    }
  }

  window.stopTyphuBot = () => stop("dừng thủ công");
  window.typhuStats = () => {
    const realFc = getFcBalance();
    if (startFc != null && realFc != null) stats.fcSpentReal = startFc - realFc;
    const fcNet = (startFc != null && realFc != null) ? realFc - startFc : null;
    return { ...stats, currentFc: realFc, startFc, fcNet };
  };

  if (!myName) myName = detectMyUsername();
  startFc = getFcBalance();

  log("BOT KHỞI ĐỘNG");
  log(`Username: ${myName || "KHÔNG LẤY ĐƯỢC (điền tay MY_USERNAME)"}`);
  log(`FC hiện tại: ${startFc != null ? startFc : "KHÔNG ĐỌC ĐƯỢC"}`);
  log(`Spam từ ${CONFIG.MIN_JACKPOT} đến ${CONFIG.MAX_JACKPOT} | Dừng khi hũ nổ: ${CONFIG.STOP_ON_JACKPOT_RESET}`);
  log("stopTyphuBot() để dừng | typhuStats() để xem thống kê");
  loop();
})();
