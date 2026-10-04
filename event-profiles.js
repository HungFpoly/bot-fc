const profiles = {
  "typhu.fconline.garena.vn": {
    name: "Tỷ Phú 2.0",
    firstSpinPath: "/api/user/spin",
    firstSpinPayload: () => ({ spin_type: 1, payment_type: 1 }),
    spinPath: "/api/user/spin",
    spinPayload: () => ({ spin_type: 2, payment_type: 1 }),
    spinResponseValid: response => response?.status === "successful"
      && Number.isFinite(response.payload?.user?.fc)
      && Array.isArray(response.payload?.spin_results),
    // Based on the supplied before/after responses; unknown states stay locked.
    firstSpinStateValid: data => Number.isInteger(data.user?.all_spins)
      && data.user.all_spins >= 0
      && (data.user.price_type === "first_pay" || data.user.price_type === "normal"),
    firstSpinDone: data => data.user?.price_type === "normal",
    firstSpinSucceeded: data => data.user?.price_type === "normal"
      && Number.isInteger(data.user?.all_spins) && data.user.all_spins > 0
      && Number.isFinite(data.user?.fc),
    firstSpinBalance: data => data.user?.fc,
    firstSpinRewards: data => Array.isArray(data.spin_results)
      ? data.spin_results.map(reward => reward.reward_name).filter(Boolean) : [],
    sessionCookie: "sessionid",
    accountPath: "/api/user/get",
    balancePath: "/api/user/get",
    balanceMethod: "GET",
    jackpotPath: "/api/user/get",
    balance: data => data.user?.fc,
    accountName: data => data.user?.nickname || data.user?.uid,
    jackpot: data => data.jackpot_value,
    jackpotBillboard: data => data.jackpot_billboard,
    socketId: data => data.socket_account_id,
    socketUrl: () => "wss://sock.bis.fo4.garena.vn",
  },
  "vqsc.fconline.garena.vn": {
    name: "VQSC",
    sessionCookie: "ff_session",
    accountPath: "/api/app/me",
    balancePath: "/api/app/me/get_balance",
    balanceMethod: "POST",
    balanceBody: { force: false },
    spinPath: "/api/app/reward/spin",
    jackpotPath: "/api/app/me/get_jackpot_infos",
    socketId: data => data.socketUid,
    socketUrl: data => data.socketUrl,
    balance: data => data.fc,
    spinPayload: config => ({
      spinConfId: config.SPIN_CONF_ID,
      paymentType: config.PAYMENT_TYPE,
      spinNum: config.SPIN_NUM,
      isFree: "inactive",
    }),
  },
  "bilac.fconline.garena.vn": {
    name: "Bi Lắc",
    firstSpinPath: "/api/user/spin",
    firstSpinPayload: () => ({ spin_type: 1, payment_type: 1 }),
    // The official client offers the introductory spin when price_type is first_pay.
    firstSpinStateValid: data => typeof data.user?.price_type === "string"
      && data.user.price_type.length > 0,
    firstSpinDone: data => typeof data.user?.price_type === "string"
      && data.user.price_type.length > 0 && data.user.price_type !== "first_pay",
    firstSpinSucceeded: data => typeof data.user?.price_type === "string"
      && data.user.price_type.length > 0 && data.user.price_type !== "first_pay"
      && Number.isFinite(data.user?.fc) && Array.isArray(data.spin_results),
    firstSpinBalance: data => data.user?.fc,
    firstSpinRewards: data => Array.isArray(data.spin_results)
      ? data.spin_results.map(reward => reward.reward_name).filter(Boolean) : [],
    sessionCookie: "sessionid",
    accountPath: "/api/user/get",
    balancePath: "/api/user/get",
    balanceMethod: "GET",
    spinPath: "/api/user/spin",
    jackpotPath: "/api/user/get",
    socketId: data => data.socket_account_id,
    socketUrl: () => "wss://sock.bis.fconline.garena.vn",
    balance: data => data.user?.fc,
    accountName: data => data.user?.nickname || data.user?.account_name || data.user?.uid,
    jackpot: data => data.jackpot_value,
    jackpotBillboard: data => data.jackpot_billboard,
    // Keep the configured regular spin type independent of VQSC's SPIN_NUM.
    spinPayload: config => ({ spin_type: config.SPIN_TYPE, payment_type: 1 }),
  },
  "vqtg.fconline.garena.vn": {
    name: "Vòng Quanh Thế Giới",
    sessionCookie: "sessionid",
    accountPath: "/api/user/get",
    balancePath: "/api/user/get",
    balanceMethod: "GET",
    jackpotPath: "/api/user/get",
    rewardInfosPath: "/api/reward/get-infos",
    firstSpinPath: "/api/reward/spin",
    firstSpinPayload: () => ({ spin_type: 1, payment_type: 1, use_topup_deal: false, is_free: false }),
    firstSpinDone: data => data.user_status?.first_spin === 0 && data.user_status?.paid_spin_count > 0,
    firstSpinStateValid: data => Number.isInteger(data.user_status?.first_spin)
      && Number.isInteger(data.user_status?.paid_spin_count),
    firstSpinBalance: data => data.fc,
    firstSpinRewards: data => Array.isArray(data.receive_reward_infos)
      ? data.receive_reward_infos.map(reward => reward.item_name).filter(Boolean) : [],
    firstSpinSucceeded: data => data.user_status?.first_spin === 0 && data.user_status?.paid_spin_count > 0,
    spinPath: "/api/reward/spin",
    spinPayload: () => ({ spin_type: 2, payment_type: 1, use_topup_deal: false, is_free: false }),
    spinResponseValid: response => response?.status === "successful"
      && Number.isFinite(response.payload?.fc)
      && Number.isInteger(response.payload?.user_status?.paid_spin_count),
    stopOnUncertainSpinFailure: true,
    spinResults: data => data.receive_reward_infos?.filter(reward =>
      reward.reward_id === data.user_status?.last_reward_id) ?? [],
    socketId: data => data.socket_account_id,
    socketUrl: () => "wss://sock.bis.fo4.garena.vn",
    balance: data => data.user?.fc,
    jackpot: data => data.current_jackpot_prize,
    accountName: data => data.user?.account_name || data.user?.nickname || data.user?.uid,
    jackpotBillboard: data => data.last_jackpot_infos?.account_name && data.last_jackpot_infos?.jackpot_prize
      ? { nickname: data.last_jackpot_infos.account_name, value: `${data.last_jackpot_infos.jackpot_prize} FC` }
      : null,
  },
};


module.exports = profiles;
