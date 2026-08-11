const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

// 啟動管理員權限，讓機器人可以把資料寫進你的資料庫
admin.initializeApp();
const db = admin.firestore();

// 鬧鐘設定：台北時間每週一至週五的下午 4:30 自動執行
exports.autoFetchTwse = onSchedule({
  schedule: "30 15 * * 1-5",
  timeZone: "Asia/Taipei",
  timeoutSeconds: 180
}, async (event) => {
  try {
    console.log("出發去台灣證交所搬今日收盤價...");

    // 0. 收集所有使用者持有的台股代號（只存持有的，避免單文件索引超限；上市+上櫃合計上萬檔會爆）
    const usersSnap = await db.collection("users").get();
    const heldTW = new Set();
    usersSnap.forEach(s => {
      (s.data().buyRecords || []).forEach(r => {
        if (r && r.country === "台股" && r.symbol && r.shares > 0) heldTW.add(String(r.symbol).trim().toUpperCase());
      });
    });
    if (heldTW.size === 0) { console.log("目前沒有任何台股庫存，略過。"); return; }
    console.log(`需要更新的台股代號（${heldTW.size}）：${[...heldTW].join(", ")}`);

    // 1. 收盤價（當日就更新）：MI_INDEX 每日收盤行情整批。
    //    注意：openapi 的 STOCK_DAY_ALL 整批檔有約 1 天延遲（會抓到前一交易日），故改用 MI_INDEX。
    //    從台灣今天往回找最近一個有資料的交易日（跳過週末/假日）。
    const fmt = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    let cur = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
    let rows = null, fields = null, usedDate = null;
    for (let i = 0; i < 7; i++) {
      const dow = cur.getDay();
      if (dow !== 0 && dow !== 6) { // 跳過週末
        const ds = fmt(cur);
        try {
          const r = await fetch(`https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${ds}&type=ALLBUT0999&response=json`, { headers: { "User-Agent": "Mozilla/5.0" } });
          const d = await r.json();
          if (d.stat === "OK" && Array.isArray(d.tables)) {
            const t = d.tables.find(tb => (tb.fields || []).includes("證券代號") && (tb.fields || []).includes("收盤價"));
            if (t && Array.isArray(t.data) && t.data.length) { rows = t.data; fields = t.fields; usedDate = ds; break; }
          }
        } catch (e) { console.warn(`MI_INDEX ${ds} 讀取失敗`, e); }
      }
      cur.setDate(cur.getDate() - 1);
    }
    if (!rows) { console.log("找不到可用的台股收盤資料，略過（不覆蓋舊資料）。"); return; }
    const ci = fields.indexOf("證券代號"), ni = fields.indexOf("證券名稱"), pi = fields.indexOf("收盤價");
    const si = fields.indexOf("漲跌(+/-)"), di = fields.indexOf("漲跌價差"); // 用「收盤價 ∓ 漲跌價差」回推前一交易日收盤

    // 2. 殖利率：BWIBBU_ALL（殖利率不需同日更新，沿用 openapi）
    let yieldMap = {};
    try {
      const yieldRes = await fetch("https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL");
      const yieldData = await yieldRes.json();
      yieldData.forEach(i => { if (i.Code) yieldMap[i.Code] = parseFloat(i.DividendYield) || 0; });
    } catch (e) {
      console.warn("殖利率資料抓取失敗，僅存收盤價：", e);
    }

    // 3. 整理：上市收盤價來自 MI_INDEX（只取持有的），合併殖利率；prev = 前一交易日收盤（由漲跌價差回推）
    const stockMap = {};
    rows.forEach(row => {
      const code = row[ci];
      if (!code || !heldTW.has(String(code).toUpperCase())) return;
      const price = parseFloat(String(row[pi]).replace(/,/g, ""));
      if (isNaN(price)) return;
      let prev = null;
      if (di >= 0) {
        const chg = parseFloat(String(row[di]).replace(/,/g, ""));
        if (!isNaN(chg)) {
          const sgnRaw = si >= 0 ? String(row[si]) : "";
          const sgn = sgnRaw.includes("+") ? 1 : (sgnRaw.includes("-") ? -1 : 0); // 平盤或除權息日視為 0
          prev = Math.round((price - sgn * chg) * 10000) / 10000;
        }
      }
      stockMap[code] = { name: row[ni], price, yield: yieldMap[code] || 0, prev };
    });

    // 3b. 上櫃（含債券ETF，如 00679B/00772B）：TPEx 每日收盤行情（只取持有的）
    //     GCP 連 TPEx 大檔有時會 "terminated"，故加重試 + 逾時控制。
    try {
      let tdata = null;
      for (let attempt = 0; attempt < 4 && !tdata; attempt++) {
        try {
          const ctrl = new AbortController();
          const to = setTimeout(() => ctrl.abort(), 30000);
          const tr = await fetch("https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes", { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }, signal: ctrl.signal });
          clearTimeout(to);
          tdata = await tr.json();
        } catch (err) {
          console.warn(`TPEx 第 ${attempt + 1} 次嘗試失敗：${err.message}`);
          if (attempt < 3) await new Promise(s => setTimeout(s, 3000));
        }
      }
      (Array.isArray(tdata) ? tdata : []).forEach(it => {
        const code = it.SecuritiesCompanyCode;
        if (!code || !heldTW.has(String(code).toUpperCase()) || stockMap[code]) return;
        const price = parseFloat(String(it.Close).replace(/,/g, ""));
        if (isNaN(price)) return;
        const chg = parseFloat(String(it.Change).replace(/,/g, "")); // 已含正負號，如 "+0.01" / "-0.14"
        const prev = !isNaN(chg) ? Math.round((price - chg) * 10000) / 10000 : null;
        stockMap[code] = { name: it.CompanyName, price, yield: yieldMap[code] || 0, prev };
      });
    } catch (e) { console.warn("上櫃(TPEx)資料抓取失敗：", e); }

    // 4. 存入 daily_market 倉庫，覆蓋舊資料
    await db.collection("daily_market").doc("taiwan_stock_all").set({
      lastUpdated: new Date().toISOString(),
      date: usedDate,
      stocks: stockMap
    });

    console.log(`今日台股資料已存入：${Object.keys(stockMap).length} 檔 (${usedDate})`);

  } catch (error) {
    console.error("搬資料發生錯誤:", error);
  }
});

// ============ 美股每日收盤價（Polygon.io）============
// 時間：美東時間每週一至五 17:00（收盤後一小時），用 America/New_York 時區自動處理日光節約。
// 換成台灣時間約是隔天清晨 5~6 點。
// 金鑰存放在 Firebase Secret Manager，不寫進程式碼。
// 設定方式：firebase functions:secrets:set POLYGON_API_KEY
const POLYGON_API_KEY = defineSecret("POLYGON_API_KEY");

exports.autoFetchUsStocks = onSchedule({
  schedule: "0 8 * * 1-5",
  timeZone: "America/New_York",
  timeoutSeconds: 240,
  secrets: [POLYGON_API_KEY]
}, async (event) => {
  try {
    console.log("出發去 Polygon 搬美股收盤價...");
    const polygonKey = POLYGON_API_KEY.value();

    // 先收集所有使用者庫存中的美股代號（只存使用者持有的，避免單文件索引超限、也更省讀取）
    const usersSnap = await db.collection("users").get();
    const heldUS = new Set();
    usersSnap.forEach(s => {
      const d = s.data();
      (d.buyRecords || []).forEach(r => {
        if (r && r.country === "美股" && r.symbol) heldUS.add(String(r.symbol).trim().toUpperCase());
      });
    });
    if (heldUS.size === 0) { console.log("目前沒有任何美股庫存，略過。"); return; }
    console.log(`需要更新的美股代號（${heldUS.size}）：${[...heldUS].join(", ")}`);

    const fmt = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;

    // 免費方案的整批收盤資料約有 1~2 個交易日延遲，且假日無資料；
    // 因此從美東「今天」往回找最近一個「有授權且有資料」的交易日（跳過週末以節省 API 次數）。
    let cur = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    let found = null, usedDate = null;
    for (let i = 0; i < 8; i++) {
      const dow = cur.getDay();
      if (dow !== 0 && dow !== 6) { // 0=週日, 6=週六 → 跳過
        const date = fmt(cur);
        const url = `https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${date}?adjusted=true&apiKey=${polygonKey}`;
        const res = await fetch(url);
        const data = await res.json();
        if (data.results && data.results.length > 0) { found = data.results; usedDate = date; break; }
        console.log(`  ${date}: status=${data.status || "?"} count=${data.results ? data.results.length : 0}`);
      }
      cur.setDate(cur.getDate() - 1);
    }

    if (!found) { console.log("找不到可用的美股資料，略過（不覆蓋舊資料）。"); return; }

    // 再往回找「前一個交易日」收盤，作為今日損益的比較基準（13 秒節流避開免費方案 5 次/分限制）
    const canon = (s) => String(s).toUpperCase().replace(/[.\-/]/g, "");
    let prevResults = null, prevDate = null;
    const pcur = new Date(cur); pcur.setDate(pcur.getDate() - 1);
    for (let i = 0; i < 6 && !prevResults; i++) {
      const dow = pcur.getDay();
      if (dow !== 0 && dow !== 6) {
        await new Promise(s => setTimeout(s, 13000));
        const date = fmt(pcur);
        try {
          const res = await fetch(`https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${date}?adjusted=true&apiKey=${polygonKey}`);
          const data = await res.json();
          if (data.results && data.results.length > 0) { prevResults = data.results; prevDate = date; }
          else console.log(`  prev ${date}: status=${data.status || "?"} count=0`);
        } catch (e) { console.warn(`prev ${date} 讀取失敗`, e.message); }
      }
      pcur.setDate(pcur.getDate() - 1);
    }
    const prevMap = {};
    if (prevResults) prevResults.forEach(it => { if (it.T && typeof it.c === "number") prevMap[canon(it.T)] = it.c; });

    // 只挑出使用者持有的美股代號（代號正規化：去除 . - / 以相容 BRK.B / BRK-B 等不同寫法）
    const canonToHeld = {};
    heldUS.forEach(h => { canonToHeld[canon(h)] = h; });
    const stockMap = {};
    found.forEach(item => {
      if (item.T && typeof item.c === "number") {
        const held = canonToHeld[canon(item.T)];
        if (held) stockMap[held] = { price: item.c, prev: (typeof prevMap[canon(item.T)] === "number") ? prevMap[canon(item.T)] : null }; // 以使用者持有的代號格式存回
      }
    });

    await db.collection("daily_market").doc("us_stock_all").set({
      lastUpdated: new Date().toISOString(),
      date: usedDate,
      prevDate: prevDate || null,
      stocks: stockMap
    });

    console.log(`今日美股資料已存入：${Object.keys(stockMap).length} 檔 (${usedDate})`);

  } catch (error) {
    console.error("美股搬資料發生錯誤:", error);
  }
});

// ============ 股息自動偵測：庫存中未來一週將除息者，自動加入股息總攬 ============
// 美股：Polygon 股息 API（日期=撥款日 pay_date，自動扣 30% 稅）
// 台股：TWSE 除權息預告表（免費資料無撥款日 → 日期用除息日）
// 金額 = 持股數 × 每股現金股利；以 autoKey 去重，避免重複新增。
const DIVIDEND_DRY_RUN = false; // 已驗證，正式寫入

exports.autoFetchDividends = onSchedule({
  schedule: "0 9 * * *",
  timeZone: "Asia/Taipei",
  timeoutSeconds: 300,
  secrets: [POLYGON_API_KEY]
}, async (event) => {
  try {
    console.log(`股息自動偵測開始${DIVIDEND_DRY_RUN ? "（DRY RUN，不寫入）" : ""}...`);
    const polygonKey = POLYGON_API_KEY.value();
    const canon = (s) => String(s).toUpperCase().replace(/[.\-/]/g, "");
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const now = new Date();
    const todayG = fmt(now);
    const plus7G = fmt(new Date(now.getTime() + 7 * 86400000));

    // 1) 收集所有使用者持股（分美股 / 台股），同時保留各使用者資料
    const usersSnap = await db.collection("users").get();
    const usHeld = new Set(), twHeld = new Set();
    const userDocs = [];
    usersSnap.forEach(s => {
      const d = s.data();
      userDocs.push({ id: s.id, data: d });
      (d.buyRecords || []).forEach(r => {
        if (!r || !r.symbol || !(r.shares > 0)) return;
        if (r.country === "美股") usHeld.add(String(r.symbol).trim().toUpperCase());
        else if (r.country === "台股") twHeld.add(String(r.symbol).trim().toUpperCase());
      });
    });
    console.log(`持股：美股 ${usHeld.size} 檔、台股 ${twHeld.size} 檔`);

    // 2) 美股：Polygon 日期區間查未來一週除息（分頁 + 5/min 節流）
    const usDiv = {}; // canon -> { cash, pay, ex }
    if (usHeld.size > 0) {
      const heldCanon = new Set([...usHeld].map(canon));
      let url = `https://api.polygon.io/v3/reference/dividends?ex_dividend_date.gte=${todayG}&ex_dividend_date.lte=${plus7G}&limit=1000&apiKey=${polygonKey}`;
      for (let page = 0; page < 10 && url; page++) {
        const r = await fetch(url);
        const d = await r.json();
        (d.results || []).forEach(it => {
          const c = canon(it.ticker);
          if (heldCanon.has(c) && typeof it.cash_amount === "number" && it.cash_amount > 0) {
            if (!usDiv[c] || it.ex_dividend_date < usDiv[c].ex) usDiv[c] = { cash: it.cash_amount, pay: it.pay_date || it.ex_dividend_date, ex: it.ex_dividend_date };
          }
        });
        url = d.next_url ? `${d.next_url}&apiKey=${polygonKey}` : null;
        if (url) await new Promise(res => setTimeout(res, 13000)); // 節流
      }
    }

    // 3) 台股：TWSE 除權息預告表
    const twDiv = {}; // canon -> { cash, ex }
    if (twHeld.size > 0) {
      try {
        const r = await fetch("https://openapi.twse.com.tw/v1/exchangeReport/TWT48U_ALL");
        const arr = await r.json();
        const heldCanon = new Set([...twHeld].map(canon));
        (arr || []).forEach(it => {
          if (!it.Code || !it.Date) return;
          const c = canon(it.Code);
          if (!heldCanon.has(c)) return;
          if (!String(it.Exdividend || "").includes("息")) return; // 只取「息」（現金股利）
          const cash = parseFloat(it.CashDividend);
          if (!(cash > 0)) return;
          const s = String(it.Date); // 民國 yyymmdd，如 1150709
          if (s.length < 7) return;
          const ex = `${parseInt(s.slice(0, 3), 10) + 1911}-${s.slice(3, 5)}-${s.slice(5, 7)}`;
          if (ex >= todayG && ex <= plus7G) twDiv[c] = { cash, ex };
        });
      } catch (e) { console.warn("台股除息預告讀取失敗：", e); }
    }

    console.log(`本週除息：美股 ${Object.keys(usDiv).length} 檔、台股 ${Object.keys(twDiv).length} 檔`);
    if (Object.keys(usDiv).length === 0 && Object.keys(twDiv).length === 0) { console.log("本週無符合的除息標的，結束。"); return; }

    // 4) 逐使用者：依持股產生股息紀錄（去重後寫回 dividendRecords）
    let totalAdded = 0;
    for (const u of userDocs) {
      const buys = u.data.buyRecords || [];
      const divs = u.data.dividendRecords || [];
      const existKeys = new Set(divs.filter(d => d.autoKey).map(d => d.autoKey));
      const holdings = {}; // canon -> { symbol, country, type, broker, shares, src }
      buys.forEach(r => {
        if (!r || !r.symbol || !(r.shares > 0)) return;
        const c = canon(r.symbol);
        const src = r.country === "美股" ? usDiv[c] : (r.country === "台股" ? twDiv[c] : null);
        if (!src) return;
        if (!holdings[c]) holdings[c] = { symbol: r.symbol, country: r.country, type: r.type || "股票", broker: r.broker, shares: 0, src };
        holdings[c].shares += r.shares;
      });
      const newRecs = [];
      Object.values(holdings).forEach(h => {
        const autoKey = `${canon(h.symbol)}_${h.src.ex}`;
        if (existKeys.has(autoKey)) return; // 去重
        const amount = Math.round(h.shares * h.src.cash * 100) / 100;
        const fee = h.country === "美股" ? Math.round(amount * 0.3 * 100) / 100 : 0;
        const recDate = h.country === "美股" ? (h.src.pay || h.src.ex) : h.src.ex; // 美股=撥款日, 台股=除息日
        newRecs.push({ id: Date.now() + Math.floor(Math.random() * 1e6), broker: h.broker, symbol: h.symbol, date: recDate, country: h.country, type: h.type, amount, fee, auto: true, autoKey, exDate: h.src.ex });
      });
      if (newRecs.length > 0) {
        console.log(`使用者 ${u.id}：${DIVIDEND_DRY_RUN ? "[DRY] 將" : ""}新增 ${newRecs.length} 筆 → ${newRecs.map(x => `${x.symbol}(${x.date},$${x.amount})`).join(", ")}`);
        if (!DIVIDEND_DRY_RUN) {
          await db.collection("users").doc(u.id).set({ dividendRecords: divs.concat(newRecs) }, { merge: true });
        }
        totalAdded += newRecs.length;
      }
    }
    console.log(`股息自動偵測完成，共${DIVIDEND_DRY_RUN ? "（DRY）" : ""}新增 ${totalAdded} 筆。`);
  } catch (error) {
    console.error("股息偵測發生錯誤:", error);
  }
});