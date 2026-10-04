# bot-fc

## Code organization and tests

- `event-config.js` selects the active URL and builds login configuration.
- `event-profiles.js` owns event-specific endpoints, payloads, response validation
  and first-spin state/balance/reward readers. Add event API differences here.
- `bot-worker.js` manages account execution and delegates event-specific first-spin
  response handling to the profile interface.
- `bot-scheduler.js` coordinates accounts and request timing.
- `jackpot-monitor.js` handles socket connections and jackpot notifications.
- `telegram-notifier.js` handles Telegram delivery with injectable fetch/logger/clock.
- `test/` contains the Node test suites. Run `npm test` from this directory
  (`npm.cmd test` in PowerShell if script execution policy blocks `npm.ps1`).

The event profiles separate API differences from execution logic (single
responsibility and open/closed principles). The worker uses profile functions
instead of knowing each event's first-spin response structure. Tests mock
network calls; they do not perform paid spins or verify live authentication.

## Event configuration

Bi Lac supports the manual first-spin button using `POST /api/user/spin`
with `{ "spin_type": 1, "payment_type": 1 }`. Its official web client uses
`user.price_type === "first_pay"` for the introductory spin. The bot checks
this field before enabling the button, locks it after completion (including
after account reload), and waits for completion before auto-spin. Missing
state keeps the button disabled. Balance and rewards use `user.fc` and
`spin_results[].reward_name`; no `all_spins` field is required for Bi Lac.
Reference: https://cdn.vn.garenanow.com/web/ddt/ffcafe/fco-bi-lac-2025/assets/index-DNpzelVa.js

Each bot card has a **Đặt Min–Max** button. Enable **Dùng Min–Max riêng**,
enter its range, and save. Max `0` means no upper limit. Shared configuration
updates preserve individual ranges while still updating spin timing/count.
Disable the option to restore the latest shared range. Changes apply immediately
without resetting the paid turn count. Individual ranges live with the bot in
server memory; removing the bot or restarting the app clears them.

The Ty Phu 2.0 profile (`typhu.fconline.garena.vn`) maps the
supplied `GET /api/user/get` response: account nickname/UID, `user.fc`,
`jackpot_value`, and `jackpot_billboard`. Login uses the `sessionid` cookie;
the shared request code forwards `csrftoken` as `x-csrftoken`.
The login flow has not yet been verified live for this event. Jackpot monitoring connects to
`wss://sock.bis.fo4.garena.vn/io/?account_id=<socket_account_id>&EIO=4&transport=websocket`
using `socket_account_id` from the GET response and the event origin.
Socket messages with `content.type` equal to `jackpot` or `mini_jackpot`
provide the winner in `nickname` and the prize in `value` (for example,
`14.461 FC`). The shared monitor handles these messages and suppresses duplicates.
Auto-spin sends `POST /api/user/spin` with `{ "spin_type": 2, "payment_type": 1 }`
after the first paid spin is confirmed. The active event is Bi Lac.
Its manual first spin sends `POST /api/user/spin` with
`{ "spin_type": 1, "payment_type": 1 }`. Based on the supplied responses,
`user.price_type` changes from `first_pay` to `normal` after the first paid
spin. The button checks this state on account loading and locks on success;
unknown states remain disabled. Balance and rewards come from `user.fc`
and `spin_results[].reward_name`.

Change `BASE_URL` in `event-config.js` to select `https://vqsc.fconline.garena.vn`,
`https://bilac.fconline.garena.vn`, `https://vqtg.fconline.garena.vn`, or
`https://typhu.fconline.garena.vn`, then
restart the app and log in for that domain.
VQTG reads account, FC balance, jackpot and last jackpot winner from
`/api/user/get`. Its reward catalog is at `/api/reward/get-infos`.
Each VQTG bot has a one-time "Quay lần đầu" button. It sends
`POST /api/reward/spin` with `spin_type: 1`, `payment_type: 1`,
`use_topup_deal: false`, and `is_free: false`. The button is disabled while
the request is pending and after a successful response. This payload is only
for the manual first spin. VQTG auto-spin uses the same endpoint with
`spin_type: 2` and the remaining fields unchanged. Auto-spin starts only after
the account's first paid spin has been confirmed by `/api/user/get`.
The button also checks `user_status.first_spin` and `paid_spin_count` from
`/api/user/get`, so accounts that already made a paid spin stay locked after
the app restarts. The spin response must contain `status: "successful"` and
the corresponding updated `user_status` before the button locks.
VQTG's spin response has `payload.fc` and a cumulative
`payload.receive_reward_infos` list. The bot displays the item matching
`payload.user_status.last_reward_id` as the latest reward. VQTG uses
`wss://sock.bis.fo4.garena.vn/io/` with `socket_account_id` from
`/api/user/get`. Jackpot changes arrive as Socket.IO `prize_change` messages;
the monitor polls `/api/user/get` when it cannot obtain a socket account ID.
VQTG jackpot wins arrive as `content.type: "jackpot"` with `uid`,
`account_name` and `jackpot_prize` inside `content.data`. The bot matches both
the account name and UID to stop its own account after a win. VQTG bot cards
display `user.account_name` from `/api/user/get` so the displayed name matches
the jackpot socket feed.
The selected profile controls account, balance, spin, jackpot and socket endpoints.
Garena callback and state are generated from the same URL.

VQSC preserves the original API paths and uses `SPIN_CONF_ID` (default 5),
`SPIN_NUM` (default 10), and `PAYMENT_TYPE` (default fc).
Bi Lac uses `BILAC_SPIN_TYPE` (default 2) and `payment_type: 1` from the supplied
request. Set `BILAC_SPIN_TYPE=2` in `.env` only when that is the desired request;
the number of spins represented by each type has not been confirmed.
New event domains require a new profile; endpoints cannot be inferred from a URL.

### Telegram notifications

Add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` to `.env`, then restart the app.
Create a bot through Telegram's @BotFather, and start a conversation with your
bot (or add it to the target group). Use the destination chat's numeric ID,
including the minus sign for a group. An empty token or chat ID disables sending.
See `.env.telegram.example` for the setting names.

Own-account grand and mini jackpot events send the account label/name, reward,
remaining FC and Vietnam time. Notifications use the existing win detection;
ordinary rewards and other players' wins do not send messages. Repeated events
for the same account and jackpot type within 10 seconds are suppressed because
the socket and spin API do not share a win ID. Two genuine wins of the same type
within that window will also produce only one message. Delivery errors are logged
without credentials; sending times out after 10 seconds and never blocks spins.
There is no automatic retry or durable notification queue.
API reference: https://core.telegram.org/bots/api#sendmessage
