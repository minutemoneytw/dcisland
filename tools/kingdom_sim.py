#!/usr/bin/env python3
"""列島建國：平衡模擬器（只用標準庫）。載入 tools/dev_server.py 裡的規則（kg_*）與 client/assets/kingdom/cards.json，
讓機器人對打，統計：平均回合數（目標 16～18 輪）、先後手勝率、哪些牌從不被買／太強、哪些共同目標常被拿等。

用法：python tools/kingdom_sim.py [局數＝300] [人數＝4] [勝利分數＝dev_server 的 KG_WIN_VP]    例：python tools/kingdom_sim.py 500 3 20
機器人：random 隨機合法動作／greedy 貪心買最高分／engine 前期先買產出、後期衝分數（三種輪流入座，勝率可看出哪種打法強）。
"""
import collections
import importlib.util
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("ds", os.path.join(HERE, "dev_server.py"))
ds = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ds)
RES = ds.KG_RES


def card_value(g, i, cid, style, nbld):
    c = ds.kg_card(cid)
    kind = cid[0]
    v = c["vp"] * 3.0
    if kind == "b":
        early = nbld < (6 if style == "engine" else 3)
        v += (2.5 if early else 0.8)   # 產出資源＝永久折扣
        if c.get("fx"):
            v += 1.0
    elif kind == "p":
        v += 3.0
    else:
        v += 4.0
    return v


def affordable(g, i, cid, s, tier, idx):
    t_msg = {"a": "kb", "s": s, "i": idx}
    if s == "m":
        t_msg["tier"] = tier
    return t_msg


def candidates_build(g, i):
    """所有可以建造的來源（不檢查能不能付，丟給 kg_act 判斷）。"""
    sd = g["sd"][i]
    out = []
    for tier in (1, 2, 3):
        for k, cid in enumerate(g["mkt"][tier]):
            if cid:
                out.append((cid, {"a": "kb", "s": "m", "tier": tier, "i": k}))
    for k, cid in enumerate(sd["hand"]):
        out.append((cid, {"a": "kb", "s": "h", "i": k}))
    for k, cid in enumerate(g["pmkt"]):
        if cid:
            out.append((cid, {"a": "kb", "s": "p", "i": k}))
    for k, cid in enumerate(g["wond"]):
        if cid:
            out.append((cid, {"a": "kb", "s": "w", "i": k}))
    return out


def auto_drop(g, sd, add_res, add_gold):
    """動作後超過上限時的丟棄：從最多的資源丟（金幣最後）。"""
    res = dict(sd["res"])
    for r, n in add_res.items():
        res[r] += n
    gold = sd["gold"] + add_gold
    over = sum(res.values()) + gold - ds.kg_limit(sd)
    drop = {}
    while over > 0:
        r = max(RES, key=lambda x: res[x])
        if res[r] > 0:
            res[r] -= 1
            drop[r] = drop.get(r, 0) + 1
        else:
            gold -= 1
            drop["G"] = drop.get("G", 0) + 1
        over -= 1
    return drop


def missing(g, i, cid):
    c = ds.kg_card(cid)
    need = ds.kg_cost(g, i, c, cid[0])
    sd = g["sd"][i]
    return {r: max(0, n - sd["res"][r]) for r, n in need.items() if n > sd["res"][r]}


def pick_take(g, i, target):
    sd = g["sd"][i]
    want = collections.Counter()
    if target:
        for r, n in missing(g, i, target).items():
            want[r] = n
    avail = [r for r in RES if g["sup"][r] > 0]
    random.shuffle(avail)
    order = sorted(avail, key=lambda r: -want[r])
    # 缺同一種 ≥2、庫存 ≥4、沒乾旱：拿 2 張同種
    for r in order:
        if want[r] >= 2 and g["sup"][r] >= 4 and ds.kg_event(g) != "drought":
            return [r, r]
    return order[:min(3, len(avail))]


def move(t, i, style, rng, now):
    """讓第 i 位（機器人）做一個主要動作；回 True。"""
    g = t["g"]; sd = g["sd"][i]; cid_seat = t["seats"][i]["cid"]
    nbld = len(sd["bld"])
    cands = candidates_build(g, i)
    if style == "random":
        opts = []
        for cid, msg in cands:
            opts.append(msg)
        for _ in range(3):
            opts.append({"a": "kt", "r": rng.sample(RES, 3)})
        opts.append({"a": "kt", "r": [rng.choice(RES)] * 2})
        opts.append({"a": "kr", "tier": rng.choice((1, 2, 3)), "i": rng.randrange(-1, 4)})
        rng.shuffle(opts)
        for msg in opts:
            if "drop" not in msg and msg["a"] in ("kt", "kr", "kb"):
                msg = dict(msg, drop=auto_drop(g, sd, {r: 1 for r in (msg.get("r") or [])} if msg["a"] == "kt" else {}, 1 if msg["a"] == "kr" else 0))
            if ds.kg_act(t, cid_seat, msg, now):
                return True
        return ds.kg_act(t, cid_seat, {"a": "kp"}, now)
    # greedy／engine：先買最有價值的買得起的，否則朝最想要的牌拿資源
    scored = sorted(cands, key=lambda cm: -card_value(g, i, cm[0], style, nbld))
    for cid, msg in scored:
        if style == "greedy" and ds.kg_card(cid)["vp"] == 0 and nbld >= 3 and cid[0] == "b" and len(sd["bld"]) > 6:
            continue
        m2 = dict(msg, drop=auto_drop(g, sd, {}, 0))
        if ds.kg_act(t, cid_seat, m2, now):
            return True
    # 買不起：挑目標（市場＋手上＋人物＋奇觀裡價值／缺口最好的）
    best, bs = None, -1
    for cid, _m in cands:
        miss = sum(missing(g, i, cid).values())
        sc = card_value(g, i, cid, style, nbld) / (1 + miss)
        if sc > bs:
            best, bs = cid, sc
    # 手上保留還沒滿、目標在市場上很貴：偶爾保留（拿金幣）
    if best and len(sd["hand"]) < ds.kg_hand_limit(sd) and rng.random() < .12 and best in sum(g["mkt"].values(), []):
        tier = ds.kg_card(best)["tier"]
        idx = g["mkt"][tier].index(best)
        if ds.kg_act(t, cid_seat, {"a": "kr", "tier": tier, "i": idx, "drop": auto_drop(g, sd, {}, 1)}, now):
            return True
    r = pick_take(g, i, best)
    msg = {"a": "kt", "r": r, "drop": auto_drop(g, sd, collections.Counter(r) if len(set(r)) == len(r) else {r[0]: 2}, 0)}
    if len(r) == 2 and r[0] == r[1]:
        n = 2 + (1 if ds.kg_event(g) == "harvest" else 0) + (1 if ds.kg_has(sd, "pair") else 0)
        msg["drop"] = auto_drop(g, sd, {r[0]: min(n, g["sup"][r[0]])}, 0)
    if ds.kg_act(t, cid_seat, msg, now):
        return True
    # 拿不了：保留牌堆頂，或跳過
    for tier in (3, 2, 1):
        if len(sd["hand"]) < ds.kg_hand_limit(sd) and ds.kg_act(t, cid_seat, {"a": "kr", "tier": tier, "i": -1, "drop": auto_drop(g, sd, {}, 1)}, now):
            return True
    return ds.kg_act(t, cid_seat, {"a": "kp"}, now)


def play(n, styles, rng):
    t = ds.tbl_new("t17", "kingdom")
    for i in range(n):
        ds.tbl_join(t, i + 1, f"B{i}")
    for i in range(n):
        ds.tbl_ready(t, i + 1, True)
    assert t["phase"] == "playing", "沒開局"
    g = t["g"]
    now = int(1e12)
    turns = 0
    bought = collections.Counter()
    while t["phase"] == "playing" and turns < 2000:
        i = t["turn"]
        before = {k: len(s["bld"]) + len(s["ppl"]) + len(s["won"]) for k, s in enumerate(g["sd"])}
        ids_before = [set(s["bld"] + s["ppl"] + s["won"]) for s in g["sd"]]
        if not move(t, i, styles[i], rng, now):
            ds.kg_act(t, t["seats"][i]["cid"], {"a": "kp"}, now)
        for k, s in enumerate(g["sd"]):
            for cid in set(s["bld"] + s["ppl"] + s["won"]) - ids_before[k]:
                bought[cid] += 1
        turns += 1
        now += 1000
    res = t["result"]
    # 結果在 phase 回到 lobby 後 t["g"] 仍留著最後盤面
    return {"turns": turns, "rounds": g["round"], "players": res["players"], "winners": res["winners"], "start": g["start"], "bought": bought,
            "obj": [o["by"] for o in g["obj"]], "events": g["evdeck"][:g["round"]], "stall": turns >= 2000}


def main():
    games = int(sys.argv[1]) if len(sys.argv) > 1 else 300
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 4
    if len(sys.argv) > 3:   # 第三個參數：勝利分數（試算用，不改 dev_server 的常數）
        ds.KG_WIN_VP = int(sys.argv[3])
    rng = random.Random(7)
    random.seed(11)
    styles_pool = ["engine", "greedy", "random"]
    rounds, vps, stalls = [], [], 0
    win_by_style = collections.Counter()
    win_by_pos = collections.Counter()
    bought_all = collections.Counter()
    obj_claimed = collections.Counter()
    obj_total = collections.Counter()
    played_style = collections.Counter()
    for gi in range(games):
        styles = [styles_pool[(gi + k) % 3] for k in range(n)]
        rng.shuffle(styles)
        r = play(n, styles, rng)
        stalls += r["stall"]
        rounds.append(r["rounds"])
        vps.append(max(p["vp"] for p in r["players"]))
        for k, st in enumerate(styles):
            played_style[st] += 1
        for w in r["winners"]:
            win_by_style[styles[w]] += 1
            win_by_pos[(w - r["start"]) % n] += 1
        bought_all.update(r["bought"])
    avg = sum(rounds) / len(rounds)
    print(f"{n} 人 {games} 局：平均 {avg:.1f} 輪（最短 {min(rounds)}、最長 {max(rounds)}）、獲勝者平均 {sum(vps) / len(vps):.1f} 分、卡住 {stalls} 局")
    print("勝率（依機器人風格；同風格人數不同時已以出場次數校正）：", {s: f"{win_by_style[s] / max(1, played_style[s]) * 100:.0f}%" for s in styles_pool})
    print("勝率（依先後手順位 0＝先手）：", {k: f"{win_by_pos[k] / games * 100:.0f}%" for k in sorted(win_by_pos)})
    cards = ds.kg_data()["cards"]
    never = [c for c in cards if bought_all[c] == 0]
    print(f"從沒被買的牌 {len(never)} 張：", "、".join(f"{c}({cards[c]['name']})" for c in never[:30]))
    byt = {1: [], 2: [], 3: []}
    for c in cards.values():
        if c["id"][0] == "b":
            byt[c["tier"]].append(bought_all[c["id"]])
    print("每階建築平均被買次數：", {t: f"{sum(v) / len(v):.1f}" for t, v in byt.items()})
    ppl = [bought_all[c] for c in cards if c[0] == "p"]
    won = [bought_all[c] for c in cards if c[0] == "w"]
    print(f"人物平均被招募 {sum(ppl) / len(ppl):.1f} 次、奇觀平均被蓋 {sum(won) / len(won):.1f} 次（每局公開 4 座，所以最多約 {games * 4 / len(won):.0f} 次）")


if __name__ == "__main__":
    main()
