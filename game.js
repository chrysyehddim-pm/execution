const FONT = { STATION_LABEL: 17, BUBBLE: 17, FLOATING: 19 };

// --- Firebase 初始化 ---
const firebaseConfig = {
  apiKey: "AIzaSyB6wcFs5gSiNDCSweKcEzgRpbIAAb5I3Vo",
  authDomain: "smart-squat-health.firebaseapp.com",
  projectId: "smart-squat-health",
  storageBucket: "smart-squat-health.firebasestorage.app",
  messagingSenderId: "475970550783",
  appId: "1:475970550783:web:2d7dcacb2e55b562eb05ca"
};
if (!firebase.apps.length) { firebase.initializeApp(firebaseConfig); }
const db = firebase.firestore();

let userInfo = { name: "", age: 0 };

function initGameSession() {
    const name = document.getElementById('playerName').value.trim();
    const age = document.getElementById('playerAge').value.trim();
    if (!name || !age) { alert("請輸入姓名與年齡！"); return; }
    userInfo.name = name; userInfo.age = parseInt(age);
    Game.start();
}

// --- 生物標記追蹤器 (Biomarker Engine) ---
class BiomarkerTracker {
  constructor() { this.reset(); }
  reset() {
    this.phase1StartTime = 0; this.phase2StartTime = 0; this.lastActionTime = 0;
    this.metrics = { redundantClicks: 0, interClickIntervals: [], planningLatencies: [], taskSwitchRTs: [], ruleReconfigLatency: null, commissionErrors: 0, hitRTs: [] };
    this.currentTaskType = null; this.activeTaskStarts = {}; 
  }
  markPhase1Start() { this.phase1StartTime = performance.now(); this.lastActionTime = this.phase1StartTime; }
  markPhase2Start() { this.phase2StartTime = performance.now(); }
  taskAppeared(taskId, type) { this.activeTaskStarts[taskId] = performance.now(); }
  recordInteraction(isRedundant = false) {
    const now = performance.now();
    if (isRedundant) { this.metrics.redundantClicks++; } 
    else { const interval = now - this.lastActionTime; if (interval < 3000) { this.metrics.interClickIntervals.push(interval); } }
    this.lastActionTime = now;
  }
  recordMainTaskAction(taskId, type) {
    const now = performance.now();
    if (this.activeTaskStarts[taskId]) { this.metrics.planningLatencies.push(now - this.activeTaskStarts[taskId]); delete this.activeTaskStarts[taskId]; }
    if (this.currentTaskType && this.currentTaskType !== type) { this.metrics.taskSwitchRTs.push(now - this.lastActionTime); }
    this.currentTaskType = type; this.lastActionTime = now;
  }
  recordRestockTap(isCorrect) {
    const now = performance.now();
    if (this.metrics.ruleReconfigLatency === null) { this.metrics.ruleReconfigLatency = now - this.phase2StartTime; }
    if (isCorrect) { this.metrics.hitRTs.push(now - this.lastActionTime); } else { this.metrics.commissionErrors++; }
    this.lastActionTime = now;
  }
  getAverage(arr) { return arr.length ? arr.reduce((a, b) => a + b) / arr.length : 0; }
  exportClinicalData() {
    return {
      planning_latency_avg_ms: Math.round(this.getAverage(this.metrics.planningLatencies)),
      inter_click_interval_avg_ms: Math.round(this.getAverage(this.metrics.interClickIntervals)),
      switching_cost_avg_ms: Math.round(this.getAverage(this.metrics.taskSwitchRTs)),
      rule_reconfig_latency_ms: this.metrics.ruleReconfigLatency ? Math.round(this.metrics.ruleReconfigLatency) : -1,
      restock_hit_rt_avg_ms: Math.round(this.getAverage(this.metrics.hitRTs)),
      commission_errors: this.metrics.commissionErrors,
      redundant_clicks: this.metrics.redundantClicks
    };
  }
}
const Tracker = new BiomarkerTracker();

// --- 核心遊戲引擎 (Game Engine) ---
const Game = {
  canvas: null, ctx: null, width: 0, height: 0, dpr: 1,
  state: 'menu', coins: 0, completedOrders: 0, timerInterval: null,
  totalTime: 60, timeLeft: 60, phase: 1,
  
  player: null, stations: [], customers: [], particles: [], floatingTexts: [],
  coffeeProgress: 0, coffeeRunning: false, coffeeReady: false, coffeeTask: null, coffeeQueue: [],
  microwaveProgress: 0, microwaveRunning: false, microwaveReady: false, microwaveTask: null, microwaveQueue: [],
  playerHolding: null, currentTask: null,
  
  layout: { counterY: 0, machineY: 0, packageY: 0, waitAreaY: 0, stationSize: 30 },
  waitAreaLeft: { x: 0, y: 0 }, waitAreaRight: { x: 0, y: 0 },

  init() {
    this.canvas = document.getElementById('game-canvas'); this.ctx = this.canvas.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;
    this.resize(); window.addEventListener('resize', () => this.resize());
    this.canvas.addEventListener('click', e => this.handleClick(e));
    Panels.init(); ScanPanel.init();
    this.loop();
  },
  
  resize() {
    const container = document.getElementById('game-container');
    this.width = container.clientWidth; this.height = container.clientHeight;
    this.canvas.width = this.width * this.dpr; this.canvas.height = this.height * this.dpr;
    this.canvas.style.width = this.width + 'px'; this.canvas.style.height = this.height + 'px';
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    
    const TOP_UI_HEIGHT = 110;
    const availableHeight = this.height - TOP_UI_HEIGHT;
    this.layout.counterY = TOP_UI_HEIGHT + availableHeight * 0.6;
    this.layout.machineY = TOP_UI_HEIGHT + availableHeight * 0.25;
    this.layout.packageY = this.layout.machineY;
    this.layout.waitAreaY = this.layout.counterY + 40;
    this.layout.stationSize = Math.max(28, Math.min(this.width * 0.09, 40));
    
    this.waitAreaLeft = { x: this.width * 0.2, y: this.layout.waitAreaY };
    this.waitAreaRight = { x: this.width * 0.8, y: this.layout.waitAreaY };
    
    if(this.state === 'playing') this.setupStations();
  },
  
  start() {
    document.getElementById('start-screen').classList.add('hide');
    document.getElementById('result-screen').classList.remove('show');
    this.state = 'playing'; this.phase = 1; this.timeLeft = this.totalTime;
    this.coins = 0; this.completedOrders = 0;
    this.customers = []; this.particles = []; this.floatingTexts = [];
    this.coffeeRunning = false; this.microwaveRunning = false;
    this.coffeeReady = false; this.microwaveReady = false;
    this.coffeeQueue = []; this.microwaveQueue = [];
    this.playerHolding = null; this.currentTask = null;
    
    Tracker.reset(); Tracker.markPhase1Start();
    this.setupStations();
    this.player = new Player(this.width / 2, this.layout.counterY - 40);
    TaskManager.init();
    this.updateTimeDisplay();
    document.getElementById('coin-value').textContent = 0;
    document.getElementById('order-progress').textContent = 0;
    
    if(this.timerInterval) clearInterval(this.timerInterval);
    this.timerInterval = setInterval(() => {
      this.timeLeft--; this.updateTimeDisplay();
      if (this.timeLeft === 15 && this.phase === 1) { this.triggerPhase2(); }
      if (this.timeLeft <= 0) { clearInterval(this.timerInterval); this.endGame(); }
    }, 1000);
    setTimeout(() => CustomerManager.spawnNext(), 500);
  },

  returnToHome() {
    document.getElementById('result-screen').classList.remove('show');
    document.getElementById('start-screen').classList.remove('hide');
    // 可選擇是否清空輸入框，目前保留方便快速重測
  },

  triggerPhase2() {
    this.phase = 2; Panels.hide();
    if (ScanPanel.isOpen) ScanPanel.complete(true);
    this.canvas.style.filter = 'blur(4px) brightness(0.6)';
    document.getElementById('current-task-bar').style.display = 'none';

    // 暫停主計時器
    clearInterval(this.timerInterval);
    this.timerInterval = null;

    // 顯示 5 秒規則畫面
    const ruleScreen = document.getElementById('phase2-rules');
    ruleScreen.classList.add('show');
    
    let countdown = 5;
    const countEl = document.getElementById('rule-countdown');
    countEl.textContent = countdown;

    const cdInterval = setInterval(() => {
      countdown--;
      countEl.textContent = countdown;
      if (countdown <= 0) {
        clearInterval(cdInterval);
        ruleScreen.classList.remove('show');
        
        // 5秒結束後，恢復遊戲並開始計算醫療指標
        Tracker.markPhase2Start(); 
        RestockGame.startGameSeamlessly();
        this.timerInterval = setInterval(() => {
          this.timeLeft--; this.updateTimeDisplay();
          if (this.timeLeft <= 0) { clearInterval(this.timerInterval); this.endGame(); }
        }, 1000);
      }
    }, 1000);
  },
  
  updateTimeDisplay() { document.getElementById('time-display').textContent = `0:${this.timeLeft.toString().padStart(2,'0')}`; },

  setupStations() {
    const w = this.width, L = this.layout, sz = L.stationSize;
    this.stations = [
      new Station('counter', w * 0.5, L.counterY - 18, sz, '💳', '收銀台'),
      new Station('coffee', w * 0.22, L.machineY, sz, '☕', '咖啡機'),
      new Station('microwave', w * 0.78, L.machineY, sz, '🔥', '微波爐'),
      new Station('packages', w * 0.5, L.packageY, sz, '📦', '包裹架'),
    ];
  },

handleClick(e) {
    if (this.state !== 'playing' || this.phase === 2 || Panels.isOpen || ScanPanel.isOpen) { Tracker.recordInteraction(true); return; }
    const rect = this.canvas.getBoundingClientRect(); const x = e.clientX - rect.left, y = e.clientY - rect.top;
    
    if (this.playerHolding) {
      if (this.playerHolding.type === 'coffee' && Math.hypot(x - this.waitAreaLeft.x, y - this.waitAreaLeft.y) < 60) {
        this.player.moveTo(this.waitAreaLeft.x, this.layout.counterY - 20, () => this.deliverToWaitArea('coffee')); return;
      }
      if (this.playerHolding.type === 'bento' && Math.hypot(x - this.waitAreaRight.x, y - this.waitAreaRight.y) < 60) {
        this.player.moveTo(this.waitAreaRight.x, this.layout.counterY - 20, () => this.deliverToWaitArea('bento')); return;
      }
    }

    // 允許直接點擊「正在櫃檯等待的顧客」進行結帳/接單
    const counterCustomer = this.customers.find(c => c.state === 'waiting' && c.targetX === this.width / 2 && !c.task.completed);
    if (counterCustomer) {
      // 以顧客身體為中心的點擊判定半徑
      if (Math.hypot(x - counterCustomer.x, y - counterCustomer.y) < 50) {
        this.player.moveTo(this.stations[0].x, this.layout.counterY - 40, () => this.interact(this.stations[0]));
        return;
      }
    }

    for (const s of this.stations) {
      if (Math.hypot(x - s.x, y - s.y) < s.size + 25) {
        const targetY = s.type === 'counter' ? this.layout.counterY - 40 : s.y + s.size + 15;
        this.player.moveTo(s.x, targetY, () => this.interact(s)); return;
      }
    }
    Tracker.recordInteraction(true);
    const clampedY = Math.max(this.layout.machineY + this.layout.stationSize + 20, Math.min(y, this.layout.counterY - 10));
    this.player.moveTo(x, clampedY);
  },

  interact(station) {
    Tracker.recordInteraction();
    if (station.type === 'coffee') {
      if (this.coffeeReady) { 
        this.coffeeReady = false; this.playerHolding = {type:'coffee', emoji:'☕'}; 
        this.showToast('☕ 取出咖啡，請送至左側等待區', 'success'); return; 
      }
      if (this.coffeeRunning) { this.showToast('沖泡中，請稍候'); return; }
      const task = TaskManager.findTaskByTypeAndStep('coffee', 'make');
      if (task) { Panels.showCoffee(task); return; }
    }
    else if (station.type === 'microwave') {
      if (this.microwaveReady) { 
        this.microwaveReady = false; this.playerHolding = {type:'bento', emoji:'🍱'}; 
        this.showToast('🍱 取出餐點，請送至右側等待區', 'success'); return; 
      }
      if (this.microwaveRunning) { this.showToast('加熱中，請稍候'); return; }
      const task = TaskManager.findTaskByTypeAndStep('bento', 'heat');
      if (task) { Panels.showMicrowave(task); return; }
    }
    else if (station.type === 'packages') {
      const task = TaskManager.findTaskByTypeAndStep('package', 'find');
      if (task && this.currentTask === task) { Panels.showPackage(task); return; }
    }
    else if (station.type === 'counter') {
      if (this.playerHolding && this.playerHolding.type === 'package') {
         const t = TaskManager.findTaskByTypeAndStep('package', 'checkout');
         if(t) { this.completeTask(t); this.playerHolding = null; return; }
      }
      const task = TaskManager.findFirstCounterTask();
      if (task) {
        if (task.step === 'pay') {
          this.processPayment(task);
        } else if (task.step === 'find') {
          this.currentTask = task; Tracker.recordMainTaskAction(task.id, task.type);
          this.showToast('請去尋找包裹');
        } else if (task.step === 'scan') {
          this.currentTask = task; Tracker.recordMainTaskAction(task.id, task.type);
          ScanPanel.show(task);
        }
        TaskManager.renderUI(); return;
      }
    }
    station.doShake(); Tracker.recordInteraction(true);
  },

  processPayment(task) {
    Tracker.recordMainTaskAction(task.id, task.type);
    if (task.type === 'coffee') {
      task.step = 'make'; this.coffeeQueue.push(task); this.showToast('已結帳，請去咖啡機製作');
    } else if (task.type === 'bento') {
      task.step = 'heat'; this.microwaveQueue.push(task); this.showToast('已結帳，請去微波爐加熱');
    }
    const customer = this.customers.find(c => c.task === task);
    if (customer) { 
      customer.state = 'toWait';
      // 加入稍微的擾動偏移，避免同一區等待的客人完全重疊
      const offset = (Math.random() * 40) - 20;
      customer.targetX = (task.type === 'coffee' ? this.waitAreaLeft.x : this.waitAreaRight.x) + offset;
      customer.targetY = task.type === 'coffee' ? this.waitAreaLeft.y : this.waitAreaRight.y;
    }
    this.currentTask = task;
    setTimeout(() => CustomerManager.spawnNext(), 200); // 強制並行機制
  },

  deliverToWaitArea(type) {
    if (type === 'coffee' && this.coffeeTask) {
      const task = this.coffeeTask;
      this.coffeeTask = null; this.playerHolding = null;
      this.completeTask(task);
    } else if (type === 'bento' && this.microwaveTask) {
      const task = this.microwaveTask;
      this.microwaveTask = null; this.playerHolding = null;
      this.completeTask(task);
    }
  },

  completeTask(task) {
    task.completed = true; this.completedOrders++;
    document.getElementById('order-progress').textContent = this.completedOrders;
    this.coins += 50; document.getElementById('coin-value').textContent = this.coins;
    this.addCoins(50, this.width/2, this.layout.counterY - 20);
    this.floatingTexts.push(new FloatingText(this.width/2, this.layout.counterY - 40, '✅完成', '#22c55e'));
    this.currentTask = null;
    const customer = this.customers.find(c => c.task === task);
    if(customer) customer.leave();
    setTimeout(() => CustomerManager.spawnNext(), 200);
    TaskManager.renderUI();
  },

  addCoins(n, x, y) {
    for (let i = 0; i < Math.min(n/10, 5); i++) { setTimeout(() => this.particles.push(new Particle(x, y)), i * 30); }
  },
  showToast(msg, type) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.className = type === 'success' ? 'show success' : 'show';
    setTimeout(() => { t.className = ''; }, 1500);
  },

  async endGame() {
    this.state = 'ended'; RestockGame.end();
    this.canvas.style.filter = 'none'; document.getElementById('current-task-bar').style.display = 'flex';
    const metrics = Tracker.exportClinicalData();
    
    document.getElementById('res-orders').textContent = this.completedOrders;
    document.getElementById('res-rt').textContent = metrics.planning_latency_avg_ms;
    document.getElementById('res-commission').textContent = metrics.commission_errors;
    document.getElementById('res-reconfig').textContent = metrics.rule_reconfig_latency_ms;
    document.getElementById('res-redundant').textContent = metrics.redundant_clicks;
    document.getElementById('result-screen').classList.add('show');

    const payload = {
      user_name: userInfo.name, user_age: userInfo.age, timestamp: Date.now(),
      total_score: this.coins + RestockGame.score * 8, clinical_metrics: metrics
    };
    
    const statusEl = document.getElementById('upload-status');
    statusEl.style.display = 'block'; statusEl.textContent = '資料上傳中...';
    try {
      await db.collection("executive_function_poc").add(payload);
      statusEl.innerHTML = `<span style="color:#4ade80">✅ 數據已上傳至 Firebase</span>`;
    } catch(e) { statusEl.innerHTML = `<span style="color:#f87171">❌ 上傳失敗: ${e.message}</span>`; }
    document.getElementById('db-output').textContent = JSON.stringify(payload, null, 2);
  },

  loop() {
    if (this.state === 'playing' && this.phase === 1) {
      // 超高速進度條 (約 0.8~1 秒完成)
      if (this.coffeeRunning) { this.coffeeProgress += 2.0; if(this.coffeeProgress>=100) { this.coffeeRunning = false; this.coffeeReady = true; this.coffeeProgress=0; }}
      if (this.microwaveRunning) { this.microwaveProgress += 2.0; if(this.microwaveProgress>=100) { this.microwaveRunning = false; this.microwaveReady = true; this.microwaveProgress=0; }}
      this.player?.update();
      this.stations.forEach(s => s.update());
      this.customers.forEach(c => c.update());
      this.customers = this.customers.filter(c => c.alive);
      this.particles = this.particles.filter(p => { p.update(); return p.alive; });
      this.floatingTexts = this.floatingTexts.filter(f => { f.update(); return f.alive; });
    }
    this.render();
    requestAnimationFrame(() => this.loop());
  },

  render() {
    const ctx = this.ctx, L = this.layout; ctx.clearRect(0, 0, this.width, this.height);
    if(this.state !== 'playing') return;
    
    ctx.fillStyle = '#334155'; ctx.fillRect(0, 110, this.width, L.counterY - 110);
    ctx.fillStyle = '#0f172a'; ctx.fillRect(0, L.counterY, this.width, this.height - L.counterY);

    this.renderWaitArea(ctx, this.waitAreaLeft, '☕咖啡等待');
    this.renderWaitArea(ctx, this.waitAreaRight, '🍱微波等待');

    const renderList = [];
    this.stations.forEach(s => {
      let sortY = s.y; if (s.type === 'counter') sortY += 10;
      renderList.push({ y: sortY, draw: () => {
          s.render(ctx);
          if (s.type === 'coffee') s.renderProgress(ctx, this.coffeeProgress, this.coffeeRunning, this.coffeeReady);
          if (s.type === 'microwave') s.renderProgress(ctx, this.microwaveProgress, this.microwaveRunning, this.microwaveReady);
      }});
    });
    this.customers.forEach(c => { renderList.push({ y: c.y, draw: () => c.render(ctx) }); });
    if (this.player) { renderList.push({ y: this.player.y, draw: () => this.player.render(ctx, this.playerHolding) }); }

    renderList.sort((a, b) => a.y - b.y);
    renderList.forEach(obj => obj.draw());

    this.particles.forEach(p => p.render(ctx));
    this.floatingTexts.forEach(f => f.render(ctx));
  },

  renderWaitArea(ctx, area, label) {
    const w = 90, h = 40;
    ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.strokeStyle = '#475569'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(area.x - w/2, area.y - h/2, w, h, 8); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#9ca3af'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, area.x, area.y);
  }
};

// --- 面板邏輯 ---
const Panels = {
  isOpen: false, currentTask: null, selected: {},
  init() {
    ['coffee-size', 'coffee-type', 'coffee-temp', 'microwave-time'].forEach(group => {
      document.querySelectorAll(`#${group}-btns .panel-btn`).forEach(b => {
        b.onclick = () => { Tracker.recordInteraction(); this.sel(group.split('-')[0], group.split('-')[1], b.dataset.v); }
      });
    });
    document.getElementById('coffee-confirm').onclick = () => { Tracker.recordInteraction(); this.confirmCoffee(); };
    document.getElementById('microwave-confirm').onclick = () => { Tracker.recordInteraction(); this.confirmMicrowave(); };
  },
  sel(panel, key, val) {
    this.selected[key] = val;
    document.getElementById(`${panel}-${key}-btns`).querySelectorAll('.panel-btn').forEach(b => b.classList.toggle('selected', b.dataset.v === val));
    if (panel === 'coffee') document.getElementById('coffee-confirm').disabled = !(this.selected.size && this.selected.type && this.selected.temp);
    else document.getElementById('microwave-confirm').disabled = !this.selected.time;
  },
  showCoffee(task) { 
    this.isOpen=true; this.currentTask=task; this.selected={}; 
    document.querySelectorAll('#coffee-panel .panel-btn').forEach(b=>b.classList.remove('selected')); 
    document.getElementById('coffee-order-display').textContent = task.bubble;
    document.getElementById('coffee-panel').classList.add('show'); document.getElementById('coffee-confirm').disabled=true;
  },
  showMicrowave(task) { 
    this.isOpen=true; this.currentTask=task; this.selected={}; 
    document.querySelectorAll('#microwave-panel .panel-btn').forEach(b=>b.classList.remove('selected')); 
    document.getElementById('microwave-order-display').textContent = task.bubble;
    document.getElementById('microwave-panel').classList.add('show'); document.getElementById('microwave-confirm').disabled=true;
  },
  showPackage(task) { 
    this.isOpen=true; this.currentTask=task; 
    const grid = document.getElementById('package-grid'); grid.innerHTML = '';
    const codes = [task.packageCode]; while(codes.length<8){ const c=String(Math.floor(Math.random()*900)+100); if(!codes.includes(c)) codes.push(c); }
    codes.sort(()=>Math.random()-0.5).forEach(code => {
      const btn = document.createElement('button'); btn.className = 'package-btn'; btn.textContent = code;
      btn.onclick = () => { Tracker.recordInteraction(); this.selectPackage(code); }; grid.appendChild(btn);
    });
    document.getElementById('package-panel').classList.add('show');
  },
  selectPackage(code) {
    if(code === this.currentTask.packageCode) { this.currentTask.step = 'checkout'; Game.playerHolding = {type:'package', emoji:'📦'}; Game.showToast('找到包裹，回櫃台結帳', 'success'); this.hide(); }
    else { Tracker.recordInteraction(true); Game.showToast('號碼不對'); }
  },
  confirmCoffee() { 
    const t = this.currentTask; const c = t.coffee;
    if (this.selected.size === c.size && this.selected.type === c.type && this.selected.temp === c.temp) {
      Game.coffeeRunning = true; Game.coffeeTask = t; t.step = 'waiting'; this.hide(); Game.showToast('開始沖泡', 'success'); 
    } else { Tracker.recordInteraction(true); Game.showToast('❌ 選擇錯誤！'); }
  },
  confirmMicrowave() { 
    const t = this.currentTask;
    if (parseInt(this.selected.time) === t.microwave) {
      Game.microwaveRunning = true; Game.microwaveTask = t; t.step = 'waiting'; this.hide(); Game.showToast('開始加熱', 'success'); 
    } else { Tracker.recordInteraction(true); Game.showToast('❌ 時間錯誤！'); }
  },
  hide() { this.isOpen=false; document.querySelectorAll('.action-panel').forEach(p=>p.classList.remove('show')); }
};

const ScanPanel = {
  isOpen: false, currentTask: null, items: [], total: 0,
  init() { document.getElementById('scan-confirm').onclick = () => { Tracker.recordInteraction(); this.complete(false); }; },
  show(task) {
    this.isOpen=true; this.currentTask=task; this.total=0; this.items=[{icon:'🥤', price:25, s:false}, {icon:'🍙', price:35, s:false}];
    this.render(); document.getElementById('scan-panel').classList.add('show');
  },
  render() {
    const el = document.getElementById('scan-items'); el.innerHTML = '';
    this.items.forEach(i => {
      const d = document.createElement('div'); d.className = 'scan-item' + (i.s ? ' scanned' : ''); d.textContent = i.icon;
      d.onclick = () => { Tracker.recordInteraction(); if(!i.s) { i.s=true; this.total+=i.price; this.render(); } }; el.appendChild(d);
    });
    document.getElementById('scan-confirm').disabled = !this.items.every(i=>i.s);
  },
  complete(forced) {
    this.isOpen=false; document.getElementById('scan-panel').classList.remove('show');
    if(!forced) { this.currentTask.step = 'done'; Game.completeTask(this.currentTask); }
  }
};

const RestockGame = {
  isOpen: false, timer: null, score: 0, mistakes: 0,
  products: ['🥤','🥛','🍙','🍞','🥪'], // 牛奶已改為Emoji
  startGameSeamlessly() {
    this.isOpen = true; this.score = 0; this.mistakes = 0;
    document.getElementById('restock-panel').classList.add('show');
    document.getElementById('restock-items').innerHTML = '';
    this.updateScore();
    this.timer = setInterval(() => this.spawnItem(), 600);
  },
  spawnItem() {
    if(!this.isOpen) return;
    const container = document.getElementById('restock-items');
    const isExpired = Math.random() < 0.4;
    const div = document.createElement('div');
    div.className = 'restock-item pop-in' + (isExpired ? ' expired' : '');
    div.style.left = (20 + Math.random()*60) + '%'; div.style.top = (20 + Math.random()*60) + '%';
    div.innerHTML = `<span class="item-icon">${this.products[Math.floor(Math.random()*this.products.length)]}</span>`;
    
    div.onclick = (e) => { 
      e.stopPropagation(); 
      Tracker.recordRestockTap(!isExpired);
      if(isExpired) { this.mistakes++; div.classList.add('wrong'); }
      else { this.score++; div.classList.add('correct'); Game.coins += 8; document.getElementById('coin-value').textContent = Game.coins; }
      this.updateScore(); setTimeout(()=> div.remove(), 200);
    };
    container.appendChild(div); setTimeout(()=> { if(div.parentElement) div.remove(); }, 1200);
  },
  updateScore() { document.getElementById('restock-score').textContent = this.score; document.getElementById('restock-mistakes').textContent = this.mistakes; },
  end() { this.isOpen = false; clearInterval(this.timer); document.getElementById('restock-panel').classList.remove('show'); }
};

// --- 視覺類別 (Player, Customer, Station, FX) ---
class Player {
  constructor(x, y) {
    this.x = x; this.y = y; this.tx = x; this.ty = y;
    this.speed = 7.5; this.size = 32; this.moving = false; this.onArrive = null;
    this.animFrame = 0; this.facing = 1; 
  }
  moveTo(x, y, cb) {
    this.tx = x; this.ty = y; this.moving = true; this.onArrive = cb;
    if (x < this.x - 5) this.facing = -1;
    if (x > this.x + 5) this.facing = 1;
  }
  update() {
    if (!this.moving) { this.animFrame = (Date.now() / 500) % (Math.PI * 2); return; }
    const dx = this.tx - this.x, dy = this.ty - this.y, d = Math.hypot(dx, dy);
    if (d < this.speed) {
      this.x = this.tx; this.y = this.ty; this.moving = false;
      if (this.onArrive) { this.onArrive(); this.onArrive = null; }
    } else {
      this.x += dx / d * this.speed; this.y += dy / d * this.speed; this.animFrame += 0.3;
      if (Math.abs(dx) > 0.5) this.facing = dx > 0 ? 1 : -1;
    }
  }
  render(ctx, holding) {
    const x = this.x, y = this.y, s = this.size;
    const walkBob = this.moving ? Math.sin(this.animFrame) * 3 : Math.sin(this.animFrame) * 1;
    const handSwing = this.moving ? Math.cos(this.animFrame) * 8 : 0;
    
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.beginPath(); ctx.ellipse(x, y + s/2 + 2, s/2.5, s/6, 0, 0, Math.PI * 2); ctx.fill();
    ctx.save(); ctx.translate(0, walkBob); 
    ctx.fillStyle = '#3b82f6'; 
    const legOffset = this.moving ? Math.sin(this.animFrame) * 6 : 0;
    ctx.beginPath(); ctx.arc(x - 6 + legOffset, y + s/2, 5, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(x + 6 - legOffset, y + s/2, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#16a34a'; ctx.beginPath(); ctx.roundRect(x - s/2 + 2, y - s/2 + 5, s - 4, s - 5, 12); ctx.fill();
    ctx.fillStyle = '#f59e0b'; ctx.beginPath();
    ctx.moveTo(x - 11, y - 5); ctx.lineTo(x + 11, y - 5); ctx.lineTo(x + 13, y + s/2 - 4);
    ctx.quadraticCurveTo(x, y + s/2 + 2, x - 13, y + s/2 - 4); ctx.fill();
    ctx.fillStyle = '#d97706'; ctx.beginPath(); ctx.arc(x, y + 4, 7, 0, Math.PI, false); ctx.fill();

    const handY = holding ? y - 5 : y + 5; const handXOffset = holding ? 14 : 16;
    ctx.fillStyle = '#fcd34d'; 
    if (!holding) {
        ctx.beginPath(); ctx.arc(x - handXOffset + handSwing * 0.5, handY - handSwing * 0.3, 5, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(x + handXOffset - handSwing * 0.5, handY + handSwing * 0.3, 5, 0, Math.PI * 2); ctx.fill();
    } else {
        ctx.beginPath(); ctx.arc(x - 12, y - 8, 5, 0, Math.PI*2); ctx.fill();
        ctx.beginPath(); ctx.arc(x + 12, y - 8, 5, 0, Math.PI*2); ctx.fill();
    }

    const headY = y - 16; ctx.fillStyle = '#fcd34d';
    ctx.beginPath(); ctx.arc(x, headY, 14, 0, Math.PI * 2); ctx.fill();
    const faceX = x + (this.facing * 4); ctx.fillStyle = '#1e293b';
    ctx.beginPath(); ctx.arc(faceX - 3, headY - 1, 2, 0, Math.PI * 2); ctx.arc(faceX + 3, headY - 1, 2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(239, 68, 68, 0.2)'; ctx.beginPath(); ctx.arc(faceX - 5, headY + 3, 2.5, 0, Math.PI*2); ctx.arc(faceX + 5, headY + 3, 2.5, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#f59e0b'; ctx.beginPath(); ctx.arc(x, headY - 4, 14.5, Math.PI, 2 * Math.PI); ctx.fill();
    ctx.fillStyle = '#d97706'; ctx.beginPath();
    if (this.facing === 1) { ctx.moveTo(x, headY - 4); ctx.quadraticCurveTo(x + 20, headY, x + 16, headY - 10); } 
    else { ctx.moveTo(x, headY - 4); ctx.quadraticCurveTo(x - 20, headY, x - 16, headY - 10); }
    ctx.fill();

    if (holding) { ctx.font = '28px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(holding.emoji, x, y - 12 + Math.sin(Date.now()/200)*2); }
    ctx.restore();
  }
}

class Customer {
  constructor(task) {
    this.x = Game.width / 2; this.y = Game.height + 30; this.targetX = this.x; this.targetY = Game.layout.counterY + 40;
    this.task = task; this.state = 'entering'; this.alive = true; this.alpha = 0; this.size = 28;
    this.color = ['#ef4444', '#f97316', '#84cc16', '#06b6d4', '#8b5cf6', '#ec4899', '#6366f1'][Math.floor(Math.random() * 7)];
    this.hairColor = ['#1a1a1a', '#4a3018', '#854d0e', '#fef3c7', '#9ca3af'][Math.floor(Math.random() * 5)];
    this.hairStyle = Math.floor(Math.random() * 4); this.hasGlasses = Math.random() < 0.3; this.bobOffset = Math.random() * 100;
  }
  leave() { this.state = 'leaving'; }
  update() {
    const speed = 0.15;
    if (this.state === 'entering' || this.state === 'toWait') { 
      this.alpha = Math.min(1, this.alpha + 0.1); 
      this.x += (this.targetX - this.x) * speed; 
      this.y += (this.targetY - this.y) * speed; 
      if (Math.abs(this.y - this.targetY) < 2 && Math.abs(this.x - this.targetX) < 2) this.state = 'waiting'; 
    }
    else if (this.state === 'leaving') { 
      this.y += 4; this.alpha -= 0.08; if (this.alpha <= 0) this.alive = false; 
    }
  }
  render(ctx) {
    if (Game.phase === 2 || this.alpha <= 0) return;
    ctx.globalAlpha = this.alpha;
    const bounce = Math.sin((Date.now() + this.bobOffset) / 300) * 2;
    const y = this.y + bounce, s = this.size;
    const hx = this.x, hy = y - 12, hr = s/2.2;

    // 身體發光提示：僅在櫃檯等待且尚未處理時發出黃色呼吸光
    if (this.state === 'waiting' && this.targetX === Game.width / 2 && !this.task.completed) {
      ctx.shadowColor = '#fbbf24';
      ctx.shadowBlur = 15 + Math.sin(Date.now() / 150) * 10;
    } else {
      ctx.shadowBlur = 0;
    }

    ctx.fillStyle = this.hairColor;
    if (this.hairStyle === 1) { ctx.beginPath(); ctx.moveTo(hx - hr, hy); ctx.lineTo(hx - hr - 2, hy + 16); ctx.lineTo(hx + hr + 2, hy + 16); ctx.lineTo(hx + hr, hy); ctx.fill(); }
    ctx.fillStyle = 'rgba(0,0,0,0.2)'; ctx.beginPath(); ctx.ellipse(this.x, this.y + s/2 + 2, s/2, s/6, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = this.color; ctx.beginPath(); ctx.roundRect(this.x - s/2, y - s/3, s, s, 10); ctx.fill();
    
    ctx.shadowBlur = 0; // 重置陰影，避免影響其他五官繪製

    ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.beginPath(); ctx.arc(this.x, y - 6, s/3, 0, Math.PI); ctx.fill();
    ctx.fillStyle = '#fce7f3'; ctx.beginPath(); ctx.arc(hx, hy, hr, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = '#1e293b';
    if (this.hasGlasses) { 
        ctx.strokeStyle = '#333'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(hx - 4, hy + 1, 3.5, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.arc(hx + 4, hy + 1, 3.5, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.moveTo(hx-1, hy+1); ctx.lineTo(hx+1, hy+1); ctx.stroke(); 
    } else { ctx.beginPath(); ctx.arc(hx - 4, hy, 2, 0, Math.PI * 2); ctx.arc(hx + 4, hy, 2, 0, Math.PI * 2); ctx.fill(); }
    ctx.strokeStyle = '#c97b5d'; ctx.lineWidth = 1.5; ctx.beginPath();
    if (this.hairStyle % 2 === 0) { ctx.arc(hx, hy + 5, 3, 0.2 * Math.PI, 0.8 * Math.PI); } else { ctx.moveTo(hx - 2, hy + 6); ctx.lineTo(hx + 2, hy + 6); } ctx.stroke();

    ctx.fillStyle = this.hairColor; ctx.beginPath();
    if (this.hairStyle === 0 || this.hairStyle === 1) { ctx.arc(hx, hy, hr + 1, Math.PI, 0); } 
    else if (this.hairStyle === 2) { ctx.arc(hx, hy, hr + 1, Math.PI, 0); ctx.fill(); ctx.beginPath(); ctx.arc(hx + 8, hy - 12, 6, 0, Math.PI * 2); } 
    else { ctx.arc(hx, hy - 4, hr - 0.5, Math.PI, 0); } ctx.fill();

    // 繪製對話框：僅在未結帳/找包裹階段顯示，一旦去等待區即徹底隱藏
    const needsToSpeak = !this.task.completed && (this.task.step === 'pay' || this.task.step === 'find' || this.task.step === 'scan');
    
    if (needsToSpeak && (this.state === 'waiting' || this.state === 'entering')) {
      let txt = this.task.bubble;
      ctx.font = `bold ${FONT.BUBBLE}px sans-serif`;
      const tw = ctx.measureText(txt).width + 16, th = 28;
      const bx = this.x + s + 10 + tw/2, by = y - 5;
      
      ctx.fillStyle = 'rgba(255,255,255,0.95)'; 
      ctx.beginPath(); ctx.roundRect(bx - tw/2, by - th/2, tw, th, 8); ctx.fill();
      ctx.beginPath(); ctx.moveTo(bx - tw/2, by - 5); ctx.lineTo(bx - tw/2, by + 5); ctx.lineTo(bx - tw/2 - 8, by); ctx.fill();
      
      ctx.fillStyle = '#1e293b'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(txt, bx, by);
    }
    ctx.globalAlpha = 1;
  }
}

class Station {
  constructor(type, x, y, size, icon, name) {
    this.type = type; this.x = x; this.y = y; this.size = size; this.icon = icon; this.name = name;
    this.scale = 1; this.shakeAmount = 0;
    if (type === 'packages') {
      this.decorBoxes = []; const shelfLevels = [-25, 0, 25];
      for(let i=0; i<4; i++) {
        const w = 12 + Math.random() * 8, h = 10 + Math.random() * 6;
        const levelY = shelfLevels[Math.floor(Math.random() * shelfLevels.length)];
        this.decorBoxes.push({ x: (Math.random() - 0.5) * 46, y: levelY - (h / 2), w: w, h: h, color: ['#d97706', '#b45309', '#92400e'][Math.floor(Math.random()*3)] });
      }
      this.decorBoxes.sort((a, b) => a.y - b.y);
    }
  }
  doShake() { this.shakeAmount = 6; }
  update() { this.scale += (1-this.scale)*0.12; this.shakeAmount *= 0.85; }
  render(ctx) {
    const x = this.x + Math.sin(Date.now()/40)*this.shakeAmount, y = this.y, s = this.size * this.scale;
    ctx.save(); ctx.translate(x, y); ctx.scale(this.scale, this.scale); 
    if (this.type === 'coffee') this.drawCoffeeMachine(ctx);
    else if (this.type === 'microwave') this.drawMicrowave(ctx);
    else if (this.type === 'packages') this.drawPackageShelf(ctx);
    else if (this.type === 'counter') this.drawCounter(ctx);
    ctx.restore();

    const labelY = this.type === 'counter' ? y + 55 : y + s + 35;
    ctx.font = `bold ${FONT.STATION_LABEL}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.strokeText(this.name, x, labelY);
    ctx.fillStyle = '#ffffff'; ctx.fillText(this.name, x, labelY);
  }
  renderProgress(ctx, progress, running, ready) {
    if (!running && !ready) return;
    const x = this.x, y = this.y - this.size - 20;
    
    if (ready) {
      ctx.shadowColor = '#fbbf24'; ctx.shadowBlur = 20;
      ctx.fillStyle = '#22c55e'; ctx.font = '18px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('✨完成', x, y);
      ctx.shadowBlur = 0;
    } else if (running) {
      const w = 40, h = 8;
      ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(x - w/2, y - h/2, w, h);
      ctx.fillStyle = '#f59e0b'; ctx.fillRect(x - w/2, y - h/2, w * (progress/100), h);
    }
  }
  drawCoffeeMachine(ctx) {
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.ellipse(0, 25, 30, 8, 0, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#94a3b8'; ctx.beginPath(); ctx.roundRect(-25, -30, 50, 60, 8); ctx.fill();
    ctx.fillStyle = '#64748b'; ctx.beginPath(); ctx.roundRect(-25, -30, 50, 15, 8); ctx.fill();
    ctx.fillStyle = '#1e293b'; ctx.fillRect(-20, -10, 40, 30);
    ctx.fillStyle = '#cbd5e1'; ctx.fillRect(-5, -10, 10, 8);
    ctx.fillStyle = 'rgba(255,255,255,0.2)'; ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(-12, 18); ctx.lineTo(-10, 5); ctx.lineTo(10, 5); ctx.lineTo(12, 18); ctx.stroke();
    ctx.fillStyle = '#78350f'; ctx.beginPath(); ctx.moveTo(-11, 16); ctx.lineTo(-10, 10); ctx.lineTo(10, 10); ctx.lineTo(11, 16); ctx.fill();
    ctx.fillStyle = Game.coffeeRunning ? '#ef4444' : '#22c55e'; ctx.beginPath(); ctx.arc(15, -22, 3, 0, Math.PI*2); ctx.fill();
  }
  drawMicrowave(ctx) {
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.ellipse(0, 22, 35, 8, 0, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#f1f5f9'; ctx.beginPath(); ctx.roundRect(-30, -20, 60, 40, 6); ctx.fill();
    ctx.fillStyle = Game.microwaveRunning ? '#fcd34d' : '#334155'; ctx.beginPath(); ctx.roundRect(-25, -15, 35, 30, 4); ctx.fill();
    ctx.fillStyle = '#cbd5e1'; ctx.fillRect(15, -15, 10, 30);
    ctx.fillStyle = '#64748b'; ctx.beginPath(); ctx.arc(20, -8, 2, 0, Math.PI*2); ctx.fill(); ctx.beginPath(); ctx.arc(20, 0, 2, 0, Math.PI*2); ctx.fill(); ctx.beginPath(); ctx.arc(20, 8, 2, 0, Math.PI*2); ctx.fill();
  }
  drawPackageShelf(ctx) {
    ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.ellipse(0, 25, 35, 8, 0, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#78350f'; ctx.fillRect(-30, -30, 5, 60); ctx.fillRect(25, -30, 5, 60);  
    ctx.fillStyle = '#b45309'; ctx.fillRect(-30, -25, 60, 5); ctx.fillRect(-30, 0, 60, 5); ctx.fillRect(-30, 25, 60, 5);   
    if (this.decorBoxes) {
      this.decorBoxes.forEach((b, index) => {
        const bx = b.x - b.w/2, by = b.y - b.h/2;
        ctx.fillStyle = index % 2 === 0 ? '#d97706' : '#b45309'; ctx.fillRect(bx, by, b.w, b.h);
        ctx.strokeStyle = 'rgba(0,0,0,0.1)'; ctx.lineWidth = 1; ctx.strokeRect(bx, by, b.w, b.h);
        ctx.fillStyle = '#fcd34d'; ctx.fillRect(b.x - 2, by, 4, b.h); ctx.fillRect(bx, b.y - 4, b.w, 4);
      });
    }
  }
  drawCounter(ctx) {
    const offsetY = 5;
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.beginPath(); ctx.ellipse(0, 30 + offsetY, 25, 6, 0, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#d97706'; ctx.beginPath(); ctx.roundRect(-23, 15 + offsetY, 46, 14, 4); ctx.fill();
    ctx.fillStyle = '#92400e'; ctx.beginPath(); ctx.roundRect(-23, 25 + offsetY, 46, 6, 4); ctx.fill();
    const machineY = offsetY - 2;
    ctx.fillStyle = '#475569'; ctx.beginPath(); ctx.roundRect(-18, 8 + machineY, 36, 10, 3); ctx.fill();
    ctx.fillStyle = '#1e293b'; ctx.fillRect(-5, -4 + machineY, 10, 12);
    ctx.fillStyle = '#f1f5f9'; ctx.beginPath(); ctx.roundRect(-17, -26 + machineY, 34, 22, 4); ctx.fill();
    ctx.fillStyle = '#cbd5e1'; ctx.beginPath(); ctx.roundRect(-10, -20 + machineY, 20, 4, 1); ctx.fill();
    ctx.fillStyle = '#1e293b'; ctx.fillRect(-3, -30 + machineY, 6, 8); 
    ctx.fillStyle = '#0f172a'; ctx.beginPath(); ctx.roundRect(-14, -38 + machineY, 28, 12, 3); ctx.fill();
    ctx.fillStyle = '#000'; ctx.beginPath(); ctx.roundRect(-12, -36 + machineY, 24, 8, 1); ctx.fill();
    const currentTotal = ScanPanel.isOpen ? ScanPanel.total : 0;
    ctx.fillStyle = '#22c55e'; ctx.font = 'bold 8px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(`$${currentTotal}`, 0, -32 + machineY);
    const printerX = 20;
    ctx.fillStyle = '#94a3b8'; ctx.beginPath(); ctx.roundRect(printerX, -2 + machineY, 10, 12, 2); ctx.fill();
    ctx.fillStyle = '#1e293b'; ctx.fillRect(printerX + 1, -4 + machineY, 8, 2);
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(printerX + 2, -3 + machineY); ctx.lineTo(printerX + 2, -8 + machineY); ctx.lineTo(printerX + 8, -8 + machineY); ctx.lineTo(printerX + 8, -3 + machineY); ctx.fill();
  }
}

class Particle {
  constructor(x, y) { this.x = x; this.y = y; this.vx = (Math.random()-0.5)*4; this.vy = -Math.random()*5-2; this.life = 0; this.alive = true; this.size = 12; const ui = document.getElementById('coin-display').getBoundingClientRect(); this.tx = ui.left + ui.width/2; this.ty = ui.top + ui.height/2; }
  update() { this.life++; if (this.life < 12) { this.vy += 0.3; this.x += this.vx; this.y += this.vy; } else { this.x += (this.tx-this.x)*0.2; this.y += (this.ty-this.y)*0.2; this.size *= 0.9; } if (this.life > 40 || this.size < 2) this.alive = false; }
  render(ctx) { ctx.font = `${this.size}px sans-serif`; ctx.textAlign = 'center'; ctx.fillText('🪙', this.x, this.y); }
}

class FloatingText {
  constructor(x, y, text, color) { this.x = x; this.y = y; this.text = text; this.color = color; this.alpha = 1; this.alive = true; }
  update() { this.y -= 1; this.alpha -= 0.03; if (this.alpha <= 0) this.alive = false; }
  render(ctx) { ctx.globalAlpha = this.alpha; ctx.font = `bold ${FONT.FLOATING}px sans-serif`; ctx.textAlign = 'center'; ctx.fillStyle = this.color; ctx.fillText(this.text, this.x, this.y); ctx.globalAlpha = 1; }
}

// --- 動態複合文案與任務管理器 ---
const TaskManager = {
  tasks: [],
  templates: [
    { type: 'coffee', step: 'pay', coffee: {} },
    { type: 'bento', step: 'pay', microwave: 0 },
    { type: 'package', step: 'find', packageCode: '' },
    { type: 'checkout', step: 'scan', bubble: '🛒結帳' }
  ],
  init() { this.tasks = []; },
  spawn() {
    const t = JSON.parse(JSON.stringify(this.templates[Math.floor(Math.random()*this.templates.length)]));
    t.id = Date.now() + Math.random(); t.completed = false;
    
    // 動態文案生成
    if (t.type === 'coffee') {
      const temps = ['熱', '溫', '冰'];
      const sizes = ['中杯', '大杯'];
      const types = ['美式', '拿鐵'];
      t.coffee.temp = temps[Math.floor(Math.random() * temps.length)];
      t.coffee.size = sizes[Math.floor(Math.random() * sizes.length)];
      t.coffee.type = types[Math.floor(Math.random() * types.length)];
      t.bubble = `☕${t.coffee.size}${t.coffee.temp}${t.coffee.type}`;
    } else if (t.type === 'bento') {
      t.microwave = Math.floor(Math.random() * 3) + 1; // 1, 2, 3 分鐘
      const emoji = t.microwave === 1 ? '🥪' : t.microwave === 2 ? '🍙' : '🍱';
      t.bubble = `${emoji}微波${t.microwave}分鐘`;
    } else if (t.type === 'package') { 
      t.packageCode = String(Math.floor(Math.random()*900)+100); 
      t.bubble = '📦'+t.packageCode; 
    }
    
    this.tasks.push(t); Tracker.taskAppeared(t.id, t.type); return t;
  },
  findTaskByTypeAndStep(type, step) { return this.tasks.find(t => !t.completed && t.type === type && t.step === step); },
  findFirstCounterTask() { return this.tasks.find(t => !t.completed && (t.step==='pay' || t.step==='find' || t.step==='scan')); },
  renderUI() {
    const active = this.tasks.filter(t => !t.completed);
    document.getElementById('task-name').textContent = active.length ? '處理中...' : '等待顧客...';
  }
};

const CustomerManager = {
  spawnNext() {
    if(Game.phase === 2 || Game.state !== 'playing') return;
    const hasCounterCustomer = Game.customers.some(c => !c.task.completed && (c.task.step === 'pay' || c.task.step === 'find' || c.task.step === 'scan'));
    if(!hasCounterCustomer) {
      const task = TaskManager.spawn();
      Game.customers.push(new Customer(task));
      TaskManager.renderUI();
    }
  }
};

window.onload = () => { Game.init(); };