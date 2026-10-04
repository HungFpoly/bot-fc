// Change only this URL to switch between the event profiles below.
const BASE_URL = "https://bilac.fconline.garena.vn";

const profiles = require('./event-profiles');

const TARGET_HOST = new URL(BASE_URL).hostname;
const event = profiles[TARGET_HOST];
if (!event) throw new Error(`Unsupported event: ${TARGET_HOST}. Add its API profile in event-config.js.`);

// Preserve the existing Garena MessagePack state format: { next: homeUrl }.
const home = Buffer.from(`${BASE_URL}/`);
const state = Buffer.concat([
  Buffer.from([0xde, 0, 1, 0xa4, 0x6e, 0x65, 0x78, 0x74, 0xd9, home.length]),
  home,
]).toString("base64").replace(/=+$/, "");
const login = new URL("https://auth.garena.com/universal/oauth");
login.search = new URLSearchParams({
  platform: "1", state, client_id: "100072", response_type: "code",
  redirect_uri: `${BASE_URL}/connect/garena/callback`,
}).toString();

module.exports = { BASE_URL, TARGET_HOST, SSO_LOGIN_URL: login.href, SESSION_COOKIE: event.sessionCookie, event };
