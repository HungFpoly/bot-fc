const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JackpotRanges } = require('../jackpot-range');

test('individual ranges survive shared updates and disabling restores latest shared range', () => {
  const ranges = new JackpotRanges({ minJackpot: 10000, maxJackpot: 15000 });
  const makeWorker = () => ({ config: {}, applyConfig(range) { Object.assign(this.config, range); } });
  const first = makeWorker(), second = makeWorker();
  ranges.configureWorker(first, { enabled: true, minJackpot: 5000, maxJackpot: 7000 });
  ranges.updateShared({ minJackpot: 12000, maxJackpot: 16000 }, [first, second]);
  assert.deepEqual(first.config, { minJackpot: 5000, maxJackpot: 7000 });
  assert.deepEqual(second.config, ranges.shared);
  ranges.configureWorker(first, { enabled: false });
  assert.deepEqual(first.config, ranges.shared);
  assert.equal(first.customJackpotRange, false);
});

test('invalid ranges do not mutate worker; zero maximum is unlimited', () => {
  const ranges = new JackpotRanges({ minJackpot: 0, maxJackpot: 0 });
  const worker = { applyConfig(range) { this.range = range; } };
  for (const range of [{ minJackpot: 5, maxJackpot: 4 }, { minJackpot: -1, maxJackpot: 0 },
    { minJackpot: 1.5, maxJackpot: 8 }, { minJackpot: 1, maxJackpot: null }]) {
    assert.throws(() => ranges.configureWorker(worker, { enabled: true, ...range }));
    assert.equal(worker.range, undefined);
  }
  ranges.configureWorker(worker, { enabled: true, minJackpot: 20000, maxJackpot: 0 });
  assert.equal(worker.range.maxJackpot, 0);
});
