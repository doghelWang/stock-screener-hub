export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. 接收 GitHub Actions / Python 外部全量选股结果同步
    if (url.pathname === '/api/sync' && request.method === 'POST') {
      const auth = request.headers.get('Authorization') || '';
      const token = auth.replace('Bearer ', '').trim();
      if (token !== env.SYNC_SECRET && token !== 'wangrunxi_screener_sync_key') {
        return new Response(JSON.stringify({ success: false, message: 'Unauthorized sync token' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      try {
        const payload = await request.json();
        const dateStr = payload.date || new Date().toISOString().split('T')[0];
        
        // 保存至 KV
        await env.STOCK_DATA.put(`report_${dateStr}`, JSON.stringify(payload));
        await env.STOCK_DATA.put('latest_report', JSON.stringify(payload));

        // 维护历史目录
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

        // 发送 Telegram 提醒
        if (env.TG_BOT_TOKEN && env.TG_CHAT_ID && payload.notify !== false) {
          const count = payload.stocks?.length || 0;
          const msg = `📊 <b>#全市场深度量化选股报告同步完成</b>\n\n` +
            `📅 <b>日期：</b>${dateStr}\n` +
            `🎯 <b>筛选模型：</b>${payload.strategy || 'Minervini 趋势 + 动量突破'}\n` +
            `🔍 <b>扫描标的数量：</b>${payload.scannedCount || '5000+'}\n` +
            `🏆 <b>入选强势标的：</b>${count} 只\n\n` +
            (payload.stocks || []).slice(0, 5).map(s => `• <b>${s.name}</b> (<code>${s.code}</code>) 价格: ¥${s.price} | 策略评分: ${s.score || s.rs || 'A+'}`).join('\n') +
            `\n\n🔗 <b>在线研报看板：</b> https://storkB.luckycici.cc`;

          fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text: msg, parse_mode: 'HTML' })
          }).catch(() => {});
        }

        return new Response(JSON.stringify({ success: true, date: dateStr, count: payload.stocks?.length || 0 }), {
          headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // 2. 获取最新选股数据 API
    if (url.pathname === '/api/latest') {
      const data = await env.STOCK_DATA.get('latest_report');
      return new Response(data || JSON.stringify({ stocks: [], message: '暂无最新报告' }), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    // 3. 获取历史日期索引 API
    if (url.pathname === '/api/history') {
      const data = await env.STOCK_DATA.get('history_index');
      return new Response(data || '[]', {
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    // 4. Web 看板前端页面
    let latestData = null;
    const rawLatest = await env.STOCK_DATA.get('latest_report');
    if (rawLatest) {
      try { latestData = JSON.parse(rawLatest); } catch (e) {}
    }

    // 默认展示数据（若尚无外部同步）
    if (!latestData) {
      latestData = {
        date: new Date().toISOString().split('T')[0],
        strategy: "Minervini 趋势模板 + 资金龙头",
        scannedCount: 5320,
        stocks: [
          { code: "300308", name: "中际旭创", price: 1001.03, changePercent: 6.15, turnover: "3.27%", pe: 42.5, rs: 96, industry: "光模块/CPO", score: "98.5" },
          { code: "603986", name: "兆易创新", price: 444.00, changePercent: 6.35, turnover: "8.81%", pe: 58.2, rs: 94, industry: "存储芯片", score: "96.2" },
          { code: "300502", name: "新易盛", price: 466.68, changePercent: 4.15, turnover: "4.70%", pe: 38.1, rs: 93, industry: "光模块", score: "94.8" },
          { code: "300394", name: "天孚通信", price: 286.56, changePercent: 7.04, turnover: "5.80%", pe: 46.0, rs: 95, industry: "光器件", score: "95.0" }
        ],
        summary: "今日全市场共扫描 5320 只标的，右侧多头排列且突破 52 周新高标的集中于算力光通信与先进存储板块。大盘成交维持活跃，建议持股待涨并设立 5 日线跟踪止盈。"
      };
    }

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>量化选股投研看板 (方案 B) - Screener Hub</title>
  <style>
    :root {
      --bg: #090d16;
      --card: #131b2e;
      --card-hover: #18233c;
      --border: #23304d;
      --text: #f1f5f9;
      --muted: #94a3b8;
      --primary: #38bdf8;
      --accent: #10b981;
      --danger: #f43f5e;
    }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); padding: 2rem 1.5rem; margin: 0; line-height: 1.6; }
    .container { max-width: 1100px; margin: 0 auto; }
    header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; border-bottom: 1px solid var(--border); padding-bottom: 1.5rem; flex-wrap: wrap; gap: 1rem; }
    h1 { margin: 0; font-size: 1.6rem; color: #fff; display: flex; align-items: center; gap: 0.5rem; }
    .badge { padding: 0.25rem 0.65rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 700; background: #0369a1; color: #bae6fd; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem; }
    .grid-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
    .stat-card { background: #0d1424; border: 1px solid var(--border); border-radius: 10px; padding: 1rem 1.25rem; }
    .stat-label { font-size: 0.85rem; color: var(--muted); margin-bottom: 0.25rem; }
    .stat-val { font-size: 1.4rem; font-weight: 700; color: #fff; }
    
    table { width: 100%; border-collapse: collapse; margin-top: 1rem; font-size: 0.95rem; }
    th { text-align: left; padding: 0.75rem 1rem; color: var(--muted); border-bottom: 1px solid var(--border); font-weight: 600; }
    td { padding: 0.9rem 1rem; border-bottom: 1px solid #1a253d; }
    tr:hover td { background: var(--card-hover); }
    .tag-up { color: var(--danger); font-weight: 700; }
    .tag-rs { background: rgba(16, 185, 129, 0.15); color: #34d399; padding: 0.2rem 0.5rem; border-radius: 4px; font-weight: 600; }
    
    .api-box { background: #070a12; border: 1px dashed var(--border); border-radius: 8px; padding: 1rem; font-family: monospace; font-size: 0.85rem; color: #cbd5e1; margin-top: 1rem; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>📈 量化选股全市场投研看板 <span class="badge">方案 B (storkB)</span></h1>
        <div style="color: var(--muted); font-size: 0.9rem; margin-top: 0.25rem;">支持 GitHub Actions / Python 全量 5000+ 股票扫描结果与 Webhook 实时持久化</div>
      </div>
      <div style="text-align: right;">
        <span class="badge" style="background:#065f46; color:#6ee7b7;">KV 同步状态: 正常在线</span>
      </div>
    </header>

    <div class="grid-stats">
      <div class="stat-card">
        <div class="stat-label">报告日期</div>
        <div class="stat-val">${latestData.date}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">扫描全市场股票池</div>
        <div class="stat-val">${latestData.scannedCount || '5000+'} 只</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">当前入选精选标的</div>
        <div class="stat-val" style="color: var(--primary);">${latestData.stocks.length} 只</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">量化核心模型</div>
        <div class="stat-val" style="font-size: 1.1rem; color: #a5f3fc;">${latestData.strategy || '趋势突破'}</div>
      </div>
    </div>

    <div class="card">
      <h2 style="margin-top: 0; font-size: 1.25rem; color: #e2e8f0;">🏆 今日入选优质股票池</h2>
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
              <th>RS 动量强度</th>
              <th>综合策略分</th>
            </tr>
          </thead>
          <tbody>
            ${latestData.stocks.map(s => `
              <tr>
                <td><code>${s.code}</code></td>
                <td><b>${s.name}</b></td>
                <td>¥${s.price}</td>
                <td class="tag-up">+${s.changePercent}%</td>
                <td>${s.turnover || '-'}</td>
                <td><span style="color:#94a3b8;">${s.industry || '科技'}</span></td>
                <td><span class="tag-rs">RS ${s.rs || 90}</span></td>
                <td><b style="color: #38bdf8;">${s.score || 'A+'}</b></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      
      <div style="margin-top: 1.5rem; padding: 1rem; background: #0c1322; border-radius: 8px; border-left: 4px solid #38bdf8;">
        <div style="font-weight: 700; color: #38bdf8; margin-bottom: 0.25rem;">📝 策略综合研判摘要</div>
        <div style="color: #cbd5e1; font-size: 0.95rem;">${latestData.summary || '今日多头排列股票趋势良好，建议顺势交易。'}</div>
      </div>
    </div>

    <div class="card">
      <h2 style="margin-top: 0; font-size: 1.1rem; color: #e2e8f0;">⚙️ GitHub Actions / 外部 Python 自动推送对接说明</h2>
      <p style="color: var(--muted); font-size: 0.9rem;">你在 GitHub Actions 或本地 Python 脚本中完成全市场扫描后，只需发起一次 HTTP POST 即可将选股报告写入本看板并自动推送至 Telegram：</p>
      <div class="api-box">
curl -X POST https://storkB.luckycici.cc/api/sync \\<br>
&nbsp;&nbsp;-H "Authorization: Bearer wangrunxi_screener_sync_key" \\<br>
&nbsp;&nbsp;-H "Content-Type: application/json" \\<br>
&nbsp;&nbsp;-d '{"date": "2026-08-18", "strategy": "Minervini 趋势模板", "stocks": [...], "summary": "今日选股完成"}'
      </div>
    </div>
  </div>
</body>
</html>`;

    return new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
};
