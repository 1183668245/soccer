(function () {
  const $ = (id) => document.getElementById(id);

  const connectBtn = $("connectBtn");
  const mobileMenuBtn = $("mobileMenuBtn");
  const mobileNavPanel = $("mobileNavPanel");
  const openGuideBtn = $("openGuideBtn");
  const openGuideBtnBottom = $("openGuideBtnBottom");
  const openGuideNavBtn = $("openGuideNavBtn");
  const openGuideNavBtnBottom = $("openGuideNavBtnBottom");
  const closeGuideBtn = $("closeGuideBtn");
  const guideModal = $("guideModal");

  const openPlayersBtn = $("openPlayersBtn");
  const closePlayersBtn = $("closePlayersBtn");
  const playersModal = $("playersModal");
  const playersGrid = $("playersGrid");

  const openFaqBtn = $("openFaqBtn");
  const openFaqBtnBottom = $("openFaqBtnBottom");
  const closeFaqBtn = $("closeFaqBtn");
  const faqModal = $("faqModal");

  const homeInfoModal = $("homeInfoModal");
  const closeHomeInfoBtn = $("closeHomeInfoBtn");
  const confirmHomeInfoBtn = $("confirmHomeInfoBtn");

  function getWalletProvider() {
    const list = window.ethereum?.providers?.length ? window.ethereum.providers : (window.ethereum ? [window.ethereum] : []);
    return list.find((p) => p?.isMetaMask)
      || list.find((p) => p?.isOKXWallet || p?.isOkxWallet)
      || list.find((p) => p?.isTokenPocket)
      || list.find((p) => p?.isBitKeep || p?.isBitgetWallet)
      || list.find((p) => p?.isCoinbaseWallet)
      || list.find((p) => p?.isTrust || p?.isTrustWallet)
      || list.find((p) => p?.request)
      || null;
  }

  function setConnectState(account) {
    if (!connectBtn) return;
    if (account) {
      connectBtn.textContent = `${account.slice(0, 6)}...${account.slice(-4)}`;
      connectBtn.classList.add("btn-connected");
      connectBtn.title = account;
    } else {
      connectBtn.textContent = "连接钱包";
      connectBtn.classList.remove("btn-connected");
      connectBtn.removeAttribute("title");
    }
  }

  async function syncConnectedAccount() {
    const injected = getWalletProvider();
    if (!injected) return;
    const accounts = await injected.request({ method: "eth_accounts" });
    setConnectState(accounts?.[0]);
  }

  function openHomeInfo(title = "提示", text = "请先完成当前操作。") {
    $("homeInfoTitle").textContent = title;
    $("homeInfoText").textContent = text;
    homeInfoModal?.classList.remove("hidden");
  }

  function closeHomeInfo() {
    homeInfoModal?.classList.add("hidden");
  }

  function toggleMobileMenu(forceOpen) {
    const shouldOpen = typeof forceOpen === "boolean" ? forceOpen : !mobileNavPanel?.classList.contains("is-open");
    mobileNavPanel?.classList.toggle("is-open", shouldOpen);
    mobileMenuBtn?.classList.toggle("is-open", shouldOpen);
    mobileMenuBtn?.setAttribute("aria-expanded", shouldOpen ? "true" : "false");
  }

  async function connectWallet() {
    const injected = getWalletProvider();
    if (!injected) {
      openHomeInfo("未检测到钱包", "请在 MetaMask、OKX、TokenPocket、Bitget 等钱包浏览器中打开，或先安装浏览器钱包。");
      return;
    }

    try {
      const accounts = await injected.request({ method: "eth_requestAccounts" });
      setConnectState(accounts?.[0]);
    } catch (err) {
      openHomeInfo("连接钱包失败", err?.message || "请稍后重试。");
    }
  }

  function openGuide(e) {
    if (e) e.preventDefault();
    guideModal?.classList.remove("hidden");
  }

  function closeGuide() {
    guideModal?.classList.add("hidden");
  }

  const hotPlayers = [
    ["Mbappé","Kylian Mbappé","法国","前锋",97,"皇家马德里","速度爆发与终结能力都属顶级。",["€1.8亿","S+","冲击终结"],["#0055a4","#ffffff","#ef4135"]],["Bellingham","Jude Bellingham","英格兰","中场",95,"皇家马德里","推进、对抗与覆盖能力兼具。",["€1.8亿","S+","全能推进"],["#012169","#ffffff","#c8102e"]],["Vinícius Jr","Vinícius Júnior","巴西","边锋",94,"皇家马德里","边路爆点，单挑威胁很强。",["€1.7亿","S","突破爆点"],["#009b3a","#fedf00","#002776"]],["Haaland","Erling Haaland","挪威","中锋",96,"曼城","门前效率极高，禁区统治力出色。",["€1.8亿","S+","禁区终结"],["#ba0c2f","#ffffff","#00205b"]],["Kane","Harry Kane","英格兰","前锋",93,"拜仁慕尼黑","支点、做球和射门都很稳定。",["€1亿","A+","支点射手"],["#012169","#ffffff","#c8102e"]],["Musiala","Jamal Musiala","德国","中场",92,"拜仁慕尼黑","盘带细腻，狭小空间处理突出。",["€1.3亿","A+","盘带创造"],["#000000","#dd0000","#ffce00"]],["Foden","Phil Foden","英格兰","前腰",92,"曼城","跑位灵动，前场连接能力强。",["€1.3亿","A+","灵巧组织"],["#012169","#ffffff","#c8102e"]],["Rodri","Rodri","西班牙","后腰",94,"曼城","攻防转换核心，节奏控制稳定。",["€1.1亿","A+","节奏屏障"],["#aa151b","#f1bf00","#aa151b"]],["Valverde","Federico Valverde","乌拉圭","中场",91,"皇家马德里","跑动覆盖大，推进远射兼备。",["€1.2亿","A","跑动远射"],["#6ec1e4","#ffffff","#6ec1e4"]],["Yamal","Lamine Yamal","西班牙","边锋",91,"巴塞罗那","年轻爆点，边路创造力极强。",["€1.2亿","S","新星爆点"],["#aa151b","#f1bf00","#aa151b"]],["Saka","Bukayo Saka","英格兰","边锋",90,"阿森纳","高效稳定，攻守平衡。",["€1.4亿","A+","效率均衡"],["#012169","#ffffff","#c8102e"]],["Wirtz","Florian Wirtz","德国","前腰",91,"勒沃库森","前场想象力强，最后一传威胁大。",["€1.3亿","A+","创造串联"],["#000000","#dd0000","#ffce00"]],["Pedri","Pedri","西班牙","中场",89,"巴塞罗那","控球细腻，擅长梳理传导。",["€1亿","A","控场传导"],["#aa151b","#f1bf00","#aa151b"]],["De Bruyne","Kevin De Bruyne","比利时","中场",93,"曼城","威胁传球和直塞仍属顶级。",["€7000万","A+","传球大师"],["#000000","#ffe936","#ef3340"]],["Osimhen","Victor Osimhen","尼日利亚","前锋",90,"加拉塔萨雷","纵深冲击强，抢点能力突出。",["€1亿","A","冲刺抢点"],["#008751","#ffffff","#008751"]],["Leão","Rafael Leão","葡萄牙","边锋",90,"AC米兰","边路推进极具爆发力。",["€9000万","A","推进速度"],["#006600","#ff0000","#ffcc00"]],["Bastoni","Alessandro Bastoni","意大利","中卫",88,"国际米兰","出球型中卫，防守阅读佳。",["€8000万","B+","中卫出球"],["#009246","#ffffff","#ce2b37"]],["Hakimi","Achraf Hakimi","摩洛哥","边卫",89,"巴黎圣日耳曼","边路往返能力和冲刺都很强。",["€7000万","A","边路冲刺"],["#c1272d","#ffffff","#006233"]],["Enzo","Enzo Fernández","阿根廷","中场",88,"切尔西","转移与对抗能力稳定。",["€8000万","B+","覆盖调度"],["#74acdf","#ffffff","#74acdf"]],["Álvarez","Julián Álvarez","阿根廷","前锋",89,"马德里竞技","前场逼抢积极，跑位聪明。",["€9000万","A","跑位压迫"],["#74acdf","#ffffff","#74acdf"]]
  ];

  async function fillPlayerAvatars() {
    const imgs = [...playersGrid.querySelectorAll("img[data-wiki]")];
    await Promise.all(imgs.map(async (img) => {
      try {
        const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(img.dataset.wiki)}`);
        const data = await res.json();
        const src = data?.thumbnail?.source || data?.originalimage?.source;
        if (src) {
          img.src = src;
          img.onload = () => img.closest(".player-avatar")?.classList.add("loaded");
        }
      } catch {}
    }));
  }

  function renderPlayers() {
    if (!playersGrid || playersGrid.dataset.ready) return;
    playersGrid.innerHTML = hotPlayers.map(([name,wiki,country,pos,rating,club,desc,tags,flag]) => `<article class="player-card"><div class="player-flag-strip">${flag.map((c) => `<i style="background:${c}"></i>`).join("")}</div><div class="player-avatar"><img data-wiki="${wiki}" alt="${name}头像"><span>${name.slice(0,1)}</span><em>${rating}</em></div><strong>${name}</strong><div class="player-meta"><span>${country}</span><span>${pos}</span><span>${club}</span></div><p>${desc}</p><div class="player-tags">${tags.map((tag) => `<b>${tag}</b>`).join("")}</div></article>`).join("");
    playersGrid.dataset.ready = "1";
    fillPlayerAvatars();
  }

  function openPlayers(e) {
    e?.preventDefault();
    renderPlayers();
    playersModal?.classList.remove("hidden");
  }

  function closePlayers() {
    playersModal?.classList.add("hidden");
  }

  function openFaq(e) {
    e.preventDefault();
    faqModal?.classList.remove("hidden");
  }

  function closeFaq() {
    faqModal?.classList.add("hidden");
  }

  connectBtn?.addEventListener("click", connectWallet);
  mobileMenuBtn?.addEventListener("click", () => toggleMobileMenu());
  mobileNavPanel?.querySelectorAll("a").forEach((link) => link.addEventListener("click", () => toggleMobileMenu(false)));
  openGuideBtn?.addEventListener("click", openGuide);
  openGuideBtnBottom?.addEventListener("click", openGuide);
  openGuideNavBtn?.addEventListener("click", openGuide);
  openGuideNavBtnBottom?.addEventListener("click", openGuide);
  closeGuideBtn?.addEventListener("click", closeGuide);

  openPlayersBtn?.addEventListener("click", openPlayers);
  closePlayersBtn?.addEventListener("click", closePlayers);

  openFaqBtn?.addEventListener("click", openFaq);
  openFaqBtnBottom?.addEventListener("click", openFaq);
  closeFaqBtn?.addEventListener("click", closeFaq);
  closeHomeInfoBtn?.addEventListener("click", closeHomeInfo);
  confirmHomeInfoBtn?.addEventListener("click", closeHomeInfo);

  guideModal?.addEventListener("click", (e) => {
    if (e.target === guideModal) {
      closeGuide();
    }
  });

  playersModal?.addEventListener("click", (e) => {
    if (e.target === playersModal) closePlayers();
  });

  faqModal?.addEventListener("click", (e) => {
    if (e.target === faqModal) {
      closeFaq();
    }
  });

  homeInfoModal?.addEventListener("click", (e) => {
    if (e.target === homeInfoModal) {
      closeHomeInfo();
    }
  });

  const injected = getWalletProvider();
  injected?.on?.("accountsChanged", (accounts) => {
    setConnectState(accounts?.[0]);
  });
  injected?.on?.("chainChanged", () => {
    syncConnectedAccount();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    toggleMobileMenu(false);
    if (!playersModal?.classList.contains("hidden")) closePlayers();
    if (!homeInfoModal?.classList.contains("hidden")) closeHomeInfo();
    if (!guideModal?.classList.contains("hidden")) closeGuide();
    if (!faqModal?.classList.contains("hidden")) closeFaq();
  });

  syncConnectedAccount();
})();