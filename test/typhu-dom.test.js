const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

for (const file of ['vgtc-bot.js', 'typhu-bot.js']) {
  test(`${file}: supplied jackpot/wallet selectors and disabled paid spin`, () => {
    let disabled = true;
    const button = {
      querySelector: () => ({ textContent: '190FC' }),
      matches: () => disabled,
    };
    const document = {
      querySelector(selector) {
        if (selector === '.spin__block__item--21.special .text-special') return { innerText: '3.383 FC' };
        if (selector === '.spin__actions__plays') return { querySelector: () => button };
        return null;
      },
      querySelectorAll(selector) {
        return selector === '.spin__actions__user-money span'
          ? [{ textContent: 'MC Có: 0 MC' }, { textContent: 'FC Có: 126 FC' }] : [];
      },
    };
    let source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    source = source.slice(0, source.indexOf('  if (!myName) myName ='))
      + 'window.readers = { getFcBalance, getJackpotValue, findSpinButton }; })();';
    const context = { window: {}, document, console, getComputedStyle: () => ({ pointerEvents: 'auto' }) };
    vm.runInNewContext(source, context);
    const readers = context.window.readers;
    assert.equal(readers.getFcBalance(), 126);
    assert.equal(readers.getJackpotValue(), 3383);
    assert.equal(readers.findSpinButton(), null);
    disabled = false;
    assert.equal(readers.findSpinButton(), button);
  });
}
