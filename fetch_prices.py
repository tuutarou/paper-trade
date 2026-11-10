"""
仮想トレードアプリ用の価格データを作る（GitHub Actions で30分ごとに実行）

出力: site/data.json
  - 各銘柄の15分足（直近10日）と日足（直近6か月）
  - 約定・答え合わせ・チャートはアプリ側がこのデータから計算する

APIキーは不要（Yahoo Finance を yfinance で取得）。
"""

import json
import math
import os
from datetime import datetime, timezone

import pandas as pd
import yfinance as yf

# market: TSE=東証 / US=米国市場 / FX=外国為替 / CRYPTO=暗号資産（24時間）
# unit: 通常の売買単位。odd=True は単元未満（1株から）も可（次の寄り付きで約定）
# qstep: 注文できる最小の数量
INSTRUMENTS = [
    # 日本株
    dict(id="7203.T", name="トヨタ自動車", cat="日本株", market="TSE", cur="JPY", unit=100, odd=True),
    dict(id="6758.T", name="ソニーグループ", cat="日本株", market="TSE", cur="JPY", unit=100, odd=True),
    dict(id="7974.T", name="任天堂", cat="日本株", market="TSE", cur="JPY", unit=100, odd=True),
    dict(id="9984.T", name="ソフトバンクグループ", cat="日本株", market="TSE", cur="JPY", unit=100, odd=True),
    dict(id="8306.T", name="三菱UFJ FG", cat="日本株", market="TSE", cur="JPY", unit=100, odd=True),
    dict(id="9432.T", name="NTT", cat="日本株", market="TSE", cur="JPY", unit=100, odd=True),
    dict(id="9434.T", name="ソフトバンク", cat="日本株", market="TSE", cur="JPY", unit=100, odd=True),
    dict(id="8035.T", name="東京エレクトロン", cat="日本株", market="TSE", cur="JPY", unit=100, odd=True),
    dict(id="6857.T", name="アドバンテスト", cat="日本株", market="TSE", cur="JPY", unit=100, odd=True),
    dict(id="9983.T", name="ファーストリテイリング", cat="日本株", market="TSE", cur="JPY", unit=100, odd=True),
    dict(id="8058.T", name="三菱商事", cat="日本株", market="TSE", cur="JPY", unit=100, odd=True),
    dict(id="2914.T", name="日本たばこ産業", cat="日本株", market="TSE", cur="JPY", unit=100, odd=True),
    dict(id="9104.T", name="商船三井", cat="日本株", market="TSE", cur="JPY", unit=100, odd=True),
    dict(id="7832.T", name="バンダイナムコHD", cat="日本株", market="TSE", cur="JPY", unit=100, odd=True),
    dict(id="3048.T", name="ビックカメラ", cat="日本株", market="TSE", cur="JPY", unit=100, odd=True),
    # 米国株
    dict(id="AAPL", name="Apple", cat="米国株", market="US", cur="USD", unit=1),
    dict(id="MSFT", name="Microsoft", cat="米国株", market="US", cur="USD", unit=1),
    dict(id="NVDA", name="NVIDIA", cat="米国株", market="US", cur="USD", unit=1),
    dict(id="GOOGL", name="Alphabet", cat="米国株", market="US", cur="USD", unit=1),
    dict(id="AMZN", name="Amazon", cat="米国株", market="US", cur="USD", unit=1),
    dict(id="META", name="Meta", cat="米国株", market="US", cur="USD", unit=1),
    dict(id="TSLA", name="テスラ", cat="米国株", market="US", cur="USD", unit=1),
    dict(id="AVGO", name="ブロードコム", cat="米国株", market="US", cur="USD", unit=1),
    dict(id="ADBE", name="Adobe", cat="米国株", market="US", cur="USD", unit=1),
    dict(id="KO", name="コカ・コーラ", cat="米国株", market="US", cur="USD", unit=1),
    dict(id="JNJ", name="ジョンソン・エンド・ジョンソン", cat="米国株", market="US", cur="USD", unit=1),
    dict(id="PLTR", name="パランティア", cat="米国株", market="US", cur="USD", unit=1),
    # ETF（指数に連動）
    dict(id="1306.T", name="TOPIX連動型ETF", cat="ETF", market="TSE", cur="JPY", unit=1),
    dict(id="1321.T", name="日経225連動型ETF", cat="ETF", market="TSE", cur="JPY", unit=1),
    dict(id="SPY", name="S&P500 ETF（SPY）", cat="ETF", market="US", cur="USD", unit=1),
    dict(id="QQQ", name="NASDAQ100 ETF（QQQ）", cat="ETF", market="US", cur="USD", unit=1),
    # 債券（債券に投資するETF）
    dict(id="2510.T", name="国内債券ETF（2510）", cat="債券", market="TSE", cur="JPY", unit=1),
    dict(id="2511.T", name="外国債券ETF（2511）", cat="債券", market="TSE", cur="JPY", unit=1),
    dict(id="TLT", name="米国長期国債ETF（TLT）", cat="債券", market="US", cur="USD", unit=1),
    dict(id="IEF", name="米国中期国債ETF（IEF）", cat="債券", market="US", cur="USD", unit=1),
    # 金
    dict(id="1540.T", name="純金上場信託（1540）", cat="金", market="TSE", cur="JPY", unit=1),
    dict(id="GLD", name="金ETF（GLD）", cat="金", market="US", cur="USD", unit=1),
    # FX（数量は通貨の単位。1,000通貨から）
    dict(id="USDJPY=X", name="米ドル/円", cat="FX", market="FX", cur="JPY", unit=1000),
    dict(id="EURJPY=X", name="ユーロ/円", cat="FX", market="FX", cur="JPY", unit=1000),
    dict(id="GBPJPY=X", name="英ポンド/円", cat="FX", market="FX", cur="JPY", unit=1000),
    dict(id="AUDJPY=X", name="豪ドル/円", cat="FX", market="FX", cur="JPY", unit=1000),
    dict(id="EURUSD=X", name="ユーロ/米ドル", cat="FX", market="FX", cur="USD", unit=1000),
    dict(id="GBPUSD=X", name="英ポンド/米ドル", cat="FX", market="FX", cur="USD", unit=1000),
    # 暗号資産（円建て。少数単位で買える）
    dict(id="BTC-JPY", name="ビットコイン", cat="暗号資産", market="CRYPTO", cur="JPY", unit=0.0001),
    dict(id="ETH-JPY", name="イーサリアム", cat="暗号資産", market="CRYPTO", cur="JPY", unit=0.001),
    dict(id="XRP-JPY", name="リップル", cat="暗号資産", market="CRYPTO", cur="JPY", unit=1),
    dict(id="SOL-JPY", name="ソラナ", cat="暗号資産", market="CRYPTO", cur="JPY", unit=0.01),
    dict(id="DOGE-JPY", name="ドージコイン", cat="暗号資産", market="CRYPTO", cur="JPY", unit=10),
]


def decimals(price):
    """表示と保存の小数桁（価格の大きさに合わせる）"""
    if price >= 1000:
        return 1
    if price >= 100:
        return 2
    if price >= 10:
        return 3
    if price >= 1:
        return 4
    return 6


def to_rows(df, dec):
    rows = []
    for ts, r in df.iterrows():
        vals = [r.get("Open"), r.get("High"), r.get("Low"), r.get("Close")]
        if any(v is None or (isinstance(v, float) and math.isnan(v)) for v in vals):
            continue
        t = int(pd.Timestamp(ts).tz_convert("UTC").timestamp() // 60) if pd.Timestamp(ts).tzinfo else \
            int(pd.Timestamp(ts).tz_localize("UTC").timestamp() // 60)
        rows.append([t] + [round(float(v), dec + 1) for v in vals])
    return rows


def pick(data, ticker):
    """yf.download の結果から1銘柄分を取り出す（列の形がバージョンで違うため両対応）"""
    if data is None or data.empty:
        return None
    if isinstance(data.columns, pd.MultiIndex):
        for key in (ticker,):
            if key in data.columns.get_level_values(0):
                return data[key].dropna(how="all")
            if key in data.columns.get_level_values(1):
                return data.xs(key, axis=1, level=1).dropna(how="all")
        return None
    return data.dropna(how="all")


def main():
    tickers = [i["id"] for i in INSTRUMENTS]
    intraday = yf.download(tickers, period="10d", interval="15m", group_by="ticker",
                           auto_adjust=False, threads=True, progress=False)
    daily = yf.download(tickers, period="6mo", interval="1d", group_by="ticker",
                        auto_adjust=False, threads=True, progress=False)

    out, missing = [], []
    for inst in INSTRUMENTS:
        i_df, d_df = pick(intraday, inst["id"]), pick(daily, inst["id"])
        ref = None
        for df in (i_df, d_df):
            if df is not None and not df.empty and "Close" in df:
                ref = float(df["Close"].dropna().iloc[-1])
                break
        if ref is None:
            missing.append(inst["name"])
            out.append({**inst, "dec": 2, "i": [], "d": [], "error": "取得できず"})
            continue
        dec = decimals(ref)
        out.append({**inst, "dec": dec,
                    "i": to_rows(i_df, dec) if i_df is not None else [],
                    "d": to_rows(d_df, dec) if d_df is not None else []})

    data = {"generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source": "Yahoo Finance（yfinance経由）", "missing": missing, "instruments": out}
    os.makedirs("site", exist_ok=True)
    with open("site/data.json", "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print(f"✅ {len(out) - len(missing)}/{len(out)} 銘柄を保存（取得できず: {', '.join(missing) or 'なし'}）")


if __name__ == "__main__":
    main()
