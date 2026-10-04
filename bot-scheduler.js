class BotScheduler {
  constructor(workers) {
    this.workers = workers;
    this.config = { queueEnabled: false, maxConcurrent: 3, spinGap: 100 };
    this.tail = Promise.resolve();
    this.lastDispatch = -Infinity;
    this.tracked = new Set();
  }

  configure(input = {}) {
    const next = { ...this.config };
    for (const key of Object.keys(next)) if (input[key] !== undefined) next[key] = input[key];
    if (typeof next.queueEnabled !== 'boolean'
      || !Number.isInteger(next.maxConcurrent) || next.maxConcurrent < 1 || next.maxConcurrent > 1000
      || !Number.isInteger(next.spinGap) || next.spinGap < 0 || next.spinGap > 60000) {
      throw new Error('Cấu hình hàng đợi không hợp lệ (1-1000 acc, 0-60000 ms).');
    }
    const busy = [...this.workers.values()].some(w => w.running || w.starting || w.queued || w._pendingSpins);
    if (busy && (next.queueEnabled !== this.config.queueEnabled || next.maxConcurrent !== this.config.maxConcurrent)) {
      throw new Error('Dừng tất cả trước khi đổi chế độ hàng đợi hoặc số acc đồng thời.');
    }
    this.config = next;
  }

  async enqueue(worker) {
    worker.scheduler = this;
    this.tracked.add(worker);
    if (worker.running || worker.starting || worker.queued) return true;
    worker.queued = true;
    await this.pump();
    return worker.running || worker.queued;
  }

  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (true) {
        const workers = [...this.workers.values()];
        for (const worker of this.tracked) {
          if (!this.workers.has(worker.id) && !worker.running && !worker.starting && !worker._pendingSpins) this.tracked.delete(worker);
        }
        const busy = [...this.tracked].filter(w => w.running || w.starting || w._pendingSpins).length;
        if (this.config.queueEnabled && busy >= this.config.maxConcurrent) break;
        const worker = workers.find(w => w.queued && !w.starting && !w._pendingSpins);
        if (!worker) break;
        worker.queued = false;
        try { await worker.start(); }
        catch (error) { worker.stop(); worker._log(error.message); }
      }
    } finally { this.pumping = false; }
  }

  // Serialize dispatch only, never the network response.
  dispatch(allowed, send) {
    const slot = this.tail.then(async () => {
      while (allowed()) {
        const delay = this.lastDispatch + this.config.spinGap - performance.now();
        if (delay <= 0) {
          this.lastDispatch = performance.now();
          return { response: send() };
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(delay, 100)));
      }
      return null;
    });
    this.tail = slot.then(() => {}, () => {});
    return slot.then(result => result ? result.response : null);
  }
}

module.exports = { BotScheduler };
