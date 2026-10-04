class TelegramNotifier {
  constructor({ token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID,
    fetchImpl = globalThis.fetch, logger = console, now = Date.now } = {}) {
    this.token = token?.trim();
    this.chatId = chatId?.trim();
    this.fetch = fetchImpl;
    this.logger = logger;
    this.now = now;
    this.recent = new Map();
  }

  async notify(win, eventName) {
    if (!this.token || !this.chatId) return false;
    const now = this.now();
    // Socket and spin responses do not share a win ID; use a short dedup window.
    for (const [key, time] of this.recent) if (now - time >= 10000) this.recent.delete(key);
    const key = JSON.stringify([win.accountName || win.id, win.type]);
    if (this.recent.has(key)) return false;
    this.recent.set(key, now);
    const text = [
      win.type === 'mini' ? 'TRUNG MINI JACKPOT!' : 'TRUNG JACKPOT!',
      `Su kien: ${eventName}`,
      `Acc: ${win.label || win.id} (${win.accountName || 'Chua ro ten'})`,
      `Giai thuong: ${win.prize || 'Chua co thong tin'}`,
      `FC con lai: ${win.fc ?? 'Chua ro'}`,
      `Thoi gian: ${new Date(now).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`,
    ].join('\n').slice(0, 4000);
    try {
      const response = await this.fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: this.chatId, text }),
        signal: AbortSignal.timeout(10000),
      });
      const result = await response.json();
      if (!response.ok || result.ok !== true) {
        this.logger.warn(`[Telegram] Gui thong bao that bai (HTTP ${response.status}, code ${Number(result.error_code) || 'unknown'}).`);
        return false;
      }
      return true;
    } catch (_) {
      // Do not log fetch errors: their URLs can contain the bot token.
      this.logger.warn('[Telegram] Khong gui duoc thong bao: loi ket noi hoac qua 10 giay.');
      return false;
    }
  }
}

function createTelegramNotifiers(env = process.env, options = {}) {
  return [
    new TelegramNotifier({ ...options, token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID }),
    new TelegramNotifier({ ...options, token: env.TELEGRAM_BOT_TOKEN_2 || '',
      chatId: env.TELEGRAM_CHAT_ID_2?.trim() || env.TELEGRAM_CHAT_ID || '' }),
  ];
}

module.exports = { TelegramNotifier, createTelegramNotifiers };
