const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('voucher at 5/5 takes priority; locked/exhausted vouchers fall back to 190 FC', () => {
  let locked = false, used = 0, progress = '5/5';
  const voucher = {
    get textContent() { return `190100FC/10 lần Đã sử dụng ${used}/2 lần`; },
    matches: () => locked,
    querySelector: () => ({ childNodes: [
      { nodeType: 1, textContent: '190' }, { nodeType: 3, textContent: ' 100FC/' },
      { nodeType: 1, textContent: '10 lần' },
    ] }),
  };
  const normal = { matches: () => false, querySelector: () => ({ textContent: '190FC' }) };
  const document = { querySelector: selector => {
    if (selector === '.spin__actions__voucher-spin') return { querySelector: s =>
      s === 'a.btn-voucher-spin' ? voucher : { textContent: progress } };
    if (selector === '.spin__actions__plays') return { querySelector: () => normal };
    return null;
  } };
  let source = fs.readFileSync(path.join(__dirname, '../typhu-bot.js'), 'utf8');
  source = source.slice(0, source.indexOf('  if (!myName) myName ='))
    + 'window.choose = selectPaidSpin; })();';
  const context = { window: {}, document, console, getComputedStyle: () => ({ pointerEvents: 'auto' }) };
  vm.runInNewContext(source, context);
  const choose = context.window.choose;
  assert.equal(choose().button, voucher);
  assert.equal(choose().cost, 100);
  used = 1;
  assert.equal(choose().cost, 100);
  used = 2;
  assert.equal(choose().button, normal);
  assert.equal(choose().cost, 190);
  used = 0; locked = true;
  assert.equal(choose().button, normal);
  locked = false; progress = '4/5';
  assert.equal(choose().button, normal);
});
