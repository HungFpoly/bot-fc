/**
 * GarenaAuth - Đăng nhập Garena bằng Puppeteer + Stealth + Persistent Profile
 *
 * === SỰ KIỆN BILAC (MỚI) ===
 * TARGET_URL: https://bilac.fconline.garena.vn
 *
 * === SỰ KIỆN CŨ (VQSC) - GIỮ LẠI CHO SỰ KIỆN SAU ===
 * TARGET_URL: https://vqsc.fconline.garena.vn
 * SSO_LOGIN_URL cũ: "https://auth.garena.com/universal/oauth?platform=1&state=3gABpG5leHTZIGh0dHBzOi8vdnFzYy5mY29ubGluZS5nYXJlbmEudm4v&client_id=100072&response_type=code&redirect_uri=https%3A%2F%2Fvqsc.fconline.garena.vn%2Fconnect%2Fgarena%2Fcallback"
 * Session cookie: ff_session trên vqsc.fconline.garena.vn
 */

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const path = require("path");
const fs = require("fs");

puppeteer.use(StealthPlugin());

// === SỰ KIỆN SIEUXOAY (MỚI) ===
const { BASE_URL: TARGET_URL, TARGET_HOST, SSO_LOGIN_URL, SESSION_COOKIE } = require("./event-config");
const { closeLoginBrowser } = require('./login-pool');

// === SỰ KIỆN CŨ (VQSC) - comment lại ===
// const TARGET_URL  = "https://vqsc.fconline.garena.vn";
// const TARGET_HOST = "vqsc.fconline.garena.vn";
// const SSO_LOGIN_URL = "https://auth.garena.com/universal/oauth?platform=1&state=3gABpG5leHTZIGh0dHBzOi8vdnFzYy5mY29ubGluZS5nYXJlbmEudm4v&client_id=100072&response_type=code&redirect_uri=https%3A%2F%2Fvqsc.fconline.garena.vn%2Fconnect%2Fgarena%2Fcallback";
// const SESSION_COOKIE = "ff_session"; // VQSC dùng ff_session

// Profiles dir
let PROFILES_DIR;
try {
  const { app } = require("electron");
  PROFILES_DIR = path.join(app.getPath("userData"), "chrome-profiles");
} catch (_) {
  PROFILES_DIR = path.join(__dirname, "chrome-profiles");
}
if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });

// ── Helpers ──────────────────────────────────────────────

function humanDelay(min = 800, max = 2000) {
  return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
}

async function humanType(element, text) {
  await element.click({ clickCount: 3 });
  await humanDelay(200, 400);
  for (const char of text) {
    await element.type(char, { delay: 0 });
    await new Promise(r => setTimeout(r, 50 + Math.random() * 120));
  }
}

async function humanClick(page, element) {
  const box = await element.boundingBox();
  if (!box) return;
  const x = box.x + box.width / 2 + (Math.random() - 0.5) * 8;
  const y = box.y + box.height / 2 + (Math.random() - 0.5) * 4;
  await page.mouse.move(x, y, { steps: 8 + Math.floor(Math.random() * 10) });
  await humanDelay(80, 250);
  await page.mouse.click(x, y);
}

/**
 * Poll cookie trên TARGET_URL tối đa maxMs ms.
 * Dùng CDP để lấy cookie theo domain thay vì URL hiện tại của page,
 * vì trong lúc redirect page đang ở auth.garena.com chứ chưa về bilac.
 * Trả về cookie string nếu tìm thấy SESSION_COOKIE, null nếu timeout.
 */
async function pollForCookie(page, maxMs = 60000) {
  const start = Date.now();
  let attempt = 0;
  let _gotoedHome = false;

  while (Date.now() - start < maxMs) {
    if (page.isClosed() || !page.browser().isConnected()) return null;
    attempt++;

    // Nếu page đang stuck ở callback → tự goto trang chủ để hoàn tất login
    const currentUrl = page.url();
    if (!_gotoedHome && currentUrl.includes("/connect/garena/callback")) {
      _gotoedHome = true;
      console.log(`[Auth] Page đang ở callback, tự goto trang chủ...`);
      page.goto(TARGET_URL + "/", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 2000)); // chờ navigate xong
    }

    try {
      const client = await page.target().createCDPSession();
      const { cookies } = await client.send("Network.getCookies", { urls: [TARGET_URL] });
      await client.detach().catch(() => {});

      if (attempt % 5 === 1) {
        const names = cookies.map(c => c.name).join(", ") || "(trống)";
        const url = page.url().slice(0, 80);
        console.log(`[Auth] Poll #${attempt} | URL: ${url} | Cookies: ${names}`);
      }

      const found = cookies.find(c => c.name === SESSION_COOKIE);
      if (found) {
        return cookies.map(c => `${c.name}=${c.value}`).join("; ");
      }
    } catch (err) {
      const cookies = await page.cookies(TARGET_URL).catch(() => []);
      const found = cookies.find(c => c.name === SESSION_COOKIE);
      if (found) return cookies.map(c => `${c.name}=${c.value}`).join("; ");
    }

    await new Promise(r => setTimeout(r, 800));
  }
  return null;
}

// ── Main class ───────────────────────────────────────────

class GarenaAuth {
  static async login(username, password) {
    let browser = null;
    const profileDir = path.join(PROFILES_DIR, username.replace(/[^a-zA-Z0-9._-]/g, "_"));

    try {
      console.log(`[Auth] Mở Chrome (profile: ${username})...`);

      const isFirstTime = !fs.existsSync(path.join(profileDir, "Default"));
      if (isFirstTime) {
        console.log(`[Auth] ⚡ Lần đầu dùng profile`);
      } else {
        console.log(`[Auth] ♻️ Profile sẵn có`);
        const prefsFile = path.join(profileDir, "Default", "Preferences");
        if (fs.existsSync(prefsFile)) {
          try {
            const prefs = JSON.parse(fs.readFileSync(prefsFile, "utf8"));
            if (prefs.session) prefs.session.restore_on_startup = 5;
            if (prefs.profile) prefs.profile.exit_type = "Normal";
            prefs.startup_urls = [];
            fs.writeFileSync(prefsFile, JSON.stringify(prefs));
          } catch (_) {}
        }
      }

      // Detect Chrome path
      let chromePath;
      if (process.platform === "win32") {
        const paths = [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
        ];
        chromePath = paths.find(p => fs.existsSync(p));
        if (!chromePath) return { success: false, error: "Không tìm thấy Chrome trên máy Windows." };
      } else {
        chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
      }

      browser = await puppeteer.launch({
        protocolTimeout: 15000,
        timeout: 30000,
        headless: false,
        executablePath: chromePath,
        userDataDir: profileDir,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-blink-features=AutomationControlled",
          "--disable-features=IsolateOrigins,site-per-process",
          "--window-size=1366,768",
          "--disable-infobars",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-session-crashed-bubble",
          "--lang=vi-VN,vi,en-US,en",
        ],
        ignoreDefaultArgs: ["--enable-automation"],
        defaultViewport: null,
      });

      const allPages = await browser.pages();
      const page = allPages[0] || await browser.newPage();
      for (let i = 1; i < allPages.length; i++) await allPages[i].close().catch(() => {});
      await page.setViewport({ width: 1366, height: 768, deviceScaleFactor: 1 });

      // ── Tự động lấy cookie khi đến callback ──
      // Khi page navigate đến /connect/garena/callback, bilac server đã xử lý code
      // và set cookie ngay. Sau đó nó redirect về / nhưng puppeteer có thể bị stuck.
      // → Poll cookie ngay khi phát hiện callback URL, không cần chờ redirect xong.
      let _callbackSeen = false;
      page.on("framenavigated", async (frame) => {
        if (frame !== page.mainFrame()) return;
        const url = frame.url();
        if (!_callbackSeen && url.includes(TARGET_HOST) && url.includes("/connect/garena/callback")) {
          _callbackSeen = true;
          console.log(`[Auth] [${username}] Callback URL loaded — bilac đang set cookie...`);
          // Không làm gì thêm, pollForCookie đang chạy ngầm sẽ nhặt cookie
        }
      });

      // ── Step 1: Check session cũ ──
      console.log(`[Auth] [${username}] Kiểm tra session cũ...`);
      await page.goto(TARGET_URL + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
      await humanDelay(1500, 2500);

      let cookieStr = await pollForCookie(page, 3000);
      if (cookieStr) {
        console.log(`[Auth] ✅ [${username}] Session cũ vẫn còn!`);
        await closeLoginBrowser(browser);
        return { success: true, cookie: cookieStr, username };
      }

      // ── Step 2: Goto trang chủ bilac → nếu chưa login tự redirect sang SSO ──
      // KHÔNG goto SSO_LOGIN_URL trực tiếp vì code trong callback chỉ dùng được 1 lần
      // Flow đúng: bilac/ → (redirect) → auth.garena.com → (login) → bilac/callback → bilac/
      console.log(`[Auth] [${username}] Goto bilac để trigger SSO...`);
      await page.goto(TARGET_URL + "/", { waitUntil: "domcontentloaded", timeout: 30000 });
      await humanDelay(1500, 2500);

      // Nếu bilac không tự redirect sang SSO (session Garena còn), poll cookie ngay
      if (page.url().includes(TARGET_HOST) && !page.url().includes("auth.garena.com")) {
        cookieStr = await pollForCookie(page, 5000);
        if (cookieStr) {
          console.log(`[Auth] ✅ [${username}] Session Garena còn, cookie OK!`);
          await closeLoginBrowser(browser);
          return { success: true, cookie: cookieStr, username };
        }
      }

      // Nếu chưa redirect sang SSO, goto SSO_LOGIN_URL thủ công
      if (!page.url().includes("auth.garena.com")) {
        console.log(`[Auth] [${username}] Goto SSO login URL...`);
        // Dùng domcontentloaded thay vì networkidle2 để không bị timeout khi SSO redirect về bilac
        await page.goto(SSO_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
        await humanDelay(2000, 3000);
      }

      // Check DataDome block
      const isBlocked = await page.evaluate(() => {
        const t = document.body?.innerText || "";
        return t.includes("Access is temporarily restricted") || t.includes("unusual activity");
      }).catch(() => false);

      if (isBlocked) {
        console.log(`[Auth] ⚠️ [${username}] DataDome block! Chờ giải thủ công (3 phút)...`);
        try {
          await page.waitForFunction(
            () => {
              const t = document.body?.innerText || "";
              return !t.includes("Access is temporarily restricted") && !t.includes("unusual activity");
            },
            { timeout: 180000, polling: 2000 }
          );
          console.log(`[Auth] ✅ [${username}] Vượt DataDome!`);
          await humanDelay(2000, 3000);
        } catch (e) {
          await closeLoginBrowser(browser);
          return { success: false, error: "Hết thời gian chờ giải DataDome (3 phút)" };
        }
      }

      // ── Step 3: Chờ form ──
      console.log(`[Auth] [${username}] Chờ form đăng nhập...`);
      try {
        await page.waitForSelector('input[type="text"], input[type="email"]', { timeout: 15000 });
      } catch (e) {
        // Có thể đã redirect về bilac rồi, thử poll cookie
        cookieStr = await pollForCookie(page, 5000);
        if (cookieStr) {
          await closeLoginBrowser(browser);
          return { success: true, cookie: cookieStr, username };
        }
        await closeLoginBrowser(browser);
        return { success: false, error: `Không tìm thấy form login. URL: ${page.url()}` };
      }

      await humanDelay(800, 1500);
      await page.mouse.move(300 + Math.random() * 400, 200 + Math.random() * 150, { steps: 12 });
      await humanDelay(400, 800);

      // ── Step 4: Điền username ──
      console.log(`[Auth] [${username}] Điền username...`);
      const usernameInput = await page.$('input[type="text"], input[type="email"]');
      if (!usernameInput) {
        await closeLoginBrowser(browser);
        return { success: false, error: "Không tìm thấy ô tài khoản" };
      }
      await humanClick(page, usernameInput);
      await humanDelay(300, 500);
      await humanType(usernameInput, username);
      await humanDelay(600, 1200);

      // ── Step 5: Điền password ──
      console.log(`[Auth] [${username}] Điền password...`);
      const passwordInput = await page.$('input[type="password"]');
      if (!passwordInput) {
        await closeLoginBrowser(browser);
        return { success: false, error: "Không tìm thấy ô mật khẩu" };
      }
      await humanClick(page, passwordInput);
      await humanDelay(300, 500);
      await humanType(passwordInput, password);
      await humanDelay(800, 1500);

      // ── Step 6: Submit ──
      console.log(`[Auth] [${username}] Submit form...`);
      const submitBtn = await page.$('button[type="submit"], button.primary');
      submitBtn ? await humanClick(page, submitBtn) : await passwordInput.press("Enter");

      // ── Step 7: Poll cookie liên tục tối đa 90s ──
      // Không dùng waitForNavigation vì có nhiều hop redirect
      // Bot chỉ cần biết cookie xuất hiện trên domain bilac là xong
      console.log(`[Auth] [${username}] Chờ login hoàn tất (tối đa 90s)...`);
      cookieStr = await pollForCookie(page, 90000);

      if (cookieStr) {
        console.log(`[Auth] ✅ [${username}] Login thành công! URL hiện tại: ${page.url()}`);
        await closeLoginBrowser(browser);
        return { success: true, cookie: cookieStr, username };
      }

      // Hết 90s vẫn không có cookie → check lỗi
      let errorMsg = "";
      try {
        errorMsg = await page.evaluate(() => {
          return document.querySelector('.error-msg, [class*="error-message"]')?.textContent?.trim() || "";
        });
      } catch (_) {}

      await closeLoginBrowser(browser);
      return {
        success: false,
        error: errorMsg
          ? `Lỗi đăng nhập: ${errorMsg}`
          : `Login timeout 90s - URL cuối: ${page.url()}`,
      };

    } catch (err) {
      console.log(`[Auth] ❌ [${username}] Lỗi: ${err.message}`);
      if (browser) await closeLoginBrowser(browser);
      return { success: false, error: `Lỗi: ${err.message}` };
    }
  }
}

module.exports = { GarenaAuth };
