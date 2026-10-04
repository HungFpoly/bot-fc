async function loginPool(accounts, concurrency, login) {
  const size = Number.isInteger(concurrency) && concurrency > 0 ? concurrency : 3;
  const results = new Array(accounts.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, accounts.length) }, async () => {
    while (next < accounts.length) {
      const index = next++;
      const item = accounts[index];
      const account = item.acc || item;
      let result;
      try { result = await login(account.username, account.password); }
      catch (error) { result = { success: false, error: error.message }; }
      results[index] = { ...item, result };
    }
  }));
  return results;
}

async function closeLoginBrowser(browser, timeoutMs = 5000) {
  if (!browser) return;
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => browser.close()),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Close timeout')), timeoutMs); }),
    ]);
  } catch (_) {
    // Only terminate the Chrome process owned by this login attempt.
    try {
      const child = browser.process();
      if (child && child.exitCode === null) child.kill();
    } catch (_) { /* Cleanup must not reject the login result. */ }
  } finally { clearTimeout(timer); }
}

module.exports = { loginPool, closeLoginBrowser };
