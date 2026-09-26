(function () {
  const tg = window.Telegram?.WebApp;
  if (tg) {
    tg.ready();
    tg.expand();
  }

  // In real Telegram, initData is set automatically. For local browser testing
  // outside Telegram, fall back to a fake dev user id via the URL query string,
  // e.g. index.html?devUserId=12345
  const initData = tg?.initData || '';
  const urlParams = new URLSearchParams(window.location.search);
  const devUserId = urlParams.get('devUserId');

  function apiHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (initData) headers['X-Telegram-Init-Data'] = initData;
    return headers;
  }

  function apiUrl(path) {
    if (!initData && devUserId) {
      const sep = path.includes('?') ? '&' : '?';
      return `${path}${sep}devUserId=${devUserId}`;
    }
    return path;
  }

  const els = {
    coinValue: document.getElementById('coinValue'),
    energyFill: document.getElementById('energyFill'),
    energyText: document.getElementById('energyText'),
    perTapValue: document.getElementById('perTapValue'),
    phoenixTap: document.getElementById('phoenixTap'),
    embers: document.getElementById('embers'),
    tapHint: document.getElementById('tapHint'),
  };

  const upgradeKinds = ['tap', 'energy', 'regen'];
  let state = null;
  let pendingTaps = 0;
  let flushTimer = null;

  function formatCoins(n) {
    return Math.floor(n).toLocaleString('en-US');
  }

  function render() {
    if (!state) return;
    els.coinValue.textContent = formatCoins(state.coins + pendingTaps * state.per_tap);
    els.perTapValue.textContent = state.per_tap;

    const displayEnergy = Math.max(0, Math.floor(state.energy) - pendingTaps);
    const pct = Math.max(0, Math.min(100, (displayEnergy / state.max_energy) * 100));
    els.energyFill.style.width = pct + '%';
    els.energyText.textContent = `${displayEnergy} / ${state.max_energy}`;
    els.tapHint.textContent = displayEnergy <= 0 ? 'out of energy — wait for it to refill' : 'tap the flame';

    upgradeKinds.forEach((kind) => {
      const level = state[`${kind}_level`];
      const cost = state.costs ? state.costs[kind] : null;
      document.getElementById(`level-${kind}`).textContent = `lv. ${level}`;
      const costEl = document.getElementById(`cost-${kind}`);
      if (cost != null) costEl.textContent = cost;
      const btn = document.getElementById(`upgrade-${kind}`);
      btn.disabled = cost != null && state.coins < cost;
    });
  }

  async function loadState() {
    const res = await fetch(apiUrl('/api/state'), { headers: apiHeaders() });
    if (!res.ok) {
      els.tapHint.textContent = 'could not connect — open this from the Telegram bot';
      return;
    }
    const data = await res.json();
    state = { ...data.user, costs: data.costs };
    render();
  }

  function spawnEmber(x, y) {
    const p = document.createElement('div');
    p.className = 'ember-particle';
    p.style.left = x + 'px';
    p.style.top = y + 'px';
    p.style.setProperty('--drift', (Math.random() * 60 - 30) + 'px');
    els.embers.appendChild(p);
    setTimeout(() => p.remove(), 1200);
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flushTaps, 500);
  }

  async function flushTaps() {
    flushTimer = null;
    if (pendingTaps <= 0) return;
    const count = pendingTaps;
    pendingTaps = 0;

    const res = await fetch(apiUrl('/api/tap'), {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ count }),
    });
    if (res.ok) {
      const data = await res.json();
      state = { ...state, ...data.user };
      render();
    }
  }

  els.phoenixTap.addEventListener('click', (e) => {
    if (!state) return;
    const remainingEnergy = Math.floor(state.energy) - pendingTaps;
    if (remainingEnergy <= 0) {
      tg?.HapticFeedback?.notificationOccurred('error');
      return;
    }
    pendingTaps += 1;
    tg?.HapticFeedback?.impactOccurred('light');

    const rect = els.phoenixTap.getBoundingClientRect();
    const x = (e.clientX || rect.left + rect.width / 2) - rect.left * 0 + (rect.left + rect.width * (0.3 + Math.random() * 0.4));
    const y = rect.top + rect.height * (0.3 + Math.random() * 0.3);
    spawnEmber(x, y);

    render();
    scheduleFlush();
  });

  upgradeKinds.forEach((kind) => {
    document.getElementById(`upgrade-${kind}`).addEventListener('click', async () => {
      if (!state || state.costs?.[kind] == null) return;
      if (state.coins < state.costs[kind]) return;

      const res = await fetch(apiUrl('/api/upgrade'), {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({ kind }),
      });
      if (res.ok) {
        const data = await res.json();
        state = { ...data.user, costs: data.costs };
        tg?.HapticFeedback?.notificationOccurred('success');
        render();
      }
    });
  });

  // Regenerate energy visually between server syncs, and pull a fresh
  // authoritative state periodically.
  setInterval(() => {
    if (!state) return;
    state.energy = Math.min(state.max_energy, state.energy + state.energy_regen_per_sec);
    render();
  }, 1000);

  setInterval(loadState, 15000);

  loadState();
})();
