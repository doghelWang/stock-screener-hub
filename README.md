# Stock Screener Hub (量化选股与全市场投研看板)

基于 **Minervini 趋势模板** 与 **多因子量化选股** 的全自动化投研系统，通过 **GitHub Actions** 定时执行全市场 5000+ 只股票深度扫描，并将选股报告实时同步至 **Cloudflare Worker & KV (storkB)**，联动 **Telegram 机器人** 实时推送。

---

## 🌟 核心特性

- **🚀 全市场深度扫描**：每日盘后自动抓取 A 股核心资金与领涨龙头，基于趋势模板法则进行量化过滤。
- **📊 实时 Web 看板**：部署于 Cloudflare 全球边缘网络，毫秒级响应：[https://storkb.luckycici.cc](https://storkb.luckycici.cc)。
- **🤖 Telegram 机器人实时告警**：扫描完成后自动发送精选股票池、策略评分及风控止损参数。
- **☁️ Cloudflare Serverless 零成本持久化**：使用 Cloudflare KV 存储历史研报与日期索引，零运维、永久免费。

---

## 🛠️ 项目结构

```text
├── .github/workflows/
│   └── daily_screener.yml    # GitHub Actions 定时执行工作流 (工作日 15:35 自动触发)
├── scripts/
│   └── daily_screener.py     # Python 全市场量化扫描与 Webhook 同步脚本
├── src/
│   └── index.js              # Cloudflare Worker 核心代码 (看板前端 + API 路由)
├── wrangler.toml             # Cloudflare Worker 配置文件
└── README.md
```

---

## ⚙️ 自动化配置 (GitHub Actions)

工作流已预设在每个工作日 **15:35 (北京时间)** 自动运行。

如需配置自定义密钥，可在 GitHub 仓库的 **Settings -> Secrets and variables -> Actions** 中配置：
- `SCREENER_API`: `https://storkb.luckycici.cc/api/sync`
- `SYNC_SECRET`: `wangrunxi_screener_sync_key`
