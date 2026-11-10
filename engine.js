/*
 * 仮想トレードの売買エンジン（画面から独立。ブラウザと Node の両方で動く）
 *
 * 考え方
 *  - 利用者の操作（注文・取消・設定）だけを保存し、約定や決済は価格データから毎回計算し直す。
 *    一度決まった約定・決済の結果は保存して、古いデータが消えても変わらないようにする。
 *  - 約定は「注文した時刻より後の最初の足の始値」。市場が閉まっていれば次に開いた時の値になる。
 *  - 単元未満株（日本株の100株未満）は、実際のサービスと同じく次の寄り付き（9:00 / 12:30）で約定。
 *  - 時刻はすべて「UNIX時刻（分）」で扱う。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Engine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---- コストの目安（会社やキャンペーンで変わる。画面の設定に一覧を表示） ----
  const COSTS = {
    usFeeRate: 0.00495, usFeeMaxUsd: 22,      // 米国株・米国ETFの売買手数料（約定代金の0.495%、上限22ドル）
    usFxSpread: 0.25,                         // 円⇔ドルの両替コスト（1ドルあたり25銭）
    cryptoFeeRate: 0.001,                     // 暗号資産（取引所形式）の手数料 0.1%
    leverage: 25,                             // FXのレバレッジ（日本の個人の上限）
    fxSpreadPips: { "USDJPY=X": 0.2, "EURJPY=X": 0.4, "GBPJPY=X": 0.9, "AUDJPY=X": 0.5, "EURUSD=X": 0.3, "GBPUSD=X": 0.6 },
  };
  const HORIZONS = { "": 0, "1日後": 1440, "3日後": 4320, "1週間後": 10080, "2週間後": 20160, "1か月後": 43200 };
  const EXPIRY = { "当日": "day", "1週間": 10080 };

  // ---- 時刻と取引時間 ----
  const fmtCache = {};
  function partsIn(tz, tMin) {
    const f = fmtCache[tz] || (fmtCache[tz] = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour12: false, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }));
    const p = {};
    for (const x of f.formatToParts(new Date(tMin * 60000))) p[x.type] = x.value;
    const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
    const hour = Number(p.hour) % 24;
    return { wd, hm: hour * 60 + Number(p.minute), ymd: `${p.year}-${p.month}-${p.day}` };
  }
  const jst = t => partsIn("Asia/Tokyo", t);
  const nyt = t => partsIn("America/New_York", t);

  /** 取引時間内か（祝日は考慮しない。祝日はデータに足が無いので約定は自然に次の営業日になる） */
  function isOpen(market, t) {
    if (market === "CRYPTO") return true;
    if (market === "TSE") {
      const p = jst(t);
      return p.wd >= 1 && p.wd <= 5 && ((p.hm >= 540 && p.hm < 690) || (p.hm >= 750 && p.hm < 930));
    }
    if (market === "US") {
      const p = nyt(t);
      return p.wd >= 1 && p.wd <= 5 && p.hm >= 570 && p.hm < 960;
    }
    if (market === "FX") {               // 日曜17時〜金曜17時（ニューヨーク時間）
      const p = nyt(t);
      if (p.wd === 6) return false;
      if (p.wd === 0) return p.hm >= 1020;
      if (p.wd === 5) return p.hm < 1020;
      return true;
    }
    return false;
  }

  /** 次に取引が始まる時刻（目安）。oddLot は次の寄り付き（9:00/12:30）。 */
  function nextOpen(market, t, oddLot) {
    let x = Math.ceil(t / 15) * 15;
    for (let i = 0; i < 4 * 24 * 8; i++, x += 15) {
      if (oddLot) {
        const p = jst(x);
        if (p.wd >= 1 && p.wd <= 5 && (p.hm === 540 || p.hm === 750) && x >= t) return x;
        continue;
      }
      if (isOpen(market, x) && (x >= t)) return x;
    }
    return null;
  }

  const MARKET_LABEL = { TSE: "東証", US: "米国市場", FX: "FX", CRYPTO: "24時間" };
  function marketText(inst, t) {
    if (inst.market === "CRYPTO") return { open: true, text: "24時間取引" };
    const open = isOpen(inst.market, t);
    if (open) return { open, text: `${MARKET_LABEL[inst.market]} 取引中` };
    const n = nextOpen(inst.market, t, false);
    return { open, text: `${MARKET_LABEL[inst.market]} 時間外（次は ${fmtJst(n)}）` };
  }

  function fmtJst(t, withYear) {
    if (t == null) return "—";
    const d = new Date(t * 60000);
    const o = { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false };
    if (withYear) o.year = "numeric";
    return new Intl.DateTimeFormat("ja-JP", o).format(d);
  }

  // ---- 価格データ ----
  // inst.i: 15分足 [[t,o,h,l,c],...]、inst.d: 日足
  function barsFrom(inst, t) {
    const intra = inst.i || [];
    if (intra.length && t >= intra[0][0]) return intra.filter(b => b[0] >= t);
    const daily = (inst.d || []).filter(b => b[0] >= t);
    const lastDaily = daily.length ? daily[daily.length - 1][0] : -Infinity;
    return daily.concat(intra.filter(b => b[0] > lastDaily));   // 古い期間は日足、つながる先は15分足
  }
  function last(inst) {
    const src = (inst.i && inst.i.length) ? inst.i : inst.d || [];
    return src.length ? { t: src[src.length - 1][0], price: src[src.length - 1][4] } : null;
  }
  function prevClose(inst) {
    const d = inst.d || [];
    if (d.length < 2) return null;
    const lt = last(inst);
    // 最後の日足が今日の分なら、その1本前が前日の終値
    const lastDay = d[d.length - 1];
    return lt && lt.t >= lastDay[0] ? d[d.length - 2][4] : lastDay[4];
  }
  function priceAt(inst, t) {
    const b = barsFrom(inst, t);
    return b.length ? { t: b[0][0], price: b[0][1] } : null;
  }
  function isFx(inst) { return inst.cat === "FX"; }
  function isOddLot(inst, qty) { return !!inst.odd && qty % inst.unit !== 0; }
  function pip(inst) { return inst.id.includes("JPY") ? 0.01 : 0.0001; }
  function halfSpread(inst) { return isFx(inst) ? (COSTS.fxSpreadPips[inst.id] || 1) * pip(inst) / 2 : 0; }

  /** USD/JPY の値（時刻 t の直後。無ければ最新） */
  function usdjpyAt(data, t) {
    const u = data.byId["USDJPY=X"];
    if (!u) return null;
    const p = t != null ? priceAt(u, t) : null;
    return p ? p.price : (last(u) || {}).price || null;
  }

  // ---- お金の計算 ----
  /** 現物の買い：必要な円 / 売り：受け取る円 */
  function cashFlow(inst, side, price, qty, fx) {
    const gross = price * qty;
    if (inst.cur === "USD") {
      const fee = Math.min(gross * COSTS.usFeeRate, COSTS.usFeeMaxUsd);
      return side > 0 ? (gross + fee) * (fx + COSTS.usFxSpread) : (gross - fee) * (fx - COSTS.usFxSpread);
    }
    if (inst.cat === "暗号資産") return side > 0 ? gross * (1 + COSTS.cryptoFeeRate) : gross * (1 - COSTS.cryptoFeeRate);
    return gross;                                   // 日本株・国内ETF：手数料0円の会社が多い
  }
  /** FXの損益（円） */
  function fxPnl(inst, side, entry, exit, qty, fx) {
    const pnl = side * (exit - entry) * qty;
    return inst.cur === "JPY" ? pnl : pnl * (fx || 0);
  }
  /** FXの必要証拠金（円） */
  function fxMargin(inst, price, qty, fx) {
    const notional = inst.cur === "JPY" ? price * qty : price * qty * (fx || 0);
    return notional / COSTS.leverage;
  }

  // ---- 状態 ----
  function newState(now, cash0 = 100000, monthly = 5000) {
    return { v: 1, start: now, cash0, monthly, orders: [], positions: [], seq: 1 };
  }
  /** 毎月1日の入金（開始した月の分は含めない） */
  function deposits(state, now) {
    if (!state.monthly) return 0;
    const s = jst(state.start).ymd.split("-").map(Number), n = jst(now).ymd.split("-").map(Number);
    const months = (n[0] - s[0]) * 12 + (n[1] - s[1]);
    return Math.max(0, months) * state.monthly;
  }

  function placeOrder(state, data, o, now) {
    const inst = data.byId[o.instId];
    if (!inst) throw new Error("銘柄が見つかりません");
    const qty = Number(o.qty);
    if (!(qty > 0)) throw new Error("数量を入れてください");
    const step = inst.odd ? 1 : inst.unit;
    if (Math.abs(qty / step - Math.round(qty / step)) > 1e-9) throw new Error(`数量は ${step} 単位で入れてください`);
    if (o.type === "limit" && !(Number(o.limit) > 0)) throw new Error("指値の価格を入れてください");
    if (o.action === "close") {
      const pos = state.positions.find(p => p.id === o.posId && p.status === "open");
      if (!pos) throw new Error("決済する建玉が見つかりません");
      if (qty > pos.qty + 1e-9) throw new Error("持っている数量より多くは売れません");
      if (state.orders.some(x => x.status === "pending" && x.posId === o.posId)) throw new Error("この建玉には約定待ちの決済注文があります");
    } else if (!isFx(inst) && o.side < 0) {
      throw new Error("現物は持っていない分を売れません（空売りはできません）");
    }
    if (o.action !== "close") {                        // 余力チェック（今の価格で見積もり）
      const est = estimate(data, inst, o.side, o.type === "limit" ? Number(o.limit) : (last(inst) || {}).price, qty, now);
      const s = summary(state, data, now);
      if (est.need > s.buyingPower + 1e-6) throw new Error(`余力が足りません（必要 約${Math.round(est.need).toLocaleString()}円 / 余力 ${Math.round(s.buyingPower).toLocaleString()}円）`);
    }
    const order = {
      id: state.seq++, t: now, instId: inst.id, action: o.action || "open", side: o.side, qty, type: o.type || "market",
      limit: o.type === "limit" ? Number(o.limit) : null, expiry: o.expiry || "当日",
      tp: num(o.tp), sl: num(o.sl), posId: o.posId || null, horizon: o.horizon || "", reason: (o.reason || "").trim(),
      status: "pending", odd: !isFx(inst) && isOddLot(inst, qty),
    };
    state.orders.push(order);
    return order;
  }
  function num(v) { const n = Number(v); return v === "" || v == null || !isFinite(n) || n <= 0 ? null : n; }

  function cancelOrder(state, id) {
    const o = state.orders.find(x => x.id === id);
    if (o && o.status === "pending") { o.status = "cancelled"; return true; }
    return false;
  }

  /** 注文前の見積もり */
  function estimate(data, inst, side, price, qty, now) {
    if (!price) return { need: 0, text: "価格がありません" };
    const fx = usdjpyAt(data, null);
    if (isFx(inst)) {
      const m = fxMargin(inst, price, qty, fx);
      return { need: m, text: `必要証拠金 約${Math.round(m).toLocaleString()}円（${COSTS.leverage}倍）` };
    }
    const need = cashFlow(inst, side > 0 ? 1 : -1, price, qty, fx || 0);
    const incl = inst.cur === "USD" ? "（手数料・両替コスト込み、今のドル円で計算）" : inst.cat === "暗号資産" ? "（手数料込み）" : "（手数料0円）";
    return { need: side > 0 ? need : 0, text: `${side > 0 ? "必要な金額" : "受け取る金額"} 約${Math.round(need).toLocaleString()}円${incl}` };
  }

  /** いつ約定するかの説明 */
  function timingText(inst, qty, type, now) {
    if (type === "limit") return "指値：価格が指定の値に届いたときに約定します（届かなければ期限で失効）。";
    if (!isFx(inst) && isOddLot(inst, qty)) {
      return `単元未満（${inst.unit}株未満）の注文は、次の寄り付き（${fmtJst(nextOpen(inst.market, now, true))}ごろ）の価格で約定します。`;
    }
    if (isOpen(inst.market, now)) return "取引時間中です。注文した時刻の直後の価格（15分足の始値）で約定します。";
    return `今は取引時間外です。次に取引が始まる時（${fmtJst(nextOpen(inst.market, now, false))}ごろ）の価格で約定します。`;
  }

  // ---- 約定と決済の処理（価格データが新しくなるたびに呼ぶ） ----
  function expiryTime(o, inst) {
    if (o.type !== "limit") return Infinity;
    if (o.expiry === "1週間") return o.t + 10080;
    // 当日：注文した日（取引時間外なら次の取引日）の取引終了まで
    const first = isOpen(inst.market, o.t) ? o.t : nextOpen(inst.market, o.t, false);
    if (first == null) return o.t + 1440;
    let x = first;
    while (isOpen(inst.market, x) && x < first + 1440) x += 15;
    if (inst.market === "TSE") {                      // 昼休みをまたいで15:30まで
      const p = jst(first);
      if (p.hm < 690) x = first + (930 - p.hm);
    }
    return x;
  }

  function tryFill(o, inst, data, now) {
    let bars = barsFrom(inst, o.t);
    if (o.odd) bars = bars.filter(b => { const p = jst(b[0]); return p.hm === 540 || p.hm === 750; });
    const exp = expiryTime(o, inst);
    const buy = (o.action === "close" ? -o.side : o.side) > 0;     // 決済の売買方向は建玉の逆
    for (const b of bars) {
      if (b[0] >= exp) return { expired: true };
      let price = null;
      if (o.type === "market") price = b[1];
      else if (buy) price = b[1] <= o.limit ? b[1] : (b[3] <= o.limit ? o.limit : null);
      else price = b[1] >= o.limit ? b[1] : (b[2] >= o.limit ? o.limit : null);
      if (price != null) {
        price += (buy ? 1 : -1) * halfSpread(inst);
        return { t: b[0], price, fx: inst.cur === "USD" ? usdjpyAt(data, b[0]) : null };
      }
    }
    if (exp !== Infinity && now >= exp && bars.length && bars[bars.length - 1][0] >= exp - 15) return { expired: true };
    return null;
  }

  function process(state, data, now) {
    const events = [];
    // 1) 約定待ちの注文
    for (const o of state.orders.filter(x => x.status === "pending" && x.action === "open").sort((a, b) => a.t - b.t)) {
      const inst = data.byId[o.instId];
      if (!inst) continue;
      const f = tryFill(o, inst, data, now);
      if (!f) continue;
      if (f.expired) { o.status = "expired"; events.push({ type: "expired", order: o }); continue; }
      if (o.action === "open") {
        if (!isFx(inst)) {
          const need = cashFlow(inst, 1, f.price, o.qty, f.fx || 0);
          if (need > cashAt(state, data, f.t) + 1e-6) { o.status = "rejected"; o.note = "約定時に余力が足りませんでした"; events.push({ type: "rejected", order: o }); continue; }
        }
        o.status = "filled"; o.fill = f;
        state.positions.push({ id: state.seq++, instId: inst.id, side: o.side, qty: o.qty, entry: f.price, entryT: f.t, entryFx: f.fx,
          cost: isFx(inst) ? 0 : cashFlow(inst, 1, f.price, o.qty, f.fx || 0), tp: o.tp, sl: o.sl, orderId: o.id, status: "open" });
        events.push({ type: "filled", order: o });
      }
    }
    // 2) 建玉の決済：「決済注文の約定」と「利確・損切りに届いた時」のうち早い方
    for (const pos of state.positions.filter(p => p.status === "open")) {
      const inst = data.byId[pos.instId];
      if (!inst) continue;
      const hit = tpslHit(pos, inst);
      const co = state.orders.find(x => x.status === "pending" && x.action === "close" && x.posId === pos.id);
      const f = co ? tryFill(co, inst, data, now) : null;
      if (f && f.expired) { co.status = "expired"; events.push({ type: "expired", order: co }); }
      const fillOk = f && !f.expired;
      if (hit && (!fillOk || hit.t < f.t)) {
        closePosition(state, data, pos, hit.price, hit.t, inst.cur === "USD" ? usdjpyAt(data, hit.t) : null, hit.reason, pos.qty);
        if (co && co.status === "pending") { co.status = "cancelled"; co.note = `先に${hit.reason}で決済されました`; }
        events.push({ type: hit.reason, pos });
      } else if (fillOk) {
        co.status = "filled"; co.fill = f;
        closePosition(state, data, pos, f.price, f.t, f.fx, "決済", co.qty);
        events.push({ type: "filled", order: co });
      }
    }
    // 3) 答え合わせ（期限が来た注文）
    for (const o of state.orders.filter(x => x.status === "filled" && x.action === "open" && x.horizon && !x.check)) {
      const inst = data.byId[o.instId];
      const due = o.fill.t + HORIZONS[o.horizon];
      if (!inst || now < due) continue;
      const p = priceAt(inst, due);
      if (!p) continue;
      const fx = inst.cur === "USD" ? usdjpyAt(data, p.t) : null;
      const exitPx = p.price - o.side * halfSpread(inst);
      const pnl = isFx(inst) ? fxPnl(inst, o.side, o.fill.price, exitPx, o.qty, fx)
        : cashFlow(inst, -1, exitPx, o.qty, fx || 0) - cashFlow(inst, 1, o.fill.price, o.qty, o.fill.fx || 0);
      o.check = { t: p.t, price: p.price, pnl, win: pnl > 0 };
      events.push({ type: "checked", order: o });
    }
    return events;
  }

  /** 利確・損切りに届いた最初の足（約定した足の次から。窓を開けて飛んだら始値＝不利な方で決済） */
  function tpslHit(pos, inst) {
    if (!pos.tp && !pos.sl) return null;
    const long = pos.side > 0;
    for (const b of barsFrom(inst, pos.entryT + 1)) {
      const [t, o, h, l] = b;
      let r = null;
      if (pos.sl && (long ? l <= pos.sl : h >= pos.sl)) r = { reason: "損切り", price: long ? Math.min(o, pos.sl) : Math.max(o, pos.sl) };
      else if (pos.tp && (long ? h >= pos.tp : l <= pos.tp)) r = { reason: "利確", price: long ? Math.max(o, pos.tp) : Math.min(o, pos.tp) };
      if (r) return { t, reason: r.reason, price: r.price + (long ? -1 : 1) * halfSpread(inst) };
    }
    return null;
  }

  function closePosition(state, data, pos, price, t, fx, reason, qty) {
    const inst = data.byId[pos.instId];
    if (qty < pos.qty - 1e-9) {                      // 一部だけ決済：残りを新しい建玉として分ける
      const rest = { ...pos, id: state.seq++, qty: pos.qty - qty, cost: pos.cost * (pos.qty - qty) / pos.qty };
      pos.cost = pos.cost * qty / pos.qty; pos.qty = qty;
      state.positions.push(rest);
    }
    const proceeds = isFx(inst) ? 0 : cashFlow(inst, -1, price, pos.qty, fx || 0);
    const pnl = isFx(inst) ? fxPnl(inst, pos.side, pos.entry, price, pos.qty, fx || usdjpyAt(data, t)) : proceeds - pos.cost;
    Object.assign(pos, { status: "closed", exit: { t, price, fx, reason, proceeds, pnl } });
  }

  /** ある時点までの現金（約定時の余力確認用） */
  function cashAt(state, data, t) {
    let cash = state.cash0 + deposits(state, t);
    for (const p of state.positions) {
      if (p.entryT <= t) cash -= p.cost;
      if (p.status === "closed" && p.exit.t <= t) cash += isFx(data.byId[p.instId]) ? p.exit.pnl : p.exit.proceeds;
    }
    for (const p of state.positions) if (p.status === "open" && isFx(data.byId[p.instId]) && p.entryT <= t) {
      const inst = data.byId[p.instId];
      cash -= fxMargin(inst, p.entry, p.qty, p.entryFx || usdjpyAt(data, t));
    }
    return cash;
  }

  // ---- 集計 ----
  function valuePosition(data, pos) {
    const inst = data.byId[pos.instId];
    const lp = last(inst);
    if (!lp) return { price: null, value: null, pnl: null };
    const fx = usdjpyAt(data, null);
    if (isFx(inst)) {
      const exitPx = lp.price - pos.side * halfSpread(inst);
      const pnl = fxPnl(inst, pos.side, pos.entry, exitPx, pos.qty, fx);
      return { price: lp.price, value: pnl, pnl, margin: fxMargin(inst, lp.price, pos.qty, fx) };
    }
    const value = cashFlow(inst, -1, lp.price, pos.qty, fx || 0);
    return { price: lp.price, value, pnl: value - pos.cost };
  }

  function summary(state, data, now) {
    let cash = state.cash0 + deposits(state, now), stockValue = 0, fxUnreal = 0, fxMarginSum = 0, realized = 0;
    for (const p of state.positions) {
      const inst = data.byId[p.instId];
      if (!inst) continue;
      cash -= p.cost;
      if (p.status === "closed") { cash += isFx(inst) ? p.exit.pnl : p.exit.proceeds; realized += p.exit.pnl; continue; }
      const v = valuePosition(data, p);
      if (isFx(inst)) { fxUnreal += v.pnl || 0; fxMarginSum += v.margin || 0; } else stockValue += v.value || 0;
    }
    let pendingNeed = 0;
    for (const o of state.orders.filter(x => x.status === "pending" && x.action === "open")) {
      const inst = data.byId[o.instId];
      if (!inst) continue;
      const px = o.type === "limit" ? o.limit : (last(inst) || {}).price;
      pendingNeed += estimate(data, inst, o.side, px, o.qty, now).need;
    }
    const equity = cash + stockValue + fxUnreal;
    const invested = state.cash0 + deposits(state, now);
    return {
      cash, stockValue, fxUnreal, fxMargin: fxMarginSum, realized, equity, invested,
      totalPnl: equity - invested,
      buyingPower: cash + Math.min(0, fxUnreal) - fxMarginSum - pendingNeed,
      marginRatio: fxMarginSum ? (cash + fxUnreal) / fxMarginSum : null,
    };
  }

  function stats(state) {
    const checks = state.orders.filter(o => o.check).map(o => o.check.pnl);
    const closed = state.positions.filter(p => p.status === "closed").map(p => p.exit.pnl);
    const s = arr => arr.length ? { n: arr.length, wins: arr.filter(x => x > 0).length, total: arr.reduce((a, b) => a + b, 0), worst: Math.min(...arr), best: Math.max(...arr) } : null;
    return { checks: s(checks), closed: s(closed) };
  }

  function prepare(raw) {
    raw.byId = {};
    for (const inst of raw.instruments) raw.byId[inst.id] = inst;
    raw.generatedMin = Math.floor(Date.parse(raw.generated) / 60000);
    return raw;
  }

  return { COSTS, HORIZONS, EXPIRY, isOpen, nextOpen, marketText, fmtJst, last, prevClose, priceAt, barsFrom, isFx, isOddLot,
    newState, deposits, placeOrder, cancelOrder, estimate, timingText, process, summary, stats, valuePosition, prepare, usdjpyAt, jst };
});
