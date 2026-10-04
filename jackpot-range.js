function validateRange({ minJackpot, maxJackpot }) {
  if (!Number.isSafeInteger(minJackpot) || minJackpot < 0
    || !Number.isSafeInteger(maxJackpot) || maxJackpot < 0
    || (maxJackpot !== 0 && maxJackpot < minJackpot)) {
    throw new Error('Min/Max phải là số nguyên không âm; Max phải >= Min hoặc bằng 0 (không giới hạn).');
  }
  return { minJackpot, maxJackpot };
}

class JackpotRanges {
  constructor(range) { this.shared = validateRange(range); }
  updateShared(range, workers) {
    this.shared = validateRange(range);
    for (const worker of workers) {
      if (!worker.customJackpotRange) worker.applyConfig(this.shared);
    }
  }
  configureWorker(worker, input) {
    if (typeof input.enabled !== 'boolean') throw new Error('Tùy chọn khoảng riêng không hợp lệ.');
    const range = input.enabled ? validateRange(input) : this.shared;
    worker.applyConfig(range);
    worker.customJackpotRange = input.enabled;
  }
}

module.exports = { JackpotRanges, validateRange };
