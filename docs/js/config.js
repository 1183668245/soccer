const { ethers } = window;

let provider;
let readProvider;
let signer;
let userAddress = "";
let vaultContract;
let readVaultContract;
let tokenContract;
let readTokenContract;
let tokenSymbol = "TOKEN";
let tokenDecimals = 18;
let seasonTimer = null;
let autoRefreshTimer = null;
let seedInventoryCache = { 0: 0, 1: 0, 2: 0 };
let pendingPlantPlotId = null;
let pendingActionConfirm = null;
let observedTargets = [];
let observedAutoTargets = [];
let observedLastScanBlock = 0;
let observeScanBusy = false;
let walletActionPending = false;
let activityTimer = null;
let activityLastBlock = 0;
let activityHistoryFloor = 0;
let activityBackfillBusy = false;
let activityItems = [];
let activityScanStatus = "";
let vaultReleaseBps = 5000;
let walletProvider;
let walletBusyTimer = null;
let pendingTxHash = "";
let txStatusTimer = null;

const $ = (id) => document.getElementById(id);
const pageLoader = $("pageLoader");

function setPondLoading(active, title = "正在识别钱包状态", text = "正在同步你的阵容与链上数据...") {
  const loading = $("pondLoading");
  const cards = $("pondCards");
  if (!loading || !cards) return;
  loading.classList.toggle("is-active", !!active);
  cards.style.display = active ? "none" : "grid";
  if ($("pondLoadingTitle")) $("pondLoadingTitle").textContent = title;
  if ($("pondLoadingText")) $("pondLoadingText").textContent = text;
}

function setWalletBusy(active, title = "等待钱包确认", text = "请在钱包中完成当前操作，不要重复点击。") {
  const overlay = $("walletBusyOverlay");
  document.body.classList.toggle("wallet-busy", !!active);
  if (overlay) {
    overlay.classList.toggle("is-open", !!active);
    overlay.classList.remove("is-stuck");
  }
  if (walletBusyTimer) {
    clearTimeout(walletBusyTimer);
    walletBusyTimer = null;
  }
  if (active) {
    walletBusyTimer = setTimeout(() => {
      if (!overlay?.classList.contains("is-open")) return;
      overlay.classList.add("is-stuck");
      if ($("walletBusyText")) {
        $("walletBusyText").textContent = "如果你已在钱包确认但仍在转圈，可先关闭提示并点击刷新状态。";
      }
    }, 12000);
  }
  if ($("walletBusyTitle")) $("walletBusyTitle").textContent = title;
  if ($("walletBusyText")) $("walletBusyText").textContent = text;
}

function setTxStatus(active, title = "交易确认中", text = "交易已发送，正在等待链上确认...", hash = "") {
  const card = $("txStatusCard");
  if (txStatusTimer) { clearTimeout(txStatusTimer); txStatusTimer = null; }
  if (card) {
    card.classList.toggle("is-open", !!active);
    card.classList.remove("is-stuck");
  }
  pendingTxHash = hash || pendingTxHash;
  if ($("txStatusTitle")) $("txStatusTitle").textContent = title;
  if ($("txStatusText")) $("txStatusText").textContent = text;
  if ($("txStatusHash")) $("txStatusHash").textContent = pendingTxHash ? `Tx: ${pendingTxHash.slice(0, 10)}...${pendingTxHash.slice(-8)}` : "";
  if (active && card) {
    txStatusTimer = setTimeout(() => {
      card.classList.add("is-stuck");
      if ($("txStatusText")) $("txStatusText").textContent = "如果链上已确认但页面没反应，可点击刷新状态。";
    }, 12000);
  }
}
async function getReceiptProviders() {
  const ps = [];
  if (provider) ps.push(provider);
  if (readProvider && readProvider !== provider) ps.push(readProvider);
  [window.APP_CONFIG?.rpcUrl, ...(window.APP_CONFIG?.rpcUrls || [])].filter(Boolean).forEach((url) => ps.push(new ethers.JsonRpcProvider(url)));
  return ps;
}
async function waitForTxConfirmation(tx, label = "交易", timeoutMs = 90000) {
  const started = Date.now();
  const providers = await getReceiptProviders();
  while (Date.now() - started < timeoutMs) {
    for (const p of providers) {
      const receipt = await p.getTransactionReceipt(tx.hash).catch(() => null);
      if (!receipt) continue;
      if (receipt.status === 0) throw new Error(`${label}链上执行失败`);
      return receipt;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("等待链上确认超时，请点击刷新状态后再查看");
}

function openInfoModal(title = "提示", text = "请先完成当前操作。") {
  if ($("infoModalTitle")) $("infoModalTitle").textContent = title;
  if ($("infoModalText")) $("infoModalText").textContent = text;
  $("infoModal")?.classList.add("is-open");
}

function closeInfoModal() {
  $("infoModal")?.classList.remove("is-open");
}

function openRulesModal() {
  document.body.classList.add("modal-open");
  $("rulesModal")?.classList.add("is-open");
}

function closeRulesModal() {
  document.body.classList.remove("modal-open");
  $("rulesModal")?.classList.remove("is-open");
}

function setDebugChip(id, text, state = "") {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className = `debug-chip${state ? ` is-${state}` : ""}`;
}

function updateDebugState() {
  setDebugChip("debugWalletState", `钱包：${userAddress ? formatAddress(userAddress) : "未识别"}`, userAddress ? "ok" : "warn");
  setDebugChip("debugContractState", `合约：${vaultContract ? "已初始化" : "未初始化"}`, vaultContract ? "ok" : "warn");
}

function getChainHex(chainId) {
  return `0x${Number(chainId).toString(16)}`;
}

const CUSTOM_ERRORS_CN = {
  "SeasonNotEnded": "当前赛季还未结束",
  "AlreadyClaimed": "您已经领取过该赛季奖励了",
  "NoPoints": "该赛季您没有积分，无法领取奖励",
  "TransferFailed": "转账失败，合约余额可能不足",
  "TokenNotBound": "代币未绑定",
  "InvalidToken": "无效的代币",
  "InvalidReceiver": "无效的接收者",
  "InvalidTokenDecimals": "仅支持 18 位精度代币",
  "InvalidPlayerType": "无效的球员类型",
  "InvalidAmount": "无效的数量",
  "InvalidValue": "支付的 BNB 金额不正确",
  "MaxEntryReached": "已达到最大参赛名额数量",
  "LineupSlotNotAvailable": "该阵位不可用",
  "LineupSlotNotFound": "阵位不存在",
  "NotLineupOwner": "您不是该阵位的拥有者",
  "NotMature": "球员尚未成型",
  "AlreadySettled": "该阵位已经结算了",
  "TooEarlyToPoach": "太早了，还没到挖人时间",
  "TooLateToPoach": "太晚了，已经过了挖人窗口期",
  "CannotPoachSelf": "不能挖自己的阵位",
  "PoachLimitReached": "该阵位被挖次数已达上限",
  "AlreadyProtectedFromPoaching": "该阵位已经设置了防挖保护",
  "TrainingLimitReached": "该阵位集训次数已达上限",
  "AlreadyMature": "球员状态已成型，无法继续操作",
  "InPoachWindow": "当前仍在挖人窗口期，暂不能结算",
  "ReferrerAlreadyBound": "您已经绑定过推荐人了",
  "InvalidReferrer": "无效的推荐人地址",
  "InsufficientPlayBalance": "需至少持有 100 万代币才能参与玩法",
  "InvalidLoopCount": "补轮次数无效",
  "RolloverPending": "赛季积压过多，请先执行补轮"
};

function getErrorMessage(err) {
  if (err?.revert?.name && CUSTOM_ERRORS_CN[err.revert.name]) {
    return CUSTOM_ERRORS_CN[err.revert.name];
  }
  return err?.shortMessage
    || err?.info?.error?.message
    || err?.error?.message
    || err?.data?.originalError?.message
    || err?.message
    || String(err);
}

function getWalletProvider() {
  if (walletProvider?.request) return walletProvider;
  const list = window.ethereum?.providers?.length ? window.ethereum.providers : (window.ethereum ? [window.ethereum] : []);
  walletProvider = list.find((p) => p?.isMetaMask)
    || list.find((p) => p?.isOKXWallet || p?.isOkxWallet)
    || list.find((p) => p?.isTokenPocket)
    || list.find((p) => p?.isBitKeep || p?.isBitgetWallet)
    || list.find((p) => p?.isCoinbaseWallet)
    || list.find((p) => p?.isTrust || p?.isTrustWallet)
    || list.find((p) => p?.request)
    || null;
  return walletProvider;
}

function getRpcUrls() {
  const list = [window.APP_CONFIG.rpcUrl, ...(window.APP_CONFIG.rpcUrls || [])].filter(Boolean);
  return [...new Set(list)];
}

async function ensureCorrectNetwork() {
  const injected = getWalletProvider();
  if (!injected) return;
  const currentHex = await injected.request({ method: "eth_chainId" });
  const currentChainId = parseInt(currentHex, 16);
  if (currentChainId === Number(window.APP_CONFIG.chainId)) return;
  try {
    await injected.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: getChainHex(window.APP_CONFIG.chainId) }]
    });
  } catch (switchErr) {
    if (switchErr?.code === 4902) {
      await injected.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: getChainHex(window.APP_CONFIG.chainId),
          chainName: window.APP_CONFIG.chainName,
          rpcUrls: getRpcUrls(),
          nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
          blockExplorerUrls: ["https://bscscan.com"]
        }]
      });
      return;
    }
    throw new Error(`请先将钱包切换到 ${window.APP_CONFIG.chainName}`);
  }
}

function log(message, isError = false) {
  const box = $("logBox");
  const prefix = `[${new Date().toLocaleTimeString()}] `;
  box.textContent = `${prefix}${isError ? "ERROR: " : ""}${message}\n${box.textContent}`;
}

function toast(message, isError = false) {
  const wrap = $("toastWrap");
  if (!wrap) return;
  const el = document.createElement("div");
  el.className = `toast${isError ? " error" : ""}`;
  el.textContent = message;
  wrap.prepend(el);
  setTimeout(() => el.remove(), 3200);
}

function formatAddress(address) {
  if (!address) return "未连接";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function getSeedName(seedType) {
  const cfg = window.APP_CONFIG?.seedConfigs?.[Number(seedType)];
  return cfg?.name || `球员${Number(seedType)}`;
}

const ACTIVITY_MAX_ITEMS = 100;
const ACTIVITY_PREVIEW_ITEMS = 4;
const ACTIVITY_BOOTSTRAP_LOOKBACK = 6000;
const ACTIVITY_BACKFILL_CHUNK = 6000;
const ACTIVITY_QUERY_CHUNK = 2500;
const OBSERVE_SOON_WINDOW = 15 * 60;
const OBSERVE_BOOTSTRAP_LOOKBACK = 2400;
const OBSERVE_MAX_TARGETS = 12;

function getActivityCacheKey() {
  return `activity:v2:${window.APP_CONFIG?.chainId || 0}:${String(window.APP_CONFIG?.vaultAddress || "").toLowerCase()}`;
}
function loadActivityCache() {
  try {
    const data = JSON.parse(localStorage.getItem(getActivityCacheKey()) || "null");
    activityItems = Array.isArray(data?.items) ? data.items.slice(0, ACTIVITY_MAX_ITEMS) : [];
    activityLastBlock = Number(data?.lastBlock || 0);
    activityHistoryFloor = Number(data?.historyFloor || 0);
  } catch {}
}
function saveActivityCache() {
  try {
    localStorage.setItem(getActivityCacheKey(), JSON.stringify({ items: activityItems.slice(0, ACTIVITY_MAX_ITEMS), lastBlock: activityLastBlock, historyFloor: activityHistoryFloor }));
  } catch {}
}
function setActivityScanStatus(text) {
  activityScanStatus = text;
  if ($("activityScanStatus")) $("activityScanStatus").textContent = text;
}

function openActivityModal() {
  document.body.classList.add("modal-open");
  $("activityModal")?.classList.add("is-open");
  renderActivityFeed();
  backfillActivityFeed(ACTIVITY_MAX_ITEMS, 8).catch(() => {});
}

function closeActivityModal() {
  document.body.classList.remove("modal-open");
  $("activityModal")?.classList.remove("is-open");
}

function renderActivityFeed() {
  const previewBox = $("activityList");
  const modalBox = $("activityModalList");

  const render = (box, limit) => {
    if (!box) return;
    if (!activityItems.length) {
      box.innerHTML = '<div class="activity-empty">暂无动态</div>';
      return;
    }
    box.innerHTML = activityItems.slice(0, limit).map((item) => {
      const label = item.type === "steal" ? "挖到" : item.type === "protect" ? "防挖" : "窗口期";
      return `<div class="activity-item">
        <span class="activity-badge is-${item.type}">${label}</span>
        <div class="activity-text">${item.text}</div>
      </div>`;
    }).join("");
  };

  render(previewBox, ACTIVITY_PREVIEW_ITEMS);
  render(modalBox, ACTIVITY_MAX_ITEMS);
}

function pushActivityItems(next) {
  const seen = new Set(activityItems.map((v) => v.key));
  const merged = [];
  next.forEach((v) => {
    if (!v?.key || seen.has(v.key)) return;
    seen.add(v.key);
    merged.push(v);
  });
  activityItems = [...merged, ...activityItems].slice(0, ACTIVITY_MAX_ITEMS);
  saveActivityCache();
}
function getActivityRpcProviders() {
  const urls = [window.APP_CONFIG?.activityRpcUrl, window.APP_CONFIG?.rpcUrl, ...(window.APP_CONFIG?.rpcUrls || [])]
    .filter(Boolean)
    .filter((url, index, arr) => arr.indexOf(url) === index);
  const list = urls.map((url) => new ethers.JsonRpcProvider(url));
  if (readProvider) list.push(readProvider);
  if (provider && provider !== readProvider) list.push(provider);
  return list;
}
async function getActivityLogs(filter, fromBlock, toBlock) {
  const providers = getActivityRpcProviders();
  const topic = Array.isArray(filter?.topics) ? filter.topics[0] : "unknown";
  for (let i = 0; i < providers.length; i += 1) {
    const rpc = providers[i];
    try {
      const logs = [];
      for (let start = fromBlock; start <= toBlock; start += ACTIVITY_QUERY_CHUNK) {
        const end = Math.min(toBlock, start + ACTIVITY_QUERY_CHUNK - 1);
        const part = await rpc.getLogs({ ...filter, fromBlock: start, toBlock: end });
        if (part.length) logs.push(...part);
      }
      return logs;
    } catch (err) {
      log(`联赛动态 getLogs 失败: provider#${i + 1} ${String(topic).slice(0, 10)}... ${getErrorMessage(err)}`, true);
    }
  }
  setActivityScanStatus("联赛动态扫描失败，请稍后重试或切换 RPC");
  return [];
}
async function getActivityRangeItems(contract, fromBlock, toBlock) {
  const [a, b, c] = await Promise.all([
    getActivityLogs(contract.filters.LineupAssigned(), fromBlock, toBlock),
    getActivityLogs(contract.filters.AntiPoachProtectionEnabled(), fromBlock, toBlock),
    getActivityLogs(contract.filters.Poached(), fromBlock, toBlock)
  ]);
  const now = Math.floor(Date.now() / 1000);
  const items = [];
  for (const log of [...a, ...b, ...c].sort((x, y) => (y.blockNumber - x.blockNumber) || (y.logIndex - x.logIndex))) {
    try {
      const p = contract.interface.parseLog(log); const key = `${log.transactionHash}:${log.logIndex}`;
      if (p?.name === "LineupAssigned") {
        const user = p.args.user; const plotId = Number(p.args.plotId); const matureAt = Number(p.args.matureAt);
        const plot = await contract.getPlot(user, plotId).catch(() => null);
        if (!plot?.exists || plot.harvested) continue;
        if (String(plot.owner).toLowerCase() !== String(user).toLowerCase()) continue;
        if (Number(plot.matureAt || 0n) !== matureAt) continue;
        const w = await contract.currentPoachWindow(user, plotId).catch(() => null);
        const start = Number(w?.startTime_ ?? 0n); const end = Number(w?.endTime_ ?? 0n);
        if (start && end && now >= start && now <= end) items.push({ key, type: "window", text: `${formatAddress(user)} 的 ${plotId + 1}号阵位 现在可挖` });
      }
      if (p?.name === "AntiPoachProtectionEnabled") items.push({ key, type: "protect", text: `${formatAddress(p.args.user)} 为 ${Number(p.args.plotId) + 1}号阵位 购买了防挖` });
      if (p?.name === "Poached") items.push({ key, type: "steal", text: `${formatAddress(p.args.thief)} 挖到了 ${formatAddress(p.args.victim)} 的 ${Number(p.args.plotId) + 1}号阵位 · +${formatUnits(p.args.stolenTickets, 18)} 积分` });
    } catch {}
  }
  return items;
}
async function backfillActivityFeed(targetCount = ACTIVITY_PREVIEW_ITEMS, rounds = 4) {
  if (activityBackfillBusy || activityItems.length >= targetCount) return;
  setActivityScanStatus("联赛动态回溯扫描中...");
  await initReadContracts();
  if (!readProvider || !readVaultContract) return;
  activityBackfillBusy = true;
  try {
    const current = await readProvider.getBlockNumber().catch(() => 0);
    if (!current) return;
    if (!activityHistoryFloor) activityHistoryFloor = Math.max(0, current - ACTIVITY_BOOTSTRAP_LOOKBACK);
    while (rounds-- > 0 && activityItems.length < targetCount && activityHistoryFloor > 0) {
      const toBlock = activityHistoryFloor - 1;
      const fromBlock = Math.max(0, toBlock - ACTIVITY_BACKFILL_CHUNK + 1);
      pushActivityItems(await getActivityRangeItems(readVaultContract, fromBlock, toBlock));
      activityHistoryFloor = fromBlock;
    }
    renderActivityFeed();
    setActivityScanStatus(activityItems.length ? `联赛动态已同步 ${activityItems.length} 条` : "最近范围内暂无动态");
  } finally { activityBackfillBusy = false; saveActivityCache(); }
}
async function pollActivityFeed() {
  if (walletActionPending) return;
  setActivityScanStatus("联赛动态扫描中...");
  await initReadContracts();
  const contract = readVaultContract;
  if (!readProvider || !contract) {
    setActivityScanStatus("联赛动态未初始化，等待钱包或 RPC 就绪");
    return;
  }
  const current = await readProvider.getBlockNumber().catch(() => 0);
  if (!current) return;
  const fromBlock = activityLastBlock ? (activityLastBlock + 1) : Math.max(0, current - ACTIVITY_BOOTSTRAP_LOOKBACK);
  if (!activityHistoryFloor) activityHistoryFloor = fromBlock;
  if (fromBlock > current) return;
  activityLastBlock = current;
  pushActivityItems(await getActivityRangeItems(contract, fromBlock, current));
  renderActivityFeed();
  setActivityScanStatus(activityItems.length ? `联赛动态已同步 ${activityItems.length} 条` : "最近范围内暂无动态");
}

function startActivityFeed() {
  clearInterval(activityTimer);
  activityTimer = null;
  activityLastBlock = 0;
  activityHistoryFloor = 0;
  activityItems = [];
  setActivityScanStatus("联赛动态初始化中...");
  loadActivityCache();
  renderActivityFeed();
  pollActivityFeed().then(() => backfillActivityFeed(ACTIVITY_PREVIEW_ITEMS, 4)).catch((err) => log(`联赛动态刷新异常: ${getErrorMessage(err)}`, true));
  activityTimer = setInterval(() => {
    pollActivityFeed().catch((err) => log(`联赛动态刷新异常: ${getErrorMessage(err)}`, true));
  }, 15000);
}

function setConnectState(account) {
  const connectBtn = $("connectBtn");
  if (!connectBtn) return;
  if (account) {
    connectBtn.textContent = formatAddress(account);
    connectBtn.classList.add("btn-connected");
    connectBtn.title = account;
  } else {
    connectBtn.textContent = "连接钱包";
    connectBtn.classList.remove("btn-connected");
    connectBtn.removeAttribute("title");
  }
}

function formatEther(value) {
  try {
    const num = Number(ethers.formatEther(value));
    return `${num.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 })} BNB`;
  } catch {
    return "-";
  }
}

function formatTokenWhole(value, decimals = 18, suffix = "") {
  try {
    const divisor = 10n ** BigInt(decimals);
    const whole = (BigInt(value) / divisor).toLocaleString("en-US");
    return suffix ? `${whole} ${suffix}` : whole;
  } catch {
    return "-";
  }
}

function formatVaultBalanceNumber(value) {
  if (value >= 1000) return `${value.toFixed(1)} BNB`;
  if (value >= 100) return `${value.toFixed(2)} BNB`;
  if (value >= 1) return `${value.toFixed(3)} BNB`;
  return `${value.toFixed(4)} BNB`;
}

function parseBpsText(text) {
  const raw = String(text || "").trim();
  const num = Number.parseFloat(raw.replace("%", ""));
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(10000, Math.round(num * 100)));
}

function animateVaultValue(id, valueWei) {
  const el = $(id);
  if (!el) return;
  const nextValue = Number(ethers.formatEther(valueWei || 0n));
  const startValue = Number(el.dataset.value || "0");
  const startTime = performance.now();
  const duration = 900;
  if (el._vaultRaf) cancelAnimationFrame(el._vaultRaf);
  const tick = (now) => {
    const progress = Math.min(1, (now - startTime) / duration);
    const current = startValue + ((nextValue - startValue) * progress);
    el.textContent = formatVaultBalanceNumber(current);
    if (progress < 1) {
      el._vaultRaf = requestAnimationFrame(tick);
    } else {
      el.dataset.value = String(nextValue);
    }
  };
  el._vaultRaf = requestAnimationFrame(tick);
}

function animateVaultBalance(value) {
  animateVaultValue("vaultBalance", value);
}

function formatUnits(value, decimals = 18, suffix = "") {
  try {
    const v = ethers.formatUnits(value, decimals);
    return suffix ? `${v} ${suffix}` : v;
  } catch {
    return "-";
  }
}

function parseTokenInput(value) {
  return ethers.parseUnits(String(value || "0"), tokenDecimals);
}

function parseEthInput(value) {
  return ethers.parseEther(String(value || "0"));
}

function startPageLoader() {
  if (!pageLoader) return;
  pageLoader.classList.remove("is-hidden");
}

function finishPageLoader() {
  if (!pageLoader) return;
  setTimeout(() => {
    pageLoader.classList.add("is-hidden");
    document.body.classList.remove("play-entering");
    document.body.classList.add("page-ready");
  }, 2000);
}

async function initReadContracts() {
  if (readProvider) return;
  if (provider) {
    readProvider = provider;
  } else {
    const publicRpc = window.APP_CONFIG?.rpcUrls?.[0] || window.APP_CONFIG?.rpcUrl;
    if (publicRpc) readProvider = new ethers.JsonRpcProvider(publicRpc);
    else {
      const injected = getWalletProvider();
      if (!injected) return;
      readProvider = new ethers.BrowserProvider(injected);
    }
  }
  const vaultAddr = window.APP_CONFIG?.vaultAddress;
  const tokenAddr = window.APP_CONFIG?.tokenAddress;
  if (!vaultAddr || vaultAddr === ethers.ZeroAddress) return;
  if (!tokenAddr || tokenAddr === ethers.ZeroAddress) return;
  readVaultContract = new ethers.Contract(vaultAddr, window.CAIFARM_VAULT_ABI, readProvider);
  readTokenContract = new ethers.Contract(tokenAddr, window.ERC20_ABI, readProvider);
  tokenSymbol = await readTokenContract.symbol().catch(() => "TOKEN");
  tokenDecimals = await readTokenContract.decimals().catch(() => 18);
}

async function initContracts() {
  await initReadContracts();
  vaultContract = new ethers.Contract(window.APP_CONFIG.vaultAddress, window.CAIFARM_VAULT_ABI, signer);
  tokenContract = new ethers.Contract(window.APP_CONFIG.tokenAddress, window.ERC20_ABI, signer);
  tokenSymbol = await (readTokenContract || tokenContract).symbol().catch(() => "TOKEN");
  tokenDecimals = await (readTokenContract || tokenContract).decimals().catch(() => 18);
}

async function ensureWalletContext(account) {
  const injected = getWalletProvider();
  if (!injected || !account) return false;
  await ensureCorrectNetwork();
  provider = new ethers.BrowserProvider(injected);
  signer = await provider.getSigner();
  userAddress = account;
  updateDebugState();
  await initContracts();
  $("walletAddress").textContent = formatAddress(userAddress);
  $("plotUserAddress").placeholder = userAddress;
  updateDebugState();
  return true;
}

async function connectWallet() {
  const injected = getWalletProvider();
  if (!injected) {
    openInfoModal("未检测到钱包", "请在 MetaMask、OKX、TokenPocket、Bitget 等钱包浏览器中打开，或先安装浏览器钱包。");
    return;
  }
  if (walletActionPending) {
    toast("已有钱包操作进行中，请先完成当前弹窗", true);
    return;
  }

  walletActionPending = true;
  setPondLoading(true, "正在连接钱包", "已发起钱包授权，请完成确认后同步阵容...");
  setWalletBusy(true, "等待钱包连接", "请在钱包中确认连接，不要重复点击。");
  try {
    const accounts = await provider?.send?.("eth_requestAccounts", []).catch(() => null)
      || await new ethers.BrowserProvider(injected).send("eth_requestAccounts", []);
    const account = accounts?.[0];
    if (!account) return;
    setWalletBusy(false);
    await ensureWalletContext(account);
    setConnectState(userAddress);
    log(`钱包已连接: ${userAddress}`);
    startAutoRefresh();
    startActivityFeed();
    await refreshAll();
    await renderPondCards();
  } catch (err) {
    toast(`连接钱包失败: ${getErrorMessage(err)}`, true);
    log(`连接钱包失败: ${getErrorMessage(err)}`, true);
  } finally {
    walletActionPending = false;
    setWalletBusy(false);
    setPondLoading(false);
  }
}

function updateWalletEligibility(balance) {
  const box = $("walletEligibility");
  const icon = $("walletEligibilityIcon");
  const text = $("walletEligibilityText");
  if (!box || !icon || !text) return;
  const threshold = 1000000n * (10n ** BigInt(tokenDecimals || 18));
  const qualified = BigInt(balance || 0n) >= threshold;
  box.classList.remove("is-pending", "is-qualified", "is-unqualified");
  box.classList.add(qualified ? "is-qualified" : "is-unqualified");
  icon.src = qualified ? "./jpg/游戏/达标.webp" : "./jpg/游戏/未达标.webp";
  icon.alt = qualified ? "达标" : "未达标";
  text.textContent = qualified ? "已达标" : "未达标";
  box.title = qualified ? "代币余额已达到100万门槛" : "代币余额低于100万门槛";
}

async function refreshWalletState() {
  if (!userAddress || !(readProvider || provider)) return;
  const nativeBalance = await (readProvider || provider).getBalance(userAddress);
  $("nativeBalance").textContent = formatEther(nativeBalance);
  $("nativeBalance").title = `${ethers.formatEther(nativeBalance)} BNB`;
  const token = readTokenContract || tokenContract;
  const balance = await token.balanceOf(userAddress);
  $("tokenBalance").textContent = formatTokenWhole(balance, tokenDecimals);
  $("tokenBalance").title = formatUnits(balance, tokenDecimals, tokenSymbol);
  updateWalletEligibility(balance);
  const allowance = await token.allowance(userAddress, window.APP_CONFIG.vaultAddress);
  $("tokenAllowance").textContent = formatTokenWhole(allowance, tokenDecimals);
  $("tokenAllowance").title = formatUnits(allowance, tokenDecimals, tokenSymbol);
}

async function refreshVaultState() {
  const vaultData = await (readVaultContract || vaultContract).vault();
  animateVaultBalance(vaultData.balance);
  const bps = Number(vaultReleaseBps || 0);
  const current = BigInt(vaultData.current || 0n);
  const rollover = BigInt(vaultData.rollover || 0n);
  const distributable = bps > 0
    ? ((current + rollover) * BigInt(bps)) / 10000n
    : 0n;
  animateVaultValue("vaultDistributable", distributable);
}

function formatSeasonLeft(left) {
  const minutes = Math.floor(left / 60);
  const seconds = left % 60;
  return `${minutes}分 ${seconds}秒`;
}

function formatSeasonEndClock(endTime) {
  return new Date(endTime * 1000).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

const SEASON_DURATION_SECONDS = 60 * 60;

function updateSeasonProgress(endTime) {
  const fill = $("seasonProgressFill");
  if (!fill) return;
  const left = Math.max(0, endTime - Math.floor(Date.now() / 1000));
  const passed = Math.max(0, SEASON_DURATION_SECONDS - left);
  const percent = Math.max(0, Math.min(100, (passed / SEASON_DURATION_SECONDS) * 100));
  fill.style.width = `${percent}%`;
}

async function refreshSeasonState() {
  const seasonData = await (readVaultContract || vaultContract).season();
  const endTime = Number(seasonData.endTime);
  const left = Math.max(0, endTime - Math.floor(Date.now() / 1000));
  const releaseBps = parseBpsText(seasonData.releaseRate);
  if (releaseBps) vaultReleaseBps = releaseBps;
  const myTickets = userAddress
    ? await (readVaultContract || vaultContract).getUserTickets(seasonData.id, userAddress).catch(() => 0n)
    : 0n;
  $("seasonId").textContent = seasonData.id.toString();
  $("seasonEndTime").textContent = formatSeasonLeft(left);
  $("seasonEndAt").textContent = `结束于 ${formatSeasonEndClock(endTime)}`;
  updateSeasonProgress(endTime);
  $("seasonTickets").textContent = formatUnits(seasonData.tickets, 18);
  $("mySeasonTickets").textContent = formatUnits(myTickets, 18);
  startSeasonCountdown(endTime);
}

function updateReferrerBindingUI(referrer = "") {
  const input = $("referrerAddress");
  const btn = $("bindReferrerBtn");
  const status = $("referrerStatus");
  const hasReferrer = !!referrer && referrer !== ethers.ZeroAddress;
  if (input) {
    input.disabled = hasReferrer;
    input.value = hasReferrer ? referrer : "";
    input.placeholder = hasReferrer ? "已绑定推荐人" : "输入推荐人地址";
  }
  if (btn) {
    btn.disabled = hasReferrer;
    btn.textContent = hasReferrer ? "已绑定推荐人" : "绑定推荐人";
  }
  if (status) {
    status.textContent = hasReferrer ? `已绑定推荐人：${formatAddress(referrer)}` : "当前未绑定推荐人。";
  }
}

async function refreshReferrerState() {
  if (!userAddress || !(readVaultContract || vaultContract)) {
    updateReferrerBindingUI("");
    return;
  }
  const referrer = await (readVaultContract || vaultContract).referrerOf(userAddress).catch(() => ethers.ZeroAddress);
  updateReferrerBindingUI(referrer);
}

function startSeasonCountdown(endTime) {
  clearInterval(seasonTimer);
  seasonTimer = setInterval(() => {
    const left = Math.max(0, endTime - Math.floor(Date.now() / 1000));
    $("seasonEndTime").textContent = formatSeasonLeft(left);
    $("seasonEndAt").textContent = `结束于 ${formatSeasonEndClock(endTime)}`;
    updateSeasonProgress(endTime);
  }, 1000);
}

async function refreshLivePanels() {
  if (walletActionPending) return;
  const tasks = [];
  if (readVaultContract || vaultContract) {
    tasks.push(refreshVaultState().catch((err) => log(`金库状态刷新异常: ${err?.message || err}`, true)));
    tasks.push(refreshSeasonState().catch((err) => log(`赛季状态刷新异常: ${err?.message || err}`, true)));
  }
  if (signer) {
    tasks.push(refreshWalletState().catch((err) => log(`钱包状态刷新异常: ${err?.message || err}`, true)));
    tasks.push(refreshReferrerState().catch((err) => log(`推荐人状态刷新异常: ${err?.message || err}`, true)));
  }
  await Promise.all(tasks);
}

function startAutoRefresh() {
  clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(() => {
    refreshLivePanels().catch((err) => log(`自动刷新异常: ${getErrorMessage(err)}`, true));
  }, 10000);
}

function stopAutoRefresh() {
  clearInterval(autoRefreshTimer);
  autoRefreshTimer = null;
}

function updateTeamStatusCard(landCount = 0, activeCount = null) {
  const availableCount = Object.values(seedInventoryCache).reduce((sum, count) => sum + Number(count || 0), 0);
  const resolvedActiveCount = Number.isFinite(Number(activeCount))
    ? Number(activeCount)
    : document.querySelectorAll("#pondCards .pond-card-growing, #pondCards .pond-card-ready").length;
  const signedCount = availableCount + resolvedActiveCount;
  if ($("teamLineupStat")) $("teamLineupStat").textContent = `${resolvedActiveCount} / ${landCount}`;
  if ($("teamSignedStat")) $("teamSignedStat").textContent = `${signedCount} 人`;
  if ($("teamAvailableStat")) $("teamAvailableStat").textContent = `${availableCount} 人`;
}

async function refreshAll() {
  if (!signer) {
    log("请先连接钱包");
    return;
  }

  try {
    await refreshLivePanels();
    await renderSeedCards().catch((err) => log(`球员名单刷新异常: ${err?.message || err}`, true));
    await renderPondCards().catch((err) => log(`阵位状态刷新异常: ${err?.message || err}`, true));
    try {
      updateCurrentActionGuide();
    } catch (err) {
      log(`更新引导条异常: ${err?.message || err}`, true);
    }
    log("状态刷新完成");
  } catch (err) {
    log(`刷新失败: ${err.shortMessage || err.message}`, true);
  }
}

async function ensureApprove(amount) {
  const allowance = await tokenContract.allowance(userAddress, window.APP_CONFIG.vaultAddress);
  if (allowance >= amount) {
    log(`授权已足够，跳过 approve`);
    return;
  }

  const defaultApproveAmount = ethers.parseUnits("1000000", tokenDecimals);
  const approveAmount = amount > defaultApproveAmount ? amount : defaultApproveAmount;

  setWalletBusy(true, "等待授权确认", `请在钱包中确认 ${formatUnits(approveAmount, tokenDecimals, tokenSymbol)} 授权。`);
  log(`开始授权 ${formatUnits(approveAmount, tokenDecimals, tokenSymbol)}`);
  const tx = await tokenContract.approve(window.APP_CONFIG.vaultAddress, approveAmount);
  log(`授权发送成功: ${tx.hash}`);
  setWalletBusy(false);
  setTxStatus(true, "授权确认中", "授权已发送，正在等待链上确认...", tx.hash);
  await waitForTxConfirmation(tx, "授权");
  setTxStatus(false);
  log("授权确认成功");
}

function setActionGuide(title, text) {
  const titleEl = $("actionGuideTitle");
  const textEl = $("actionGuideText");
  if (titleEl) titleEl.textContent = title;
  if (textEl) textEl.textContent = text;
}

function getShopSelectedSeedType() {
  return Number($("buySeedType")?.value || "0");
}

function updateShopSummary() {
  const seedType = getShopSelectedSeedType();
  const cfg = window.APP_CONFIG.seedConfigs[seedType];
  const info = SEED_RECRUIT_INFO[seedType] || {};
  const displayTokenSymbol = tokenSymbol && String(tokenSymbol) !== "1" ? String(tokenSymbol) : "";
  const tokenSuffix = displayTokenSymbol ? ` ${displayTokenSymbol}` : "";
  const amount = Number($("buySeedAmount")?.value || "1");
  const totalCost = Number(cfg.tokenCost) * amount;
  const inventory = Number(seedInventoryCache[seedType] || 0);
  const selectedSeedName = $("selectedSeedName");
  const selectedSeedInventory = $("selectedSeedInventory");
  const selectedSeedSummary = $("selectedSeedSummary");
  if (selectedSeedName) selectedSeedName.textContent = info.tab || cfg.name;
  if (selectedSeedInventory) selectedSeedInventory.textContent = info.badge || "球员";
  if (selectedSeedSummary) {
    selectedSeedSummary.innerHTML = `
      <div class="shop-recruit-card">
        <img class="shop-recruit-bg" src="${SEED_IMAGES[seedType]}" alt="${cfg.name}" />
        <div class="shop-recruit-overlay">
          <div class="shop-recruit-top">
            <img class="shop-recruit-icon" src="${SEED_NEWS_ICONS[seedType]}" alt="${cfg.name}" />
            <div class="shop-recruit-heading">
              <strong class="shop-recruit-name">${info.tab || cfg.name}</strong>
              <p class="shop-recruit-desc">${info.desc || "选择球员后签约，再安排到空闲阵位参赛。"}</p>
            </div>
          </div>
          <div class="shop-recruit-stats">
            <div class="shop-recruit-stat"><span>成长周期</span><strong>${cfg.growTime || '-'}</strong></div>
            <div class="shop-recruit-stat"><span>基础积分</span><strong>${cfg.basePoints || '-'}</strong></div>
            <div class="shop-recruit-stat"><span>签约代币</span><strong>${cfg.tokenCost}</strong></div>
          </div>
          <div class="shop-recruit-meta"><span>已拥有：${inventory} 名</span><span>可上阵：${inventory} 名</span></div>
        </div>
      </div>
      <div class="shop-recruit-cost">签约 ${amount} 人需 ${totalCost}${tokenSuffix}</div>`;
  }
}

function normalizeBuySeedAmount() {
  const input = $("buySeedAmount");
  if (!input) return 1;
  const amount = Math.max(1, Number(input.value || "1") || 1);
  input.value = String(amount);
  return amount;
}

function adjustBuySeedAmount(delta) {
  const input = $("buySeedAmount");
  if (!input) return;
  const next = Math.max(1, normalizeBuySeedAmount() + delta);
  input.value = String(next);
  fillBuyCost();
}

function normalizeStealPlotDisplay() {
  const input = $("stealPlotId");
  if (!input) return 1;
  const value = Math.max(1, Number(input.value || "1") || 1);
  input.value = String(value);
  return value;
}

function adjustStealPlotId(delta) {
  const input = $("stealPlotId");
  if (!input) return;
  input.value = String(Math.max(1, normalizeStealPlotDisplay() + delta));
}

function fillBuyCost() {
  const seedType = getShopSelectedSeedType();
  const amount = normalizeBuySeedAmount();
  const cfg = window.APP_CONFIG.seedConfigs[seedType];
  const tokenCost = Number(cfg.tokenCost) * amount;
  $("buySeedTokenCost").value = String(tokenCost);
  updateShopSummary();
}

async function ensureSeasonSynced() {
  if (!vaultContract?.pendingSeasonBacklog) return;
  const backlog = Number(await vaultContract.pendingSeasonBacklog().catch(() => 0n));
  if (!backlog) return;
  const loops = Math.min(backlog, 20);
  const tx = await vaultContract.syncSeasons(loops);
  setTxStatus(true, "赛季同步中", `检测到积压赛季，正在自动补轮 ${loops} 期...`, tx.hash);
  await waitForTxConfirmation(tx, "赛季同步");
  setTxStatus(false);
}

async function sendTx(label, fn) {
  if (!signer) {
    openInfoModal("请先连接钱包", "连接钱包后才能继续当前操作。");
    return;
  }
  if (walletActionPending) {
    toast("已有钱包操作进行中，请先完成当前弹窗", true);
    return;
  }

  walletActionPending = true;
  try {
    setWalletBusy(true, `等待${label}确认`, "请在钱包中完成确认，不要重复点击。");
    await ensureCorrectNetwork();
    await ensureSeasonSynced();
    log(`${label} - 发送中...`);
    const tx = await fn();
    log(`${label} - 已发送: ${tx.hash}`);
    setWalletBusy(false);
    setTxStatus(true, `${label}确认中`, "交易已发送，正在等待链上确认...", tx.hash);
    await waitForTxConfirmation(tx, label);
    setTxStatus(false);
    log(`${label} - 交易确认成功`);
    toast(`${label}成功`);
    try {
      await refreshAll();
      setTimeout(() => refreshAll().catch(() => {}), 1800);
    } catch (err) {
      log(`refreshAll 异常: ${getErrorMessage(err)}`, true);
    }
    try {
      updateCurrentActionGuide();
    } catch (err) {
      log(`更新引导条异常: ${getErrorMessage(err)}`, true);
    }
  } catch (err) {
    const errorMsg = getErrorMessage(err);
    setTxStatus(false);
    toast(`${label}失败: ${errorMsg}`, true);
    log(`${label} - 失败: ${errorMsg}`, true);
  } finally {
    walletActionPending = false;
    setWalletBusy(false);
    setTxStatus(false);
  }
}

async function handleBindReferrer() {
  const referrer = $("referrerAddress").value.trim();
  if (!referrer) return openInfoModal("缺少推荐人地址", "请输入推荐人地址后再继续。");

  await sendTx("绑定推荐人", () => vaultContract.bindReferrer(referrer));
}

async function handleBuySeed() {
  const seedType = Number($("buySeedType").value);
  const amount = BigInt($("buySeedAmount").value || "1");
  const tokenCost = parseTokenInput($("buySeedTokenCost").value.trim());

  await sendTx("签约球员", async () => {
    await ensureApprove(tokenCost);
    return vaultContract.buySeedWithCost(seedType, amount, tokenCost);
  });
}

async function handlePlant() {
  const plotId = BigInt($("plantPlotId").value || "0");
  const seedType = Number($("plantSeedType").value);

  await sendTx("安排上阵", () => vaultContract.plant(plotId, seedType));
}

async function handleBuyLand() {
  let rawValue = $("buyLandValue").value.trim();
  if (!rawValue) {
    const currentLand = Number(await vaultContract.getUserLandCount(userAddress).catch(() => 3n));
    rawValue = LAND_PRICES[currentLand + 1] || "0";
    $("buyLandValue").value = rawValue;
  }
  const value = parseEthInput(rawValue);
  await sendTx("扩充参赛名额", () => vaultContract.buyLand({ value }));
}

async function handleFertilize() {
  const plotId = BigInt($("fertilizePlotId").value || "0");
  const value = parseEthInput($("fertilizeValue").value.trim());

  await sendTx("集训", () => vaultContract.fertilize(plotId, { value }));
}

async function handleScarecrow() {
  const plotId = BigInt($("scarecrowPlotId").value || "0");
  const value = parseEthInput($("scarecrowValue").value.trim());

  await sendTx("设置防挖条款", () => vaultContract.placeScarecrow(plotId, { value }));
}

async function handleSteal() {
  const target = $("stealTarget").value.trim();
  const plotId = BigInt(normalizeStealPlotDisplay() - 1);
  const tokenCost = parseTokenInput($("stealTokenCost").value.trim());

  if (!target) return openInfoModal("缺少目标地址", "请输入目标地址后再发起挖人。");
  saveObservedTarget(target);

  await sendTx("发起挖人", async () => {
    await ensureApprove(tokenCost);
    return vaultContract.stealWithCost(target, plotId, tokenCost);
  });
}

async function handleHarvest() {
  const plotId = BigInt($("harvestPlotId").value || "0");
  await sendTx("赛后结算", () => vaultContract.harvest(plotId));
}

async function handleClaim() {
  const seasonId = BigInt($("claimSeasonId").value || "1");
  await sendTx("领取赛季奖励", () => vaultContract.claimSeason(seasonId));
}

async function loadInventory() {
  if (!signer) return openInfoModal("请先连接钱包", "连接钱包后才能读取已签约球员信息。");

  try {
    const seedType = Number($("inventorySeedType").value);
    const inventory = await vaultContract.getSeedInventory(userAddress, seedType);
    $("inventoryResult").textContent =
      `地址: ${userAddress}\n球员类型: ${seedType}\n已签约人数: ${inventory.toString()}`;
    log("球员信息读取成功");
  } catch (err) {
    $("inventoryResult").textContent = err.shortMessage || err.message;
    log(`球员信息读取失败: ${err.shortMessage || err.message}`, true);
  }
}

async function loadPlot() {
  if (!signer) return openInfoModal("请先连接钱包", "连接钱包后才能读取阵位状态。");

  try {
    const inputUser = $("plotUserAddress").value.trim();
    const user = inputUser || userAddress;
    const plotId = BigInt($("plotId").value || "0");

    const plot = await vaultContract.getPlot(user, plotId);

    $("plotResult").textContent =
      `查询地址: ${user}
阵位编号: ${plotId}
owner: ${plot.owner}
seedType: ${plot.seedType}
plantedAt: ${plot.plantedAt}
matureAt: ${plot.matureAt}
fertilizeCount: ${plot.fertilizeCount}
stolenCount: ${plot.stolenCount}
stolenBps: ${plot.stolenBps}
hasScarecrow: ${plot.hasScarecrow}
harvested: ${plot.harvested}
exists: ${plot.exists}`;

    log("阵位状态读取成功");
  } catch (err) {
    $("plotResult").textContent = err.shortMessage || err.message;
    log(`阵位状态读取失败: ${err.shortMessage || err.message}`, true);
  }
}

function fillDefaultValues() {
  $("buySeedTokenCost").value = window.APP_CONFIG.seedConfigs[0].tokenCost;
  $("fertilizeValue").value = window.APP_CONFIG.seedConfigs[0].fertilizePrice;
  $("scarecrowValue").value = window.APP_CONFIG.fixedScarecrowPrice;
  $("stealTokenCost").value = window.APP_CONFIG.fixedStealTokenCost;
  fillBuyCost();
}

const SEED_IMAGES = {
  0: "./jpg/球员/青训.webp",
  1: "./jpg/球员/主力.webp",
  2: "./jpg/球员/明星.webp"
};
const SEED_NEWS_ICONS = {
  0: "./jpg/news/青训球员.webp",
  1: "./jpg/news/主力球员.webp",
  2: "./jpg/news/明星球员.webp"
};
const SEED_RECRUIT_INFO = {
  0: { tab: "青训新秀", badge: "青训", desc: "潜力新星，性价比之选" },
  1: { tab: "主力球员", badge: "主力", desc: "攻守更均衡，适合稳定拿分" },
  2: { tab: "明星球员", badge: "明星", desc: "高上限核心，适合冲击更高积分" }
};
const SEED_EXTRA_INFO = {
  0: { growTime: "10min", basePoints: "1", stealWindow: "2min" },
  1: { growTime: "25min", basePoints: "6", stealWindow: "5min" },
  2: { growTime: "45min", basePoints: "22", stealWindow: "8min" }
};
const LAND_PRICES = { 4: "0.005", 5: "0.01", 6: "0.02", 7: "0.04", 8: "0.08" };
Object.entries(SEED_EXTRA_INFO).forEach(([id, extra]) => {
  window.APP_CONFIG.seedConfigs[id] = { ...window.APP_CONFIG.seedConfigs[id], ...extra };
});

function getSelectedSeedType() {
  return Number($("plantSeedType")?.value || "0");
}

function updatePlantModalSummary() {
  const seedType = getSelectedSeedType();
  const cfg = window.APP_CONFIG.seedConfigs[seedType];
  const inventory = Number(seedInventoryCache[seedType] || 0);
  const summary = $("plantModalSummary");
  const title = $("plantModalTitle");
  if (title) title.textContent = pendingPlantPlotId === null ? "选择上阵球员" : `选择上阵到 ${Number(pendingPlantPlotId) + 1}号阵位的球员`;
  if (summary) summary.textContent = `${cfg.name} 当前可上阵 ${inventory} 人，确认后将安排到目标阵位。`;
}

function renderPlantSeedModalCards() {
  const box = $("plantSeedModalCards");
  if (!box) return;
  const selected = getSelectedSeedType();
  box.innerHTML = [0, 1, 2].map((seedType) => {
    const cfg = window.APP_CONFIG.seedConfigs[seedType];
    const inventory = Number(seedInventoryCache[seedType] || 0);
    const disabled = inventory <= 0;
    return `<div class="plant-choice-card ${selected === seedType ? "selected" : ""} ${disabled ? "is-disabled" : ""}" data-seed-type="${seedType}" ${disabled ? "" : `onclick="window.selectSeedType(${seedType})"`}>
      <img class="plant-choice-bg" src="${SEED_IMAGES[seedType]}" alt="${cfg.name}" />
      <div class="plant-choice-overlay"></div>
      <div class="plant-choice-content">
        <img class="plant-choice-thumb" src="${SEED_NEWS_ICONS[seedType]}" alt="${cfg.name}" />
        <strong>${cfg.name}</strong>
        <span class="plant-choice-meta">当前可上阵 ${inventory} 人</span>
        <div class="plant-choice-stats">
          <span>成型 ${cfg.growTime}</span>
          <span>积分 ${cfg.basePoints}</span>
        </div>
      </div>
    </div>`;
  }).join("");
  updatePlantModalSummary();
}

function openPlantModal(plotId) {
  pendingPlantPlotId = plotId;
  renderPlantSeedModalCards();
  document.body.classList.add("modal-open");
  $("plantSeedModal")?.classList.add("is-open");
}

function closePlantModal() {
  pendingPlantPlotId = null;
  document.body.classList.remove("modal-open");
  $("plantSeedModal")?.classList.remove("is-open");
}

async function confirmPlantFromModal() {
  const seedType = getSelectedSeedType();
  const inventory = Number(seedInventoryCache[seedType] || 0);
  if (pendingPlantPlotId === null) return;
  if (inventory <= 0) {
    openInfoModal("球员不足", `当前${window.APP_CONFIG.seedConfigs[seedType].name}可上阵人数不足，请先签约球员。`);
    return;
  }
  $("plantPlotId").value = pendingPlantPlotId;
  $("plantSeedType").value = String(seedType);
  closePlantModal();
  await handlePlant();
}

function selectShopSeedType(seedType) {
  $("buySeedType").value = String(seedType);
  document.querySelectorAll(".seed-card").forEach((card) => {
    card.classList.toggle("selected", Number(card.dataset.seedType) === Number(seedType));
  });
  fillBuyCost();
}

function selectSeedType(seedType) {
  $("plantSeedType").value = String(seedType);
  document.querySelectorAll(".plant-choice-card").forEach((card) => {
    card.classList.toggle("selected", Number(card.dataset.seedType) === Number(seedType));
  });
  updatePlantModalSummary();
}

async function renderSeedCards() {
  const box = $("seedCards");
  if (!box) return;

  if (userAddress && vaultContract) {
    const entries = await Promise.all([0, 1, 2].map(async (seedType) => {
      const inventory = await (readVaultContract || vaultContract).getSeedInventory(userAddress, seedType).catch(() => 0n);
      return [seedType, Number(inventory)];
    }));
    seedInventoryCache = Object.fromEntries(entries);
  }

  box.innerHTML = Object.entries(window.APP_CONFIG.seedConfigs).map(([id, cfg]) => {
    const info = SEED_RECRUIT_INFO[id] || {};
    return `
    <div class="seed-card seed-card-compact" data-seed-type="${id}" onclick="window.selectShopSeedType(${id})">
      <strong>${info.tab || cfg.name}</strong>
      <div class="seed-card-mini">已拥有 ${seedInventoryCache[id] || 0} 名</div>
    </div>`;
  }).join("");
  selectShopSeedType(getShopSelectedSeedType());
  updateShopSummary();
}

function updateCurrentActionGuide() {
  if (!userAddress) {
    setActionGuide("下一步：连接钱包", "连接后即可开始操作。");
    return;
  }
  const hasAnyInventory = Object.values(seedInventoryCache).some((count) => Number(count || 0) > 0);
  const cards = document.querySelectorAll('.pond-card');
  let hasEmpty = false;
  let hasGrowing = false;
  let hasReady = false;
  cards.forEach((card) => {
    if (card.classList.contains('pond-card-empty')) hasEmpty = true;
    if (card.classList.contains('pond-card-growing')) hasGrowing = true;
    if (card.classList.contains('pond-card-ready')) hasReady = true;
  });
  if (hasReady) {
    setActionGuide("下一步：赛后结算", "先结算阵位，再继续下一轮。");
  } else if (hasGrowing) {
    setActionGuide("下一步：继续备战", "可集训提速，也可设置防挖条款。");
  } else if (hasEmpty && hasAnyInventory) {
    setActionGuide("下一步：安排上阵", "点击空闲阵位开始本轮参赛。");
  } else {
    setActionGuide("下一步：签约球员", "请在左侧商城签约球员。");
  }
}

async function renderPondCards() {
  const box = $("pondCards");
  const lockedBox = $("lockedPondCards");
  if (!box) return;
  const cards = [];
  const lockedCards = [];
  let hasEmpty = false;
  let hasGrowing = false;
  let hasReady = false;
  let activeCount = 0;

  if (userAddress && !vaultContract) {
    await ensureWalletContext(userAddress).catch((err) => {
      setDebugChip("debugContractState", `合约：初始化失败`, "error");
      log(`合约初始化失败: ${err?.message || err}`, true);
    });
  }

  const hasWallet = !!userAddress;
  const landCount = hasWallet && vaultContract
    ? Number(await (readVaultContract || vaultContract).getUserLandCount(userAddress).catch(() => 3n))
    : 3;
  const now = Math.floor(Date.now() / 1000);

  for (let i = 0; i < 8; i += 1) {
    if (i >= landCount) {
      const nextLand = i + 1;
      const canExpand = hasWallet && nextLand === landCount + 1;
      cards.push(`
        <div class="pond-card pond-card-locked pond-card-lineup pond-card-placeholder ${canExpand ? 'is-clickable' : ''}" ${canExpand ? `onclick="window.quickBuyLand('${LAND_PRICES[nextLand]}')"` : ''}>
          <div class="pond-card-top">
            <span class="pond-slot-index">${i + 1}号阵位</span>
          </div>
          <div class="pond-placeholder-body">
            <div class="pond-placeholder-icon"><img src="./jpg/游戏/锁.webp" alt="未解锁" /></div>
            <strong class="pond-card-title">尚未解锁</strong>
            <div class="pond-card-subtitle">${canExpand ? `点击扩充 · ${LAND_PRICES[nextLand]} BNB` : (hasWallet ? "扩充参赛名额后开放" : "连接钱包后开放")}</div>
          </div>
        </div>`);
      continue;
    }

    if (!hasWallet) {
      cards.push(`
        <div class="pond-card pond-card-default pond-card-empty">
          <div class="pond-status status-empty">默认阵位</div>
          <strong>${i + 1}号阵位</strong>
          <div class="pond-badges pond-badges-static">
            <span class="pond-badge">空闲</span>
            <span class="pond-badge">待连接</span>
          </div>
          <div class="pond-meta">连接钱包后可安排球员上阵并开始备战。</div>
          <div class="pond-card-actions">
            <button class="btn btn-dark btn-block" disabled>连接钱包后操作</button>
          </div>
        </div>`);
      continue;
    }

    const plot = await (readVaultContract || vaultContract).getPlot(userAddress, i).catch(() => null);
    const isEmpty = !plot || !plot.exists || plot.harvested;
    if (!isEmpty) activeCount += 1;
    if (isEmpty) {
      hasEmpty = true;
      cards.push(`
        <div class="pond-card pond-card-empty pond-card-lineup pond-card-placeholder is-clickable" onclick="window.quickPlant(${i})">
          <div class="pond-card-top">
            <span class="pond-slot-index">${i + 1}号阵位</span>
          </div>
          <div class="pond-placeholder-body">
            <div class="pond-placeholder-icon">＋</div>
            <strong class="pond-card-title">尚未安排球员</strong>
            <div class="pond-card-subtitle">点击后选择球员上阵</div>
          </div>
        </div>`);
      continue;
    }

    const matureAt = Number(plot.matureAt);
    const plantedAt = Number(plot.plantedAt || now);
    const isMature = matureAt <= now;
    const progressPercent = Math.max(8, Math.min(100, ((now - plantedAt) / Math.max(1, matureAt - plantedAt)) * 100));

    if (isMature) {
      const windowInfo = await (readVaultContract || vaultContract).currentPoachWindow(userAddress, i).catch(() => ({ startTime_: 0n, endTime_: 0n }));
      const endTime = Number(windowInfo.endTime_ || 0n);
      const inPoachWindow = endTime > 0 && now < endTime;

      if (!inPoachWindow) hasReady = true;

      cards.push(`
        <div class="pond-card pond-card-lineup ${inPoachWindow ? "pond-card-growing" : "pond-card-ready"}">
          <div class="pond-card-top">
            <span class="pond-slot-index">${i + 1}号阵位</span>
            <div class="pond-status ${inPoachWindow ? "status-growing" : "status-ready"}">${inPoachWindow ? "窗口中" : "可结算"}</div>
          </div>
          <img class="pond-card-fish ${inPoachWindow ? "" : "pond-card-fish-ready"}" src="${SEED_IMAGES[plot.seedType]}" alt="${getSeedName(plot.seedType)}" />
          <strong class="pond-card-title">${getSeedName(plot.seedType)}</strong>
          <div class="pond-card-summary ${inPoachWindow ? "" : "pond-meta-highlight"}">${inPoachWindow ? `剩余 <span class="countdown" data-mature="${endTime}">计算中</span>` : "本轮积分已锁定，立即领取"}</div>
          <div class="pond-card-progress"><span style="width:100%"></span></div>
          <div class="pond-card-actions">
            ${inPoachWindow ? `<button class="btn btn-dark btn-block pond-main-btn" disabled>窗口期不可结算</button>` : `<button class="btn btn-block pond-ready-btn pond-main-btn" onclick="window.quickHarvest(${i})">赛后结算</button>`}
          </div>
        </div>`);
      continue;
    }

    hasGrowing = true;
    cards.push(`
      <div class="pond-card pond-card-growing pond-card-lineup">
        <div class="pond-card-top">
          <span class="pond-slot-index">${i + 1}号阵位</span>
          <div class="pond-status status-growing">备战中</div>
        </div>
        <img class="pond-card-fish" src="${SEED_IMAGES[plot.seedType]}" alt="${getSeedName(plot.seedType)}" />
        <strong class="pond-card-title">${getSeedName(plot.seedType)}</strong>
        <div class="pond-card-summary">剩余 <span class="countdown" data-mature="${matureAt}">计算中</span></div>
        <div class="pond-card-progress"><span style="width:${progressPercent}%"></span></div>
        <div class="pond-card-actions">
          <div class="pond-action-row">
            <button class="btn btn-primary btn-block pond-main-btn" onclick="window.quickFertilize(${i}, ${plot.seedType})">集训提效</button>
            <button class="btn btn-dark btn-block pond-secondary-btn" ${plot.hasScarecrow ? 'disabled' : ''} onclick="window.quickScarecrow(${i})">${plot.hasScarecrow ? '已设防挖' : '设置防挖'}</button>
          </div>
        </div>
      </div>`);
  }
  box.innerHTML = cards.join("");
  if (lockedBox) {
    lockedBox.innerHTML = lockedCards.join("");
    lockedBox.parentElement?.classList.toggle("is-hidden", lockedCards.length === 0);
  }
  if ($("lineupCountBadge")) $("lineupCountBadge").textContent = `${landCount}/8`;
  updateTeamStatusCard(landCount, activeCount);
  setPondLoading(false);
  setDebugChip("debugPondState", `参赛名额：已渲染 ${landCount}/8`, "ok");
  setTimeout(updateCurrentActionGuide, 0);
}

window.selectShopSeedType = selectShopSeedType;
window.selectSeedType = selectSeedType;
window.quickPlant = function(plotId) {
  $("plantPlotId").value = String(plotId);
  openPlantModal(plotId);
};
function openActionConfirmModal(title, text, costText, onConfirm) {
  pendingActionConfirm = onConfirm;
  $("actionConfirmTitle").textContent = title;
  $("actionConfirmText").textContent = text;
  $("actionConfirmCost").textContent = costText;
  document.body.classList.add("modal-open");
  $("actionConfirmModal")?.classList.add("is-open");
}

function closeActionConfirmModal() {
  pendingActionConfirm = null;
  document.body.classList.remove("modal-open");
  $("actionConfirmModal")?.classList.remove("is-open");
}

function normalizeObservedTarget(item) {
  return typeof item === "string" ? { address: item, label: "观察目标" } : item;
}
function getObserveCacheKey() {
  return `observe:v3:${window.APP_CONFIG?.chainId || 0}:${String(window.APP_CONFIG?.vaultAddress || "").toLowerCase()}`;
}
function loadObserveCache() {
  try {
    const data = JSON.parse(localStorage.getItem(getObserveCacheKey()) || "null");
    observedAutoTargets = Array.isArray(data?.items) ? data.items.slice(0, OBSERVE_MAX_TARGETS) : [];
    observedLastScanBlock = Number(data?.lastBlock || 0);
  } catch {}
}
function saveObserveCache() {
  try {
    localStorage.setItem(getObserveCacheKey(), JSON.stringify({ items: observedAutoTargets.slice(0, OBSERVE_MAX_TARGETS), lastBlock: observedLastScanBlock }));
  } catch {}
}
function loadObservedTargets() {
  const configured = (window.APP_CONFIG.observeTargets || []).map(normalizeObservedTarget);
  const saved = JSON.parse(localStorage.getItem("flapObservedTargets") || "[]").map(normalizeObservedTarget);
  const map = new Map();
  [...configured, ...saved].forEach((item) => item?.address && map.set(item.address.toLowerCase(), item));
  observedTargets = [...map.values()];
  loadObserveCache();
}
function saveObservedTarget(address) {
  if (!address) return;
  const item = { address, label: "最近目标" };
  const map = new Map(observedTargets.map((v) => [v.address.toLowerCase(), v]));
  map.set(address.toLowerCase(), item);
  observedTargets = [...map.values()].slice(-8).reverse();
  localStorage.setItem("flapObservedTargets", JSON.stringify(observedTargets));
}
async function discoverObservedTargets() {
  if (observeScanBusy) return;
  await initReadContracts();
  if (!readProvider || !readVaultContract) return;
  observeScanBusy = true;
  try {
    const current = await readProvider.getBlockNumber().catch(() => 0);
    if (!current) return;
    const fromBlock = observedLastScanBlock ? (observedLastScanBlock + 1) : Math.max(0, current - OBSERVE_BOOTSTRAP_LOOKBACK);
    if (fromBlock > current) return;
    const logs = (await Promise.all([
      getActivityLogs(readVaultContract.filters.LineupAssigned(), fromBlock, current),
      getActivityLogs(readVaultContract.filters.AntiPoachProtectionEnabled(), fromBlock, current),
      getActivityLogs(readVaultContract.filters.Poached(), fromBlock, current)
    ])).flat().sort((a, b) => (b.blockNumber - a.blockNumber) || (b.logIndex - a.logIndex));
    const map = new Map(observedAutoTargets.map((v) => [String(v.address).toLowerCase(), v]));
    logs.forEach((log) => {
      try {
        const p = readVaultContract.interface.parseLog(log);
        const address = p?.name === "Poached" ? p.args.victim : p.args.user;
        if (!address) return;
        const key = String(address).toLowerCase();
        if (!map.has(key) || Number(map.get(key).blockNumber || 0) < log.blockNumber) map.set(key, { address, label: "链上目标", blockNumber: log.blockNumber });
      } catch {}
    });
    observedAutoTargets = [...map.values()].sort((a, b) => Number(b.blockNumber || 0) - Number(a.blockNumber || 0)).slice(0, OBSERVE_MAX_TARGETS);
    observedLastScanBlock = current;
    saveObserveCache();
  } finally { observeScanBusy = false; }
}
async function getObservedTargetSummary(address) {
  const contract = readVaultContract || vaultContract;
  const landCount = Number(await contract.getUserLandCount(address).catch(() => 0n));
  const now = Math.floor(Date.now() / 1000);
  const plots = [];
  for (let i = 0; i < landCount; i += 1) {
    const plot = await contract.getPlot(address, i).catch(() => null);
    if (!plot || !plot.exists || plot.harvested) continue;
    const w = await contract.currentPoachWindow(address, i).catch(() => null);
    const start = Number(w?.startTime_ ?? 0n);
    const end = Number(w?.endTime_ ?? 0n);
    const active = start && end && now >= start && now <= end;
    const near = start > now && (start - now) <= OBSERVE_SOON_WINDOW;
    if (!active && !near) continue;
    plots.push({ plotId: i, risky: !plot.hasScarecrow, near, active, eta: active ? 0 : (start - now) });
  }
  return {
    total: plots.length,
    active: plots.filter((v) => v.active).length,
    risky: plots.filter((v) => v.risky).length,
    near: plots.filter((v) => v.near).length,
    firstEta: plots.reduce((m, v) => Math.min(m, Number(v.eta || 0)), Number.MAX_SAFE_INTEGER),
    plots: plots.sort((a, b) => Number(b.active) - Number(a.active) || Number(b.risky) - Number(a.risky) || Number(a.eta || 0) - Number(b.eta || 0))
  };
}
async function renderObservedTargets() {
  const box = $("observeTargetList");
  if (!box) return;
  if (!userAddress || !(readVaultContract || vaultContract)) {
    box.innerHTML = '<div class="observe-target-empty">连接钱包后即可查看可观察目标。</div>';
    return;
  }
  await discoverObservedTargets();
  const merged = new Map();
  [...observedAutoTargets, ...observedTargets].forEach((item) => item?.address && merged.set(item.address.toLowerCase(), item));
  const targets = [...merged.values()].slice(0, OBSERVE_MAX_TARGETS);
  if (!targets.length) {
    box.innerHTML = '<div class="observe-target-empty">暂无目标记录。稍后会自动扫描最近可挖目标。</div>';
    return;
  }
  const cards = (await Promise.all(targets.map(async (item) => ({ item, summary: await getObservedTargetSummary(item.address) })))).filter((v) => v.summary.total > 0).sort((a, b) => b.summary.active - a.summary.active || b.summary.risky - a.summary.risky || b.summary.near - a.summary.near || a.summary.firstEta - b.summary.firstEta);
  if (!cards.length) {
    box.innerHTML = '<div class="observe-target-empty">最近扫描范围内暂无可挖或即将开窗目标。</div>';
    return;
  }
  box.innerHTML = cards.map(({ item, summary }) => {
    const chips = summary.plots.map((plot) => `<button class="observe-plot-chip ${plot.risky ? "is-risky" : ""}" onclick="window.pickObservedTarget('${item.address}', ${plot.plotId})">${plot.plotId + 1}号阵位${plot.active ? ' · 可挖中' : ' · 即将开窗'}${plot.risky ? ' · 无防挖' : ' · 已防挖'}</button>`).join("");
    return `<div class="observe-target-card"><div class="observe-target-top"><strong>${item.label || '目标榜单'}</strong><span>${formatAddress(item.address)}</span></div><div class="observe-target-meta">可挖 <b>${summary.active}</b> · 无防挖 <b>${summary.risky}</b> · 即将开窗 <b>${summary.near}</b></div><div class="observe-target-plots">${chips}</div></div>`;
  }).join("");
}

function openObserveDrawer() {
  document.body.classList.add("modal-open");
  $("observeDrawer")?.classList.add("is-open");
  renderObservedTargets().catch((err) => log(`目标榜单刷新异常: ${getErrorMessage(err)}`, true));
}

function closeObserveDrawer() {
  document.body.classList.remove("modal-open");
  $("observeDrawer")?.classList.remove("is-open");
}

async function submitActionConfirm() {
  const action = pendingActionConfirm;
  closeActionConfirmModal();
  if (typeof action === "function") await action();
}

window.quickFertilize = function(plotId, seedType) {
  $("fertilizePlotId").value = plotId;
  const actualSeedType = Number(seedType);
  const price = window.APP_CONFIG.seedConfigs[actualSeedType]?.fertilizePrice || $("fertilizeValue").value || "0";
  $("fertilizeValue").value = price;
  openActionConfirmModal("确认集训", `确认对 ${Number(plotId) + 1}号阵位 开启集训吗？`, `本次将消耗 ${price} BNB`, () => handleFertilize());
};
window.quickScarecrow = function(plotId) {
  $("scarecrowPlotId").value = plotId;
  const price = window.APP_CONFIG.fixedScarecrowPrice || $("scarecrowValue").value || "0";
  $("scarecrowValue").value = price;
  openActionConfirmModal("确认设置防挖", `确认对 ${Number(plotId) + 1}号阵位 设置防挖条款吗？`, `本次将消耗 ${price} BNB`, () => handleScarecrow());
};
window.quickHarvest = function(plotId) {
  $("harvestPlotId").value = plotId;
  handleHarvest();
};
window.quickBuyLand = function(value) {
  $("buyLandValue").value = value;
  handleBuyLand();
};
window.pickObservedTarget = function(address, plotId) {
  $("stealTarget").value = address;
  $("stealPlotId").value = String(Number(plotId) + 1);
  closeObserveDrawer();
  toast(`已带入 ${formatAddress(address)} 的 ${plotId + 1}号阵位`);
};

setInterval(() => {
  let shouldRefreshPonds = false;
  document.querySelectorAll('.countdown').forEach((el) => {
    const matureAt = Number(el.getAttribute('data-mature'));
    const left = Math.max(0, matureAt - Math.floor(Date.now() / 1000));
    if (left === 0) {
      if (!el.dataset.matureHandled) {
        el.dataset.matureHandled = "1";
        el.textContent = "已成型，正在更新...";
        shouldRefreshPonds = true;
      }
    } else {
      const m = Math.floor(left / 60);
      const s = left % 60;
      el.textContent = m + "分 " + s + "秒";
    }
  });
  if (shouldRefreshPonds) {
    renderPondCards().catch((err) => log(`阵位自动刷新异常: ${getErrorMessage(err)}`, true));
    updateCurrentActionGuide();
  }
}, 1000);

function bindEvents() {
  $("connectBtn").addEventListener("click", connectWallet);
  $("refreshAllBtn").addEventListener("click", refreshAll);

  $("fillBuyCostBtn").addEventListener("click", fillBuyCost);

  $("bindReferrerBtn").addEventListener("click", handleBindReferrer);
  $("buySeedBtn").addEventListener("click", handleBuySeed);
  $("plantBtn").addEventListener("click", handlePlant);
  $("buyLandBtn").addEventListener("click", handleBuyLand);
  $("fertilizeBtn").addEventListener("click", handleFertilize);
  $("scarecrowBtn").addEventListener("click", handleScarecrow);
  $("stealBtn").addEventListener("click", handleSteal);
  $("harvestBtn").addEventListener("click", handleHarvest);
  $("claimBtn").addEventListener("click", handleClaim);

  $("loadInventoryBtn").addEventListener("click", loadInventory);
  $("loadPlotBtn").addEventListener("click", loadPlot);

  $("buySeedType").addEventListener("change", fillBuyCost);
  $("buySeedAmount").addEventListener("input", fillBuyCost);
  $("buySeedMinusBtn")?.addEventListener("click", () => adjustBuySeedAmount(-1));
  $("buySeedPlusBtn")?.addEventListener("click", () => adjustBuySeedAmount(1));
  $("stealPlotId")?.addEventListener("input", normalizeStealPlotDisplay);
  $("stealPlotMinusBtn")?.addEventListener("click", () => adjustStealPlotId(-1));
  $("stealPlotPlusBtn")?.addEventListener("click", () => adjustStealPlotId(1));
  $("closePlantModalBtn")?.addEventListener("click", closePlantModal);
  $("confirmPlantBtn")?.addEventListener("click", confirmPlantFromModal);
  $("plantSeedModal")?.addEventListener("click", (e) => {
    if (e.target === $("plantSeedModal")) closePlantModal();
  });
  $("closeActionConfirmBtn")?.addEventListener("click", closeActionConfirmModal);
  $("cancelActionConfirmBtn")?.addEventListener("click", closeActionConfirmModal);
  $("submitActionConfirmBtn")?.addEventListener("click", submitActionConfirm);
  $("actionConfirmModal")?.addEventListener("click", (e) => {
    if (e.target === $("actionConfirmModal")) closeActionConfirmModal();
  });
  $("closeInfoModalBtn")?.addEventListener("click", closeInfoModal);
  $("confirmInfoModalBtn")?.addEventListener("click", closeInfoModal);
  $("infoModal")?.addEventListener("click", (e) => {
    if (e.target === $("infoModal")) closeInfoModal();
  });
  $("openRulesModalBtn")?.addEventListener("click", openRulesModal);
  $("closeRulesModalBtn")?.addEventListener("click", closeRulesModal);
  $("confirmRulesModalBtn")?.addEventListener("click", closeRulesModal);
  $("rulesModal")?.addEventListener("click", (e) => {
    if (e.target === $("rulesModal")) closeRulesModal();
  });
  $("openObserveDrawerBtn")?.addEventListener("click", openObserveDrawer);
  $("closeObserveDrawerBtn")?.addEventListener("click", closeObserveDrawer);
  $("observeDrawer")?.addEventListener("click", (e) => {
    if (e.target === $("observeDrawer")) closeObserveDrawer();
  });
  $("openActivityModalBtn")?.addEventListener("click", openActivityModal);
  $("closeActivityModalBtn")?.addEventListener("click", closeActivityModal);
  $("activityModal")?.addEventListener("click", (e) => {
    if (e.target === $("activityModal")) closeActivityModal();
  });

  $("walletBusyDismissBtn")?.addEventListener("click", () => setWalletBusy(false));
  $("walletBusyRefreshBtn")?.addEventListener("click", async () => {
    setWalletBusy(false);
    try {
      await refreshAll();
    } catch (_) {
      renderPondCards().catch(() => {});
    }
  });
  $("walletBusyOverlay")?.addEventListener("click", (e) => {
    const overlay = $("walletBusyOverlay");
    if (e.target === overlay && overlay?.classList.contains("is-stuck")) setWalletBusy(false);
  });
  $("txStatusDismissBtn")?.addEventListener("click", () => setTxStatus(false));
  $("txStatusRefreshBtn")?.addEventListener("click", async () => {
    try {
      await refreshAll();
      toast("链上状态已刷新");
    } catch (_) {
      renderPondCards().catch(() => {});
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("plantSeedModal")?.classList.contains("is-open")) closePlantModal();
    if (e.key === "Escape" && $("actionConfirmModal")?.classList.contains("is-open")) closeActionConfirmModal();
    if (e.key === "Escape" && $("infoModal")?.classList.contains("is-open")) closeInfoModal();
    if (e.key === "Escape" && $("rulesModal")?.classList.contains("is-open")) closeRulesModal();
    if (e.key === "Escape" && $("observeDrawer")?.classList.contains("is-open")) closeObserveDrawer();
    if (e.key === "Escape" && $("activityModal")?.classList.contains("is-open")) closeActivityModal();
  });
}

async function syncConnectedAccount() {
  setPondLoading(true, "正在识别钱包状态", "请稍候，正在确认是否已连接并同步阵容...");
  const injected = getWalletProvider();
  if (!injected) {
    setDebugChip("debugWalletState", "钱包：未检测到可用钱包", "error");
    await renderPondCards();
    return;
  }

  const accounts = await injected.request({ method: "eth_accounts" });
  const account = accounts?.[0];
  setConnectState(account);
  updateDebugState();

  if (!account) {
    userAddress = "";
    signer = undefined;
    provider = undefined;
    vaultContract = undefined;
    tokenContract = undefined;
    if ($("mySeasonTickets")) $("mySeasonTickets").textContent = "-";
    updateReferrerBindingUI("");
    updateDebugState();
    setDebugChip("debugPondState", "参赛名额：展示默认 3 个阵位", "warn");
    await renderPondCards();
    updateCurrentActionGuide();
    return;
  }

  await ensureWalletContext(account);
  startAutoRefresh();
  startActivityFeed();
  await refreshAll();
  await renderPondCards();
  updateCurrentActionGuide();
}

function initPlayPage() {
  document.body.classList.add("play-entering");
  startPageLoader();
  bindEvents();
  loadObservedTargets();
  fillDefaultValues();
  updateDebugState();
  setActionGuide("下一步：先选择球员", "在左侧球员商城选择想上阵的球员，再到空闲阵位开始参赛。");
  setDebugChip("debugPondState", "参赛名额：初始化中", "warn");
  setPondLoading(true, "正在识别钱包状态", "首次进入页面时，阵容会先自动检查钱包连接状态。");
  refreshLivePanels().catch(() => {});
  renderSeedCards().catch(() => {});
  updateCurrentActionGuide();
  log("页面初始化完成，请先连接钱包");
  syncConnectedAccount().catch((err) => {
    log(`自动同步钱包失败: ${err?.message || err}`, true);
    renderPondCards().catch(() => {});
  });
  finishPageLoader();

  const injected = getWalletProvider();
  injected?.on?.("accountsChanged", async (accounts) => {
    const account = accounts?.[0] || "";
    userAddress = account;
    setConnectState(account);
    $("walletAddress").textContent = formatAddress(account);
    $("plotUserAddress").placeholder = account || "默认当前钱包地址";

    if (account) {
      await ensureWalletContext(account);
      startAutoRefresh();
      startActivityFeed();
      await refreshAll();
      updateCurrentActionGuide();
    } else {
      signer = undefined;
      provider = undefined;
      vaultContract = undefined;
      tokenContract = undefined;
      if ($("mySeasonTickets")) $("mySeasonTickets").textContent = "-";
      updateReferrerBindingUI("");
      await renderPondCards();
      updateCurrentActionGuide();
    }
  });
  injected?.on?.("chainChanged", () => {
    window.location.reload();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initPlayPage, { once: true });
} else {
  initPlayPage();
}
