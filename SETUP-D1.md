# 六脈獵手雲端版設定 (Cloudflare D1)

這份文件告訴你怎麼把「自動獵手」從**各自瀏覽器的 localStorage**升級成**全球共享 + 24/7 背景運行的 Cloudflare D1 資料庫**。

只要設定完成後：
- ✅ 所有訪客看到**同一份訊號與統計數字**
- ✅ Cloudflare Workers Cron 會**每 5 分鐘**自動掃描（你不用開瀏覽器）
- ✅ 勝率 / 期望值會**長期累積**，永遠保留
- ✅ 免費額度：5 GB 儲存 / 500 萬讀 / 10 萬寫 per day（遠遠用不完）

---

## 🎯 總共 3 個步驟（5 分鐘）

### 步驟 1️⃣：建立 D1 資料庫

1. 打開 https://dash.cloudflare.com/
2. 左側選單 **「Storage & Databases」** → **「D1 SQL Database」**
3. 點右上角 **`Create`** 按鈕
4. Name 填：**`liumai-hunter`**（**必須完全一樣**，否則 Worker 綁不到）
5. Location：選 **`Asia-Pacific`**（最靠近台灣，延遲最低）
6. 按 **`Create`** → 等 5 秒

### 步驟 2️⃣：建立資料表（跑 SQL）

1. 剛建好的 `liumai-hunter` 會自動打開
2. 上方切到 **`Console`** 分頁
3. 把**整份 `schema.sql` 的內容貼進去**（這份檔案就在你的 repo 根目錄）
4. 按 **`Execute`** → 會看到 4 個 `CREATE TABLE` 和幾個 `CREATE INDEX` 成功訊息
5. 切到 **`Tables`** 分頁確認有 `signals / scans / universe_cache / kline_cache` 4 張表

> 或用更快的：點 `Tables` 旁邊的 `+ New Query`，把 schema.sql 整段丟進去 run

### 步驟 3️⃣：把 D1 綁到 Worker

有**兩種方式**，選一個即可：

#### 方式 A（推薦）：用 wrangler.jsonc 自動綁定

1. 回到剛建立的 `liumai-hunter` D1 頁面
2. 右上角有個欄位寫 **`Database ID:`** 後面一串像 `abc123def456-...` 的 UUID
3. 複製這個 ID
4. 在你本機 repo 打開 `wrangler.jsonc`
5. 找到這一行：
   ```
   "database_id": "PLACEHOLDER_FILL_FROM_DASHBOARD"
   ```
6. 把 `PLACEHOLDER_FILL_FROM_DASHBOARD` 換成剛剛複製的 UUID
7. `git add wrangler.jsonc && git commit -m "bind D1" && git push`
8. Cloudflare 自動重新部署（~1 分鐘）

#### 方式 B：用 Dashboard UI 綁定

1. 左側選單 **「Workers & Pages」** → 點 `liumai`
2. 上方切到 **`Settings`** 分頁
3. 左側點 **`Bindings`**
4. 點 **`Add binding`** → 選 **`D1 database`**
5. Variable name：**`DB`**（**完全一樣**）
6. D1 database：選剛建的 `liumai-hunter`
7. 按 **`Deploy`**

---

## ✅ 驗證設定成功

```bash
# 1. 檢查 API 活著
curl https://liumai.legstrong77.workers.dev/api/hunter/stats

# 應該回:
# {"total":0,"open":0,"closed":0,"wins":0,"stops":0,"expired":0,
#  "decisive":0,"winRate":null,...,"confidence":"資料不足"}

# 2. 手動觸發一次掃描
curl -X POST https://liumai.legstrong77.workers.dev/api/hunter/scan

# 應該回:
# {"scanned":100,"fresh":5,"errors":0,"duration":xxxx,"marketOpen":true/false}

# 3. 看有沒有訊號記錄
curl "https://liumai.legstrong77.workers.dev/api/hunter/signals?limit=5"
```

打開 https://liumai.legstrong77.workers.dev/ → 點右上 🎯 獵手 → 點「開始獵盤」
- 如果設定成功：看到「🌐 雲端同步（全球共享，每 5 分鐘掃描）」
- 如果失敗：看到「💾 本機模式（僅此瀏覽器）」

---

## ⏰ Cron Trigger 頻率

```
*/5 * * * *    每 5 分鐘觸發一次
```

- **盤中 (9:00-13:30 TW)**：每 5 分鐘掃全市場 100 支股 + 更新所有 open 訊號
- **盤後**：只更新 open 訊號的現價（不再產生新訊號）
- **週末 / 國定假日**：Market open 檢查會 skip（但 cron 還是會跑，只是不做事）

總觸發次數：每天 288 次 → 遠低於 Cloudflare 免費 10 萬次/天 limit。

---

## 🔧 常見問題

**Q: 為什麼 `liumai-hunter` 這個名字不能改？**
A: `wrangler.jsonc` 裡的 `database_name` 要跟 Dashboard 建的名稱一致，否則綁不到。想改可以，兩邊一起改。

**Q: 我改錯 database_id 怎辦？**
A: CF Workers 會部署失敗，log 會出錯。改對再 push 即可。

**Q: D1 免費夠用嗎？**
A: 每天 288 次 cron × ~10 筆新訊號 = 2880 寫入，遠低於 10 萬限制。讀取端看流量，5 萬讀足以撐到 1 萬名用戶同時在線每分鐘查一次。

**Q: 可以從 D1 Dashboard 直接查訊號嗎？**
A: 可以，在 `Console` 跑 SQL：
```sql
SELECT code, name, entry, target, status, outcome_pct
FROM signals
ORDER BY fired_at DESC
LIMIT 20;
```

**Q: 怎麼把統計 reset（重新累積）？**
A: D1 Console 跑：
```sql
DELETE FROM signals;
DELETE FROM scans;
```

---

## 🚨 授權 / 安全

- 任何人都能 `POST /api/hunter/scan` 手動觸發掃描（reasonable — 不會造成 DB 爆炸，只會讓當次掃描更即時）
- 如果想限制，可在 `hunter-server.js` 加一個 `X-Admin-Token` 檢查 + 從 `env.ADMIN_TOKEN` 讀密鑰
- `/api/hunter/signals` 和 `/api/hunter/stats` 是公開讀取，因為訊號和勝率本來就是公開透明的

---

## 🔮 Roadmap

- [ ] `/api/hunter/feed.rss` — 讓訊號可以用 RSS 訂閱
- [ ] LINE Notify 推播 — 手機不開電腦也收得到
- [ ] 訊號類型勝率細分 — 看哪類訊號（黃金交叉 vs 突破 vs 爆量）勝率最高
- [ ] Walk-forward backtest — 拿過去 1 年的 K 線重播整個策略
