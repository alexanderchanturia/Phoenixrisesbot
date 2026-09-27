(function () {
  const tg = window.Telegram?.WebApp;
  if (tg) { tg.ready(); tg.expand(); }

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
  async function api(path, body) {
    const res = await fetch(apiUrl(path), {
      method: body ? 'POST' : 'GET',
      headers: apiHeaders(),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw await res.json().catch(() => ({ error: 'request_failed' }));
    return res.json();
  }

  const GROW_MAX = 3;
  const els = {
    coinValue: document.getElementById('coinValue'),
    shardValue: document.getElementById('shardValue'),
    energyText: document.getElementById('energyText'),
    levelValue: document.getElementById('levelValue'),
    perTapValue: document.getElementById('perTapValue'),
    phoenixTap: document.getElementById('phoenixTap'),
    embers: document.getElementById('embers'),
    tapHint: document.getElementById('tapHint'),
    lpFraction: document.getElementById('lpFraction'),
    lpFill: document.getElementById('lpFill'),
    levelUpBtn: document.getElementById('levelUpBtn'),
    nestRate: document.getElementById('nestRate'),
    nestPending: document.getElementById('nestPending'),
    claimNestBtn: document.getElementById('claimNestBtn'),
    spinStatus: document.getElementById('spinStatus'),
    spinBtn: document.getElementById('spinBtn'),
    taskList: document.getElementById('taskList'),
  };

  let state = null; // { user, shopCosts, growCosts, tasks }
  let pendingTaps = 0;
  let flushTimer = null;

  function fmt(n) { return Math.floor(n).toLocaleString('en-US'); }

  function switchTab(name) {
    document.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = p.id !== `tab-${name}`; });
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  }
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  function render() {
    if (!state) return;
    const u = state.user;

    els.coinValue.textContent = fmt(u.coins + pendingTaps * u.per_tap);
    els.shardValue.textContent = u.shards.toFixed(1);
    els.levelValue.textContent = u.level;
    els.perTapValue.textContent = u.per_tap;

    const displayEnergy = Math.max(0, Math.floor(u.energy) - pendingTaps);
    els.energyText.textContent = `${displayEnergy}/${u.max_energy}`;
    els.tapHint.textContent = displayEnergy <= 0 ? 'out of energy' : 'tap the flame';

    // Level progress: sum of 3 categories out of 9
    const sum = u.feed_progress + u.nest_progress + u.flame_progress;
    els.lpFraction.textContent = `${sum}/9`;
    els.lpFill.style.width = `${(sum / 9) * 100}%`;
    els.levelUpBtn.hidden = !u.can_level_up;

    ['feed', 'nest', 'flame'].forEach((kind) => {
      const progress = u[`${kind}_progress`];
      document.getElementById(`progress-${kind}`).textContent = `${progress}/${GROW_MAX}`;
      const costEl = document.getElementById(`cost-${kind}`);
      const cost = state.growCosts[kind];
      const card = document.querySelector(`.grow-card[data-kind="${kind}"]`);
      if (cost == null) {
        costEl.textContent = 'MAX';
        card.disabled = true;
      } else {
        costEl.textContent = cost;
        card.disabled = u.coins < cost;
      }
    });

    // Rewards tab
    els.nestRate.textContent = u.nest_rate;
    els.nestPending.textContent = u.pending_shards.toFixed(2);
    els.claimNestBtn.disabled = u.pending_shards < 0.01;

    // Shop tab
    ['tap', 'energy', 'regen'].forEach((kind) => {
      const level = u[`${kind}_level`];
      const cost = state.shopCosts[kind];
      document.getElementById(`level-${kind}`).textContent = `lv. ${level}`;
      document.getElementById(`cost-${kind}`) && (document.getElementById(`cost-${kind}`).textContent = cost);
      const btn = document.getElementById(`upgrade-${kind}`);
      if (btn) btn.disabled = u.coins < cost;
    });

    // Tasks tab
    els.taskList.innerHTML = '';
    state.tasks.forEach((t) => {
      const card = document.createElement('div');
      card.className = 'task-card';
      const btnLabel = t.claimed ? '✓ Done' : t.ready ? 'Claim' : `${t.progress}/${t.target}`;
      const rewardText = [
        t.reward.coins ? `🔥${t.reward.coins}` : null,
        t.reward.shards ? `💎${t.reward.shards}` : null,
      ].filter(Boolean).join(' ');
      card.innerHTML = `
        <div class="task-info">
          <span class="task-name">${t.name}</span>
          <span class="task-progress">${rewardText} · ${Math.min(t.progress, t.target)}/${t.target}</span>
        </div>
        <button class="task-claim-btn ${t.claimed ? 'done' : ''}" data-task="${t.id}" ${t.claimed || !t.ready ? 'disabled' : ''}>${btnLabel}</button>
      `;
      els.taskList.appendChild(card);
    });
    document.querySelectorAll('.task-claim-btn').forEach((btn) => {
      btn.addEventListener('click', () => claimTask(btn.dataset.task));
    });
  }

  function applyState(data) {
    state = data;
    render();
  }

  async function loadState() {
    try {
      applyState(await api('/api/state'));
    } catch {
      els.tapHint.textContent = 'could not connect';
    }
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
    try { applyState(await api('/api/tap', { count })); } catch {}
  }

  els.phoenixTap.addEventListener('click', (e) => {
    if (!state) return;
    const remaining = Math.floor(state.user.energy) - pendingTaps;
    if (remaining <= 0) { tg?.HapticFeedback?.notificationOccurred('error'); return; }
    pendingTaps += 1;
    tg?.HapticFeedback?.impactOccurred('light');

    const rect = els.phoenixTap.getBoundingClientRect();
    const x = rect.left + rect.width * (0.3 + Math.random() * 0.4);
    const y = rect.top + rect.height * (0.3 + Math.random() * 0.3);
    spawnEmber(x, y);

    render();
    scheduleFlush();
  });

  document.querySelectorAll('.grow-card').forEach((card) => {
    card.addEventListener('click', async () => {
      try {
        applyState(await api('/api/grow', { kind: card.dataset.kind }));
        tg?.HapticFeedback?.notificationOccurred('success');
      } catch {}
    });
  });

  els.levelUpBtn.addEventListener('click', async () => {
    try {
      const data = await api('/api/levelup');
      applyState(data);
      tg?.HapticFeedback?.notificationOccurred('success');
      const msg = `Level up! +${data.reward.coins} ash-coin, +${data.reward.shards} ember-shard`;
      if (tg?.showAlert) tg.showAlert(msg); else alert(msg);
    } catch {}
  });

  els.claimNestBtn.addEventListener('click', async () => {
    try {
      const data = await api('/api/nest/claim');
      applyState(data);
      tg?.HapticFeedback?.notificationOccurred('success');
    } catch {}
  });

  els.spinBtn.addEventListener('click', async () => {
    try {
      const data = await api('/api/spin');
      applyState(data);
      els.spinStatus.textContent = `You won: ${data.reward.label}`;
      tg?.HapticFeedback?.notificationOccurred('success');
    } catch (err) {
      if (err.error === 'already_spun') {
        const hoursLeft = Math.ceil((err.nextSpinAt - Date.now()) / 3600000);
        els.spinStatus.textContent = `Come back in ~${hoursLeft}h for your next free spin.`;
        els.spinBtn.disabled = true;
      }
    }
  });

  document.querySelectorAll('#tab-shop .upgrade-card').forEach((card) => {
    card.addEventListener('click', async () => {
      try {
        applyState(await api('/api/shop/upgrade', { kind: card.dataset.kind }));
        tg?.HapticFeedback?.notificationOccurred('success');
      } catch {}
    });
  });

  async function claimTask(taskId) {
    try {
      const data = await api('/api/task/claim', { taskId });
      applyState(data);
      tg?.HapticFeedback?.notificationOccurred('success');
    } catch {}
  }

  setInterval(() => {
    if (!state) return;
    state.user.energy = Math.min(state.user.max_energy, state.user.energy + state.user.energy_regen_per_sec);
    state.user.pending_shards += state.user.nest_rate / 3600;
    render();
  }, 1000);

  setInterval(loadState, 15000);
  loadState();
})();
