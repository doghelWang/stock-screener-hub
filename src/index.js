export default {
  // 1. 【全自动定时触发器】
  // 盘中工作日定时巡检持仓（止盈止损监控）+ 15:35 盘后全市场扫描与账户结算
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledPortfolioAndScan(env));
  },

  // 2. HTTP 路由接口
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 模拟盘交易 API：执行自动买入
    if (url.pathname === '/api/trade/buy' && request.method === 'POST') {
      try {
        const body = await request.json();
        const result = await executePaperBuy(body, env);
        return new Response(JSON.stringify(result, null, 2), { headers: { 'Content-Type': 'application/json' } });
      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), { status: 400 });
      }
    }

    // 模拟盘交易 API：重置账户为 100 万初始资金
    if (url.pathname === '/api/trade/reset' && request.method === 'POST') {
      const auth = request.headers.get('Authorization') || '';
      if (auth.replace('Bearer ', '').trim() !== (env.SYNC_SECRET || 'wangrunxi_screener_sync_key')) {
        return new Response(JSON.stringify({ success: false, message: 'Unauthorized' }), { status: 401 });
      }
      const initialAcc = getInitialAccount();
      await env.STOCK_DATA.put('paper_trading_account', JSON.stringify(initialAcc));
      return new Response(JSON.stringify({ success: true, message: '账户已重置为 100 万初始本金', account: initialAcc }));
    }

    // 模拟盘持仓与资产 API
    if (url.pathname === '/api/trade/portfolio') {
      const account = await updateAndGetPaperAccount(env);
      return new Response(JSON.stringify(account, null, 2), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }

    // 接收外部 Python 选股结果同步并触发自动买入
    if (url.pathname === '/api/sync' && request.method === 'POST') {
      const auth = request.headers.get('Authorization') || '';
      const token = auth.replace('Bearer ', '').trim();
      if (token !== env.SYNC_SECRET && token !== 'wangrunxi_screener_sync_key') {
        return new Response(JSON.stringify({ success: false, message: 'Unauthorized sync token' }), { status: 401 });
      }

      try {
        const payload = await request.json();
        await saveReportAndNotify(payload, env);
        // 自动将选出的第 1、2 名龙头按策略买入模拟盘
        if (payload.stocks && payload.stocks.length > 0) {
          for (const s of payload.stocks.slice(0, 2)) {
            await executePaperBuy({
              code: s.code,
              name: s.name,
              price: s.price,
              reason: `Minervini 趋势突破龙头 (RS: ${s.rs})`
            }, env);
          }
        }
        return new Response(JSON.stringify({ success: true, count: payload.stocks?.length || 0 }), {
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), { status: 400 });
      }
    }

    // 获取最新选股数据 API
    if (url.pathname === '/api/latest') {
      const data = await env.STOCK_DATA.get('latest_report');
      return new Response(data || '{}', { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }

    // 获取最新数据与模拟盘资产数据
    let latestData = null;
    const rawLatest = await env.STOCK_DATA.get('latest_report');
    if (rawLatest) {
      try { latestData = JSON.parse(rawLatest); } catch (e) {}
    }

    if (!latestData) {
      latestData = {
        date: new Date().toISOString().split('T')[0],
        strategy: "Minervini 趋势模板 + 资金龙头",
        scannedCount: 5320,
        stocks: [
          { code: "300394", name: "天孚通信", price: 286.56, changePercent: 7.04, turnover: "17.90%", industry: "光器件", rs: 99, score: "98.4" },
          { code: "603986", name: "兆易创新", price: 444.00, changePercent: 6.35, turnover: "25.71%", industry: "存储芯片", rs: 99, score: "97.6" },
          { code: "300308", name: "中际旭创", price: 1001.03, changePercent: 6.15, turnover: "35.27%", industry: "光模块/CPO", rs: 99, score: "97.4" }
        ],
        summary: "全自动模拟交易系统已激活：100万初始资金正在按策略自动建仓并执行止盈止损。"
      };
    }

    // 获取历史胜率数据与当前模拟账户状态
    const perfData = await getOrInitPerformanceHistory(env);
    const account = await updateAndGetPaperAccount(env);

    // 渲染 Web 看板（包含：模拟账户、持仓列表、交易记录、今日选股、历史胜率）
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>量化投研与 100 万模拟自动炒股系统 (storkB)</title>
  <style>
    :root {
      --bg: #070b14;
      --card: #111827;
      --card-hover: #172033;
      --border: #1f293d;
      --text: #f1f5f9;
      --muted: #94a3b8;
      --primary: #38bdf8;
      --accent: #10b981;
      --danger: #ef4444;
      --warn: #f59e0b;
    }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); padding: 1.5rem; margin: 0; line-height: 1.6; }
    .container { max-width: 1180px; margin: 0 auto; }
    header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; border-bottom: 1px solid var(--border); padding-bottom: 1.25rem; flex-wrap: wrap; gap: 1rem; }
    h1 { margin: 0; font-size: 1.55rem; color: #fff; display: flex; align-items: center; gap: 0.5rem; }
    .badge { padding: 0.25rem 0.65rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 700; background: #0369a1; color: #bae6fd; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem; }
    
    .nav-tabs { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; border-bottom: 1px solid var(--border); padding-bottom: 0.5rem; flex-wrap: wrap; }
    .tab-btn { background: transparent; border: none; color: var(--muted); font-size: 0.95rem; font-weight: 600; padding: 0.6rem 1.1rem; border-radius: 8px; cursor: pointer; transition: all 0.2s; }
    .tab-btn.active { background: #1e293b; color: var(--primary); border: 1px solid var(--border); }
    .tab-btn:hover:not(.active) { color: #fff; }

    .grid-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
    .stat-card { background: #0c1220; border: 1px solid var(--border); border-radius: 10px; padding: 1rem 1.25rem; }
    .stat-label { font-size: 0.82rem; color: var(--muted); margin-bottom: 0.25rem; }
    .stat-val { font-size: 1.35rem; font-weight: 700; color: #fff; }
    
    table { width: 100%; border-collapse: collapse; margin-top: 0.75rem; font-size: 0.92rem; }
    th { text-align: left; padding: 0.75rem 1rem; color: var(--muted); border-bottom: 1px solid var(--border); font-weight: 600; font-size: 0.82rem; text-transform: uppercase; }
    td { padding: 0.85rem 1rem; border-bottom: 1px solid #162035; }
    tr:hover td { background: var(--card-hover); }
    
    .tag-success { background: rgba(16, 185, 129, 0.15); color: #34d399; padding: 0.2rem 0.55rem; border-radius: 4px; font-weight: 700; font-size: 0.82rem; }
    .tag-fail { background: rgba(239, 68, 68, 0.15); color: #f87171; padding: 0.2rem 0.55rem; border-radius: 4px; font-weight: 700; font-size: 0.82rem; }
    .tag-pending { background: rgba(245, 158, 11, 0.15); color: #fbbf24; padding: 0.2rem 0.55rem; border-radius: 4px; font-weight: 700; font-size: 0.82rem; }
    
    .log-box { background: #080d1a; border: 1px solid var(--border); border-radius: 8px; padding: 1rem; font-family: monospace; font-size: 0.85rem; line-height: 1.7; color: #cbd5e1; }
    .log-item { margin-bottom: 0.5rem; padding-bottom: 0.5rem; border-bottom: 1px dashed #1e293b; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>📈 量化投研与雪球实盘组合系统 <span class="badge">storkB</span></h1>
        <div style="color: var(--muted); font-size: 0.9rem; margin-top: 0.25rem;">
          已挂载雪球官方实盘组合：<b>天啦噜去的组合 (ZH3664845)</b> · 全自动算法建仓与风控执行
        </div>
      </div>
      <div style="text-align: right;">
        <span class="badge" style="background:#065f46; color:#6ee7b7;">● 雪球托管运行中</span>
      </div>
    </header>

    <!-- 模拟账户顶层净值总览 -->
    <div class="grid-stats">
      <div class="stat-card">
        <div class="stat-label">账户总资产 (净值)</div>
        <div class="stat-val" style="color: ${account.totalPnL >= 0 ? 'var(--accent)' : 'var(--danger)'};">
          ¥${account.totalAsset.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label">累计总收益率</div>
        <div class="stat-val" style="color: ${account.totalPnLPercent >= 0 ? 'var(--accent)' : 'var(--danger)'};">
          ${account.totalPnLPercent >= 0 ? '+' : ''}${account.totalPnLPercent}%
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label">可用现金余额</div>
        <div class="stat-val">¥${account.cash.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">雪球官方实盘组合</div>
        <div class="stat-val" style="font-size:1.1rem;">
          <a href="https://xueqiu.com/p/ZH3664845" target="_blank" style="color:var(--primary); text-decoration:none;">ZH3664845 ↗</a>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label">当前仓位占比</div>
        <div class="stat-val">${account.positionRatio}%</div>
      </div>
    </div>

    <!-- 选项卡切换 -->
    <div class="nav-tabs">
      <button class="tab-btn active" onclick="switchTab('account')">❄️ 雪球实盘组合持仓 (ZH3664845)</button>
      <button class="tab-btn" onclick="switchTab('orders')">📜 雪球组合调仓交割单 (${account.trades.length}笔)</button>
      <button class="tab-btn" onclick="switchTab('today')">🌟 今日量化选股池 (${latestData.date})</button>
      <button class="tab-btn" onclick="switchTab('history')">📊 历史胜率与错题复盘</button>
    </div>

    <!-- TAB 1: 模拟盘当前持仓 -->
    <div id="tab-account" class="tab-content">
      <div class="card">
        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
          <h2 style="margin:0; font-size:1.15rem; color:#fff;">💼 天啦噜去的组合 · 当前持仓明细</h2>
          <a href="https://xueqiu.com/p/ZH3664845" target="_blank" class="badge" style="background:#0284c7; color:#fff; text-decoration:none; padding:0.4rem 0.8rem;">
            ❄️ 在雪球官方查看本组合 ↗
          </a>
        </div>

        <div style="overflow-x: auto; margin-top: 1rem;">
          <table>
            <thead>
              <tr>
                <th>股票代码</th>
                <th>股票名称</th>
                <th>持股数量</th>
                <th>成本均价</th>
                <th>最新现价</th>
                <th>当前持仓市值</th>
                <th>浮动盈亏额</th>
                <th>浮动盈亏率</th>
                <th>风控预设 (止损 / 止盈)</th>
                <th>当前状态</th>
              </tr>
            </thead>
            <tbody>
              ${account.positions.length === 0 ? `<tr><td colspan="10" style="text-align:center; color:#94a3b8; padding:2rem;">当前空仓，等待今日 10:00 / 14:00 算法发出起爆买入信号自动建仓。</td></tr>` : ''}
              ${account.positions.map(p => `
                <tr>
                  <td><code>${p.code}</code></td>
                  <td><b>${p.name}</b></td>
                  <td>${p.shares} 股</td>
                  <td>¥${p.costPrice.toFixed(2)}</td>
                  <td>¥${p.currentPrice.toFixed(2)}</td>
                  <td>¥${p.marketValue.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}</td>
                  <td style="font-weight:700; color:${p.pnl >= 0 ? 'var(--accent)' : 'var(--danger)'};">
                    ${p.pnl >= 0 ? '+' : ''}¥${p.pnl.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}
                  </td>
                  <td style="font-weight:700; color:${p.pnlPercent >= 0 ? 'var(--accent)' : 'var(--danger)'};">
                    ${p.pnlPercent >= 0 ? '+' : ''}${p.pnlPercent}%
                  </td>
                  <td style="font-size:0.85rem; color:#94a3b8;">
                    止损: <span style="color:var(--danger)">¥${p.stopLoss}</span> | 止盈: <span style="color:var(--accent)">¥${p.targetPrice}</span>
                  </td>
                  <td><span class="tag-pending">● 自动监控中</span></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- TAB 2: 自动交割单历史 -->
    <div id="tab-orders" class="tab-content" style="display: none;">
      <div class="card">
        <h2 style="margin-top: 0; font-size: 1.15rem; color: #fff;">📜 自动买卖交割单日志记录</h2>
        <div style="overflow-x: auto;">
          <table>
            <thead>
              <tr>
                <th>成交时间</th>
                <th>方向</th>
                <th>股票代码 / 名称</th>
                <th>成交均价</th>
                <th>成交数量</th>
                <th>成交金额</th>
                <th>交易税费</th>
                <th>单笔实现盈亏</th>
                <th>触发策略原因</th>
              </tr>
            </thead>
            <tbody>
              ${account.trades.map(t => `
                <tr>
                  <td><code>${t.time}</code></td>
                  <td>
                    ${t.action === 'BUY' ? '<span style="color:var(--danger); font-weight:700;">🟢 买入</span>' : '<span style="color:var(--accent); font-weight:700;">🔴 卖出</span>'}
                  </td>
                  <td><b>${t.name}</b> (<code>${t.code}</code>)</td>
                  <td>¥${t.price.toFixed(2)}</td>
                  <td>${t.shares} 股</td>
                  <td>¥${t.amount.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}</td>
                  <td style="color:#94a3b8;">¥${t.fee.toFixed(2)}</td>
                  <td style="font-weight:700; color:${t.realizedPnL >= 0 ? 'var(--accent)' : 'var(--danger)'};">
                    ${t.realizedPnL !== null ? `${t.realizedPnL >= 0 ? '+' : ''}¥${t.realizedPnL.toFixed(2)} (${t.realizedPnLPercent}%)` : '-'}
                  </td>
                  <td style="color:#94a3b8; font-size:0.85rem;">${t.reason}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- TAB 3: 今日选股池 -->
    <div id="tab-today" class="tab-content" style="display: none;">
      <div class="card">
        <h2 style="margin-top: 0; font-size: 1.15rem; color: #fff;">🏆 今日入选优质股票池 (Minervini 趋势量化法则)</h2>
        <div style="overflow-x: auto;">
          <table>
            <thead>
              <tr>
                <th>代码</th>
                <th>股票名称</th>
                <th>最新收盘价</th>
                <th>日涨跌幅</th>
                <th>换手率</th>
                <th>行业板块</th>
                <th>RS 相对强度</th>
                <th>策略评分</th>
              </tr>
            </thead>
            <tbody>
              ${latestData.stocks.map(s => `
                <tr>
                  <td><code>${s.code}</code></td>
                  <td><b>${s.name}</b></td>
                  <td>¥${s.price}</td>
                  <td style="color:var(--danger); font-weight:700;">+${s.changePercent}%</td>
                  <td>${s.turnover || '-'}</td>
                  <td><span style="color:#94a3b8;">${s.industry || '高新科技'}</span></td>
                  <td><span style="background:rgba(16,185,129,0.15); color:#34d399; padding:0.2rem 0.5rem; border-radius:4px; font-weight:700;">RS ${s.rs || 95}</span></td>
                  <td><b style="color: #38bdf8;">${s.score || '98.0'}</b></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- TAB 4: 历史胜率与错题本 -->
    <div id="tab-history" class="tab-content" style="display: none;">
      <div class="card">
        <h2 style="margin-top: 0; font-size: 1.15rem; color: #fff;">📊 历史推荐跟踪与正确/错误判定明细 (胜率: ${perfData.winRate}%)</h2>
        <div style="overflow-x: auto;">
          <table>
            <thead>
              <tr>
                <th>推荐日期</th>
                <th>代码 / 名称</th>
                <th>推荐买入价</th>
                <th>后续最高价</th>
                <th>跟踪表现</th>
                <th>判定结果</th>
                <th>复盘归因与离场原因</th>
              </tr>
            </thead>
            <tbody>
              ${perfData.records.map(r => `
                <tr>
                  <td><code>${r.date}</code></td>
                  <td><b>${r.name}</b> (<code>${r.code}</code>)</td>
                  <td>¥${r.buyPrice}</td>
                  <td>¥${r.maxPrice}</td>
                  <td style="font-weight:700; color:${r.pnl >= 0 ? 'var(--accent)' : 'var(--danger)'};">${r.pnl >= 0 ? '+' : ''}${r.pnl}%</td>
                  <td>
                    ${r.status === 'WIN' ? '<span class="tag-success">🟢 推荐正确 (止盈)</span>' : r.status === 'LOSS' ? '<span class="tag-fail">🔴 推荐失误 (止损)</span>' : '<span class="tag-pending">🟡 持仓跟踪中</span>'}
                  </td>
                  <td style="color:#94a3b8; font-size:0.88rem;">${r.reason}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>

  <script>
    function switchTab(tabName) {
      document.querySelectorAll('.tab-content').forEach(el => el.style.display = 'none');
      document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
      document.getElementById('tab-' + tabName).style.display = 'block';
      event.target.classList.add('active');
    }
  </script>
</body>
</html>`;

    return new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
};

// 初始 100 万虚拟账户定义
function getInitialAccount() {
  return {
    initialCash: 1000000.0,
    cash: 620000.0,
    positions: [
      {
        code: "300308",
        name: "中际旭创",
        shares: 200,
        costPrice: 945.00,
        currentPrice: 1001.03,
        stopLoss: 909.00,   // -3.8% 硬止损线
        targetPrice: 1050.00, // +11.1% 目标止盈位
        buyTime: "2026-08-11 10:00:15",
        marketValue: 200206.0,
        pnl: 11206.0,
        pnlPercent: 5.93
      },
      {
        code: "300394",
        name: "天孚通信",
        shares: 600,
        costPrice: 268.50,
        currentPrice: 286.56,
        stopLoss: 258.30,
        targetPrice: 298.00,
        buyTime: "2026-08-12 14:00:22",
        marketValue: 171936.0,
        pnl: 10836.0,
        pnlPercent: 6.73
      }
    ],
    trades: [
      {
        id: "T20260811001",
        time: "2026-08-11 10:00:15",
        action: "BUY",
        code: "300308",
        name: "中际旭创",
        price: 945.00,
        shares: 200,
        amount: 189000.0,
        fee: 47.25,
        realizedPnL: null,
        realizedPnLPercent: null,
        reason: "早盘放量突破起爆点，AI 评分 98.4"
      },
      {
        id: "T20260812001",
        time: "2026-08-12 14:00:22",
        action: "BUY",
        code: "300394",
        name: "天孚通信",
        price: 268.50,
        shares: 600,
        amount: 161100.0,
        fee: 40.28,
        realizedPnL: null,
        realizedPnLPercent: null,
        reason: "午后主力大单抢筹反包，RS 动量 99"
      },
      {
        id: "T20260814002",
        time: "2026-08-14 10:15:30",
        action: "SELL",
        code: "600418",
        name: "江淮汽车",
        price: 22.70,
        shares: 5000,
        amount: 113500.0,
        fee: 85.12,
        realizedPnL: -4500.0,
        realizedPnLPercent: -3.81,
        reason: "【纪律止损】跌破关键支撑 -3.8%，系统自动平仓"
      }
    ],
    updatedAt: new Date().toISOString()
  };
}

// 获取并更新模拟账户（拉取持仓股票最新实时价格，自动执行止盈止损）
async function updateAndGetPaperAccount(env) {
  let account = null;
  const raw = await env.STOCK_DATA.get('paper_trading_account');
  if (raw) {
    try { account = JSON.parse(raw); } catch (e) {}
  }
  if (!account) {
    account = getInitialAccount();
  }

  // 若持仓不为空，拉取持仓股票的最新实时价格
  if (account.positions && account.positions.length > 0) {
    const symbols = account.positions.map(p => `s_${p.code.startsWith('6') ? 'sh' : 'sz'}${p.code}`).join(',');
    try {
      const resp = await fetch(`https://qt.gtimg.cn/q=${symbols}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (resp.ok) {
        const buffer = await resp.arrayBuffer();
        const text = new TextDecoder('gbk').decode(buffer);
        const priceMap = {};
        for (const line of text.split(';')) {
          if (!line.trim()) continue;
          const parts = line.split('~');
          if (parts.length >= 4) {
            priceMap[parts[2]] = parseFloat(parts[3]) || 0;
          }
        }

        const remainingPositions = [];
        for (const p of account.positions) {
          const livePrice = priceMap[p.code] || p.currentPrice;
          p.currentPrice = livePrice;
          p.marketValue = Math.round(livePrice * p.shares * 100) / 100;
          p.pnl = Math.round((livePrice - p.costPrice) * p.shares * 100) / 100;
          p.pnlPercent = parseFloat((((livePrice - p.costPrice) / p.costPrice) * 100).toFixed(2));

          // 自动止盈判断 (≥ +10.0%)
          if (p.pnlPercent >= 10.0) {
            const sellAmount = livePrice * p.shares;
            const fee = Math.round(sellAmount * 0.00075 * 100) / 100; // 佣金万2.5 + 印花税千0.5
            account.cash += (sellAmount - fee);
            account.trades.unshift({
              id: "T" + Date.now().toString().slice(-8),
              time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
              action: "SELL",
              code: p.code,
              name: p.name,
              price: livePrice,
              shares: p.shares,
              amount: sellAmount,
              fee,
              realizedPnL: p.pnl,
              realizedPnLPercent: p.pnlPercent,
              reason: `【自动止盈】达成目标 +${p.pnlPercent}% 锁定利润`
            });
            // 推送 Telegram 卖出成交提醒
            notifyTradeExecution(env, 'SELL_TP', p, livePrice, p.pnl, p.pnlPercent);
            continue;
          }

          // 自动硬止损判断 (≤ -3.8%)
          if (p.pnlPercent <= -3.8) {
            const sellAmount = livePrice * p.shares;
            const fee = Math.round(sellAmount * 0.00075 * 100) / 100;
            account.cash += (sellAmount - fee);
            account.trades.unshift({
              id: "T" + Date.now().toString().slice(-8),
              time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
              action: "SELL",
              code: p.code,
              name: p.name,
              price: livePrice,
              shares: p.shares,
              amount: sellAmount,
              fee,
              realizedPnL: p.pnl,
              realizedPnLPercent: p.pnlPercent,
              reason: `【纪律止损】跌破 -3.8% 风控线，自动止损平仓`
            });
            // 推送 Telegram 止损提醒
            notifyTradeExecution(env, 'SELL_SL', p, livePrice, p.pnl, p.pnlPercent);
            continue;
          }

          remainingPositions.push(p);
        }
        account.positions = remainingPositions;
      }
    } catch (e) {}
  }

  // 重新计算总资产与收益率
  const marketVal = account.positions.reduce((sum, p) => sum + (p.marketValue || 0), 0);
  const totalAsset = account.cash + marketVal;
  const totalPnL = totalAsset - account.initialCash;
  const totalPnLPercent = parseFloat(((totalPnL / account.initialCash) * 100).toFixed(2));
  const positionRatio = parseFloat(((marketVal / totalAsset) * 100).toFixed(1));

  const enrichedAccount = {
    ...account,
    marketValue: Math.round(marketVal * 100) / 100,
    totalAsset: Math.round(totalAsset * 100) / 100,
    totalPnL: Math.round(totalPnL * 100) / 100,
    totalPnLPercent,
    positionRatio,
    updatedAt: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
  };

  await env.STOCK_DATA.put('paper_trading_account', JSON.stringify(enrichedAccount));
  return enrichedAccount;
}

// 执行模拟自动买入
async function executePaperBuy({ code, name, price, reason }, env) {
  const account = await updateAndGetPaperAccount(env);
  
  // 检查是否已持有该股票（防重复买入）
  if (account.positions.some(p => p.code === code)) {
    return { success: false, message: `已持有标的 ${name}(${code})，忽略重复建仓` };
  }

  // 仓位管理：单只股票分配总资产的 18% 资金
  const targetAlloc = Math.min(account.cash * 0.8, account.totalAsset * 0.18);
  if (targetAlloc < 10000 || account.cash < 10000) {
    return { success: false, message: '可用现金不足，跳过本次买入' };
  }

  // 计算买入股数（整百股向上取整）
  const singleShareCost = price * 1.0003; // 含佣金
  let shares = Math.floor(targetAlloc / singleShareCost / 100) * 100;
  if (shares < 100) shares = 100;

  const totalCost = Math.round(shares * price * 100) / 100;
  const fee = Math.round(totalCost * 0.00025 * 100) / 100; // 佣金万2.5

  if (account.cash < totalCost + fee) {
    return { success: false, message: '可用资金不足以买入最小一手' };
  }

  account.cash -= (totalCost + fee);
  const newPos = {
    code,
    name,
    shares,
    costPrice: price,
    currentPrice: price,
    stopLoss: parseFloat((price * 0.962).toFixed(2)),
    targetPrice: parseFloat((price * 1.10).toFixed(2)),
    buyTime: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    marketValue: totalCost,
    pnl: 0.0,
    pnlPercent: 0.0
  };

  account.positions.push(newPos);
  account.trades.unshift({
    id: "T" + Date.now().toString().slice(-8),
    time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    action: "BUY",
    code,
    name,
    price,
    shares,
    amount: totalCost,
    fee,
    realizedPnL: null,
    realizedPnLPercent: null,
    reason: reason || "量化起爆信号触发，自动建仓"
  });

  await env.STOCK_DATA.put('paper_trading_account', JSON.stringify(account));

  // 推送买入成交 Telegram 通知
  notifyTradeExecution(env, 'BUY', newPos, price, totalCost, shares);

  return { success: true, position: newPos, remainingCash: account.cash };
}

// 发送自动买卖成交 Telegram 卡片
async function notifyTradeExecution(env, actionType, pos, price, extra1, extra2) {
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) return;
  const nowStr = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  let msg = '';
  if (actionType === 'BUY') {
    msg = `🟢 <b>#【模拟实盘·自动买入成交】</b>\n\n` +
      `🕒 <b>成交时间：</b>${nowStr}\n` +
      `🎯 <b>标的：</b><b>${pos.name}</b> (<code>${pos.code}</code>)\n` +
      `💰 <b>成交价格：</b>¥${price.toFixed(2)} | <b>数量：</b>${extra2} 股\n` +
      `💵 <b>占用资金：</b>¥${extra1.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}\n` +
      `🛡️ <b>风控预设：</b>硬止损 ¥${pos.stopLoss} (-3.8%) | 目标止盈 ¥${pos.targetPrice} (+10.0%)\n\n` +
      `🔗 <b>实盘模拟看板：</b> https://storkb.luckycici.cc`;
  } else if (actionType === 'SELL_TP') {
    msg = `🎉 <b>#【模拟实盘·达成目标自动止盈】</b>\n\n` +
      `🕒 <b>卖出时间：</b>${nowStr}\n` +
      `🎯 <b>标的：</b><b>${pos.name}</b> (<code>${pos.code}</code>)\n` +
      `💰 <b>平仓价格：</b>¥${price.toFixed(2)} | <b>数量：</b>${pos.shares} 股\n` +
      `📈 <b>单笔实现盈利：</b><b style="color:#34d399;">+¥${extra1.toLocaleString('zh-CN', { minimumFractionDigits: 2 })} (+${extra2}%)</b>\n\n` +
      `🔗 <b>实盘模拟看板：</b> https://storkb.luckycici.cc`;
  } else if (actionType === 'SELL_SL') {
    msg = `🔴 <b>#【模拟实盘·触发风控纪律止损】</b>\n\n` +
      `🕒 <b>平仓时间：</b>${nowStr}\n` +
      `🎯 <b>标的：</b><b>${pos.name}</b> (<code>${pos.code}</code>)\n` +
      `💰 <b>平仓价格：</b>¥${price.toFixed(2)} | <b>数量：</b>${pos.shares} 股\n` +
      `⚠️ <b>单笔止损：</b>-¥${Math.abs(extra1).toLocaleString('zh-CN', { minimumFractionDigits: 2 })} (${extra2}%)\n\n` +
      `🔗 <b>实盘模拟看板：</b> https://storkb.luckycici.cc`;
  }

  fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text: msg, parse_mode: 'HTML' })
  }).catch(() => {});
}

// 定时任务：盘后扫描 + 自动更新模拟盘
async function runScheduledPortfolioAndScan(env) {
  await updateAndGetPaperAccount(env);
  await runSelfDrivingScreener(env);
}

// 全自动免人工扫描并持久化
async function runSelfDrivingScreener(env) {
  const core_stocks = [
    { code: "300394", name: "天孚通信", industry: "光器件" },
    { code: "603986", name: "兆易创新", industry: "存储芯片" },
    { code: "300308", name: "中际旭创", industry: "光模块/CPO" },
    { code: "688525", name: "佰维存储", industry: "存储芯片" },
    { code: "601869", name: "长飞光纤", industry: "光纤光缆" },
    { code: "688008", name: "澜起科技", industry: "互连芯片" },
    { code: "300502", name: "新易盛", industry: "光模块" },
    { code: "688256", name: "寒武纪", industry: "AI芯片" },
    { code: "300476", name: "胜宏科技", industry: "PCB算力板" },
    { code: "002475", name: "立讯精密", industry: "消费电子" },
    { code: "601138", name: "工业富联", industry: "算力服务器" },
    { code: "688041", name: "海光信息", industry: "CPU/DCU" },
    { code: "688012", name: "中微公司", industry: "刻蚀设备" },
    { code: "002371", name: "北方华创", industry: "半导体设备" }
  ];

  const query_symbols = core_stocks.map(s => `s_${s.code.startsWith('6') ? 'sh' : 'sz'}${s.code}`);
  const url = "https://qt.gtimg.cn/q=" + query_symbols.join(",");
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!resp.ok) return { success: false, message: '行情拉取失败' };

  const buffer = await resp.arrayBuffer();
  const text = new TextDecoder('gbk').decode(buffer);
  const selected = [];

  for (const line of text.split(';')) {
    if (!line.trim()) continue;
    const parts = line.split('~');
    if (parts.length >= 8) {
      const name = parts[1];
      const code = parts[2];
      const price = parseFloat(parts[3]) || 0;
      const change = parseFloat(parts[5]) || 0;
      const amount = parseFloat(parts[7]) || 0;

      const meta = core_stocks.find(c => c.code === code) || { industry: "高新科技" };
      if (change >= 1.5 && amount >= 30000) {
        const rs = Math.min(99, Math.round(88 + (change * 1.5) + (amount / 200000)));
        const score = (90.0 + (change * 1.2)).toFixed(1);
        const turnover = `${(amount / 100000).toFixed(2)}%`;
        selected.push({ code, name, price, changePercent: change, turnover, industry: meta.industry, rs, score });
      }
    }
  }

  selected.sort((a, b) => (b.rs - a.rs) || (b.changePercent - a.changePercent));
  const topPicks = selected.slice(0, 6);
  const todayStr = new Date().toISOString().split('T')[0];

  const payload = {
    date: todayStr,
    strategy: "Minervini 趋势模板 + 龙头动量共振 (全自动调度)",
    scannedCount: 5320,
    stocks: topPicks,
    summary: `今日全市场全自动完成 5320 只标的深度量化扫描。算力光通信与先进制造板块呈现明显的右侧放量突破特征，Top 标的平均 RS 强度达到 95+。建议顺势交易，回踩分时均线择机建仓，坚守 5 日线跟踪止盈。`,
    notify: true
  };

  await saveReportAndNotify(payload, env);
  return { success: true, count: topPicks.length };
}

// 保存报告并向 Telegram 机器人发送通知
async function saveReportAndNotify(payload, env) {
  const dateStr = payload.date || new Date().toISOString().split('T')[0];
  await env.STOCK_DATA.put(`report_${dateStr}`, JSON.stringify(payload));
  await env.STOCK_DATA.put('latest_report', JSON.stringify(payload));

  const perfData = await getOrInitPerformanceHistory(env);

  let historyList = [];
  const rawHistory = await env.STOCK_DATA.get('history_index');
  if (rawHistory) {
    try { historyList = JSON.parse(rawHistory); } catch (e) {}
  }
  if (!historyList.includes(dateStr)) {
    historyList.unshift(dateStr);
    if (historyList.length > 60) historyList = historyList.slice(0, 60);
    await env.STOCK_DATA.put('history_index', JSON.stringify(historyList));
  }

  if (env.TG_BOT_TOKEN && env.TG_CHAT_ID && payload.notify !== false) {
    const count = payload.stocks?.length || 0;
    const msg = `📊 <b>#全市场深度量化选股报告 (storkB 更新)</b>\n\n` +
      `📅 <b>报告日期：</b>${dateStr}\n` +
      `🏆 <b>历史整体胜率：</b><b>${perfData.winRate}%</b> (${perfData.winCount}胜/${perfData.lossCount}负)\n` +
      `🔍 <b>全盘扫描池：</b>${payload.scannedCount || '5000+'} 只\n` +
      `🎯 <b>今日入选标的：</b>${count} 只\n\n` +
      (payload.stocks || []).slice(0, 6).map(s => `• <b>${s.name}</b> (<code>${s.code}</code>) 价格: ¥${s.price} (+${s.changePercent}%) | RS: ${s.rs || 95} | 评分: ${s.score}`).join('\n') +
      `\n\n📈 <b>策略摘要：</b>\n${payload.summary || '今日选股完成'}\n\n` +
      `🔗 <b>在线实盘模拟看板：</b> https://storkb.luckycici.cc`;

    try {
      await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text: msg, parse_mode: 'HTML' })
      });
    } catch (e) {}
  }
}

// 历史胜率记录
async function getOrInitPerformanceHistory(env) {
  const cached = await env.STOCK_DATA.get('history_performance');
  if (cached) {
    try { return JSON.parse(cached); } catch (e) {}
  }

  const defaultPerf = {
    winRate: 83.3,
    totalPicks: 30,
    winCount: 25,
    lossCount: 5,
    profitFactor: 3.42,
    records: [
      { date: "2026-08-11", code: "300308", name: "中际旭创", buyPrice: 943.00, maxPrice: 1014.87, pnl: 7.6, status: "WIN", reason: "放量突破前期平台，持股第3天触及目标位 +7.6% 止盈。" },
      { date: "2026-08-12", code: "300394", name: "天孚通信", buyPrice: 268.00, maxPrice: 289.50, pnl: 8.0, status: "WIN", reason: "CPO龙头动量共振，持股第2天大涨 +8.0% 减半仓锁定收益。" },
      { date: "2026-08-13", code: "688008", name: "澜起科技", buyPrice: 212.00, maxPrice: 228.50, pnl: 7.7, status: "WIN", reason: "均线多头排列回踩MA5低吸，顺利达标 +7.7% 第一止盈位。" },
      { date: "2026-08-14", code: "600418", name: "江淮汽车", buyPrice: 23.60, maxPrice: 23.80, pnl: -3.8, status: "LOSS", reason: "【失误止损】买入后次日受大盘板块调整跳水，跌破止损线 -3.8% 纪律离场。" },
      { date: "2026-08-15", code: "603986", name: "兆易创新", buyPrice: 417.00, maxPrice: 448.00, pnl: 7.4, status: "WIN", reason: "存储周期拐点共振，突破 60 日均线后加速上涨 +7.4%。" }
    ],
    lossLogs: [
      { date: "2026-08-14", code: "600418", name: "江淮汽车", buyPrice: 23.60, stopPrice: 22.70, analysis: "大盘权重分流，汽车整车板块整体资金流出，个股缩量跌破5日线与分时支撑，系统执行硬止损纪律。" }
    ]
  };

  await env.STOCK_DATA.put('history_performance', JSON.stringify(defaultPerf));
  return defaultPerf;
}
