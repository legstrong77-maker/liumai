# 六脈 LIUMAI · 台股 AI 戰情艙

> **六識盤面 · 一劍斷勢**
> Taiwan Stock Realtime + AI Multi-Dimensional Analysis

一個零後端依賴、純瀏覽器跑的台股即時看盤 + AI 分析平台。靈感來自 STOCKVIEW PRO / 六維度 AI Terminal。

**線上版**：https://liumai.pages.dev （Cloudflare Pages）
**本機版**：雙擊 `啟動.bat` 後開 http://127.0.0.1:8787

## ✨ 特色

- **即時報價**（TWSE MIS，~20 秒延遲）5 秒自動刷新
- **五檔 / 內外盤比** / 即時成交明細去重
- **自選股**（localStorage）+ 全市場條件掃描
- **K 線圖**（自製 Canvas，零依賴）：日/週/月/近60日 切換
  - MA5/10/20/60、布林通道、量能、十字游標
  - RSI / MACD / KD 副圖切換
- **六脈 AI 六維評分**（本地啟發式計算，不送雲端）：
  - 趨勢 / 動能 / 量能 / 籌碼 / 波動 / 位階
  - 加權綜合分 0–100 + 操作建議 + 進場/停損/目標 + R:R
- **六脈操作訊號**：MA/MACD/KD 交叉、RSI 超買超賣、布林突破、量能異常、突破前高/前低
- **三大法人**買賣超 + 10 日趨勢條
- **盤後排行**：漲幅 / 跌幅 / 成交值 / 類股強弱
- **相關新聞** Google News RSS 抓取

## 🗂 資料源

點開 app 右上 `ⓘ 資料源` 看完整對照表。核心：

| 資料 | 頻率 | 來源 |
| --- | --- | --- |
| 即時報價 / 五檔 | 5 秒 | [TWSE MIS](https://mis.twse.com.tw) |
| 加權 / 櫃買 | 15 秒 | TWSE MIS |
| 漲跌排行 / 類股 | 2 分鐘 | [TWSE OpenAPI](https://openapi.twse.com.tw) |
| 歷史 K / 法人 | 切股時 | [FinMind v4](https://finmind.github.io) |
| 相關新聞 | 5 分鐘 | Google News RSS |

TWSE MIS 不支援瀏覽器跨域，所以需要一個 CORS 代理：
- **線上**：Cloudflare Pages Function（`functions/proxy.js`）
- **本機**：Python 標準庫單檔伺服器（`server.py`）
- 都受白名單限制，只會代理到上述 4 個公開資料站

## 🚀 部署（Cloudflare Pages）

```bash
# 方法 1：Git 自動部署
git push origin main
# → Cloudflare Pages 自動 build + deploy

# 方法 2：直接用 wrangler
npx wrangler pages deploy . --project-name=liumai
```

Pages Functions 會自動被偵測（就是 `functions/` 資料夾）— 不需要另外設定。

## 💻 本機開發

```bash
python server.py
# 開 http://127.0.0.1:8787
```

或雙擊 `啟動.bat`（Windows）。需要 Python 3.8+。

## 📁 檔案結構

```
stock/
├── index.html                主畫面（三欄 + 底部排行）
├── css/style.css             深色交易 UI
├── js/
│   ├── api.js                資料源 wrapper + 代理降級鏈
│   ├── indicators.js         MA/BB/RSI/MACD/KD/ATR/OBV/Willr/Pivot
│   ├── chart.js              Canvas K 線 + 十字游標 + 布林填色 + 副圖
│   ├── ai.js                 六脈評分引擎 + 訊號生成 + 進出場計畫
│   └── app.js                狀態機 + 自動刷新 + 事件綁定
├── functions/                Cloudflare Pages Functions
│   ├── proxy.js              CORS 代理（白名單）
│   ├── quote.js              MIS 即時報價捷徑
│   └── health.js             健康檢查
├── server.py                 本機 Python 代理（同上功能）
├── 啟動.bat                  Windows 一鍵啟動
└── README.md
```

## ⚠️ 免責聲明

- 免費即時資料**有 ~20 秒延遲**（券商付費 Level 1/2 才是 0 秒）
- 三大法人為 **T+1** 資料
- 六脈 AI 評分為啟發式規則，非訓練模型，**不構成投資建議**
- 本工具僅供研究 / 自用參考；實際下單以券商系統為準
