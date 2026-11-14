#!/usr/bin/env python3
"""列島建國：牌庫資料產生器（只用標準庫）。輸出 client/assets/kingdom/cards.json。

規格見 docs/kingdom-spec.md。三階建築（各 30 張）＋人物 20＋奇觀 10＋事件牌堆 18＋共同目標 10。
牌的成本／分數由固定亂數種子產生（`python tools/kingdom_cards.py` 結果每次都一樣），平衡調整改這裡的參數或下面的手寫表，再重跑；
重跑會覆寫 cards.json（內容感知寫檔：沒變就不重寫）。數值用 `python tools/kingdom_sim.py` 模擬驗證。

資源：W 木材、S 石塊、F 魚、I 鐵錠。金幣 G 是萬用牌，不在牌的成本裡。
"""
import json
import os
import random
import sys

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "client", "assets", "kingdom", "cards.json")
SEED = 20261114
RES = ["W", "S", "F", "I"]
RES_INFO = [
    {"id": "W", "name": "木材", "color": "#a9743f"},
    {"id": "S", "name": "石塊", "color": "#8d939b"},
    {"id": "F", "name": "魚獲", "color": "#4aa8d8"},
    {"id": "I", "name": "鐵錠", "color": "#c0603a"},
]

# 建築名稱：[階][產出資源] → 名稱清單（每張牌一個；不夠的循環加「二號」）。名稱是原創，主題是列島上的設施。
NAMES = {
    1: {"W": ["伐木營", "木匠鋪", "柴房", "瞭望塔", "樹屋", "搬運棧道", "鋸木台", "苗圃"],
        "S": ["採石坑", "碎石場", "石灰窯", "石磚鋪", "石階步道", "界碑工坊", "礦渣堆", "砌牆隊"],
        "F": ["漁民小屋", "曬魚架", "魚簍工坊", "淺灘網場", "釣魚碼頭", "鹽漬棚", "貝殼灘", "漁獲市集"],
        "I": ["鐵匠鋪", "礦工營", "熔鐵爐", "鍛造台", "鐵釘工坊", "鐵礦淘洗場", "磨刀石坊", "鐵鍊工房"]},
    2: {"W": ["造船廠", "木工學院", "林場總部", "風車磨坊", "橋樑工程隊", "木雕藝廊", "大木倉庫", "造林署"],
        "S": ["石匠公會", "大理石礦場", "城牆工事", "拱橋工坊", "石灰窯群", "石碑學院", "採礦總署", "堤防工程隊"],
        "F": ["遠洋漁船隊", "魚市總會", "養殖場", "海港貿易所", "魚油榨坊", "珊瑚潛水隊", "漁業公會", "燈塔管理處"],
        "I": ["兵器工坊", "鋼鐵熔爐", "機械工房", "礦業公司", "鑄鐘坊", "船錨鑄造廠", "鐵道舖設隊", "鍊金研究所"]},
    3: {"W": ["神木祭壇", "千年林場", "海上船塢", "皇家木工院", "樹海書院", "巨樹之塔", "方舟工程局", "森林議會"],
        "S": ["古石神殿", "巨像工坊", "要塞建築局", "天文石台", "大圖書館", "千階石塔", "王陵工程", "石之議會"],
        "F": ["深海探險團", "黃金漁場", "遠航艦隊", "海神神殿", "珍珠養殖園", "潮汐觀測所", "大港務局", "海洋議會"],
        "I": ["皇家兵工廠", "巨型熔爐", "天工機關城", "鐵之神殿", "鑄劍大師坊", "蒸汽工廠", "火山礦場", "鐵之議會"]},
}
PEOPLE_NAMES = ["採集長老", "海風商人", "巡礁人", "伐木領隊", "石匠師傅", "漁夫之首", "鐵匠宗師", "港口管事", "島嶼測量員", "旅行畫師",
                "守塔人", "流浪商隊", "學徒工頭", "潮汐預言家", "市集主事", "造橋師傅", "鹽商", "老水手長", "島民代表", "賢者"]
WONDER_NAMES = ["環島燈塔", "浮空花園", "潮汐神廟", "千年巨樹", "星象觀測台", "海底穹頂", "鐘樓之城", "彩虹大橋", "火山溫泉宮", "漂流圖書館"]


def cost_of(rng, gives, total, kinds):
    """從不含 gives 的資源挑 kinds 種，把 total 分給它們（每種至少 1）。"""
    others = [r for r in RES if r != gives]
    rng.shuffle(others)
    chosen = others[:kinds]
    amts = [1] * kinds
    for _ in range(total - kinds):
        amts[rng.randrange(kinds)] += 1
    return {r: a for r, a in zip(chosen, amts)}


def gen_buildings(rng):
    """每階 30 張：產出資源平均（8/8/7/7 輪流）。階內分數與成本由 TIER_SPEC 決定。"""
    out = []
    # (成本總和, 成本種類數, 分數, 效果) 的清單，30 個；產出資源依序輪流指派
    spec = {
        1: [(2, 2, 0)] * 6 + [(3, 2, 0)] * 6 + [(3, 3, 0)] * 4 + [(4, 2, 0)] * 4 + [(4, 3, 0)] * 2 + [(3, 1, 1)] * 2 + [(4, 2, 1)] * 4 + [(4, 1, 1)] * 2,
        2: [(5, 2, 1)] * 4 + [(5, 3, 1)] * 2 + [(6, 2, 2)] * 6 + [(6, 3, 2)] * 4 + [(7, 2, 2)] * 4 + [(7, 3, 3)] * 4 + [(8, 2, 3)] * 4 + [(8, 3, 3)] * 2,
        3: [(8, 3, 3)] * 4 + [(9, 3, 4)] * 12 + [(10, 2, 4)] * 4 + [(10, 3, 5)] * 6 + [(11, 3, 5)] * 4,
    }
    for tier in (1, 2, 3):
        rows = list(spec[tier])
        assert len(rows) == 30, (tier, len(rows))
        rng.shuffle(rows)
        gives_cycle = []
        while len(gives_cycle) < 30:
            g = RES[:]
            rng.shuffle(g)
            gives_cycle += g
        gives_cycle = gives_cycle[:30]
        name_idx = {r: 0 for r in RES}
        fx_slots = set(rng.sample(range(30), {1: 0, 2: 10, 3: 12}[tier]))
        for k, ((total, kinds, vp), gives) in enumerate(zip(rows, gives_cycle)):
            cost = cost_of(rng, gives, total, kinds)
            names = NAMES[tier][gives]
            nm = names[name_idx[gives] % len(names)]
            name_idx[gives] += 1
            fx = None
            if k in fx_slots:
                if tier == 2:   # 建造時立刻拿 1 個指定資源（分數少 1，最少 1 分）
                    fx = {"k": "gain", "res": rng.choice([r for r in RES if r != gives]), "n": 1}
                    vp = max(1, vp - 1)
                else:           # 三階：一半是「建造時拿 2 個」，一半是結算時的額外分數
                    if rng.random() < .5:
                        fx = {"k": "gain", "res": rng.choice(RES), "n": 2}
                        vp = max(2, vp - 1)
                    else:
                        of = rng.choice(["people", "wonder", "t1"])
                        fx = {"k": "vp_per", "of": of, "per": 2 if of == "t1" else 1, "vp": 1}   # 一階建築每 2 棟 +1、人物／奇觀每個 +1
                        vp = max(2, vp - 1)
            out.append({"id": f"b{tier}_{k + 1:02d}", "tier": tier, "name": nm, "gives": gives, "cost": cost, "vp": vp, "fx": fx})
    return out


PEOPLE_AB = [
    # 能力種類 k、參數、說明；每種 3～4 張，各配不同資源
    ("pair", None, "拿「2 張同種」時多拿 1 張（庫存夠才給）"),
    ("trade", None, "銀行交易改成 2:1"),
    ("t1disc", None, "建造一階建築時成本少 1 個資源（自動扣在你缺口最大的一種）"),
    ("gold2", None, "保留時多拿 1 枚金幣（共 2 枚）"),
    ("limit", None, "資源上限 +2、保留上限 +1"),
    ("unblock", None, "你不受封鎖影響：可以買被封鎖的牌"),
]


def gen_people(rng):
    out = []
    plan = [0, 0, 0, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 5]
    rng.shuffle(plan)
    for k, ab in enumerate(plan):
        need = rng.choice([2, 3, 3, 4])   # 要先有幾棟建築才能招募
        total = need + rng.choice([2, 3, 3, 4])
        cost = cost_of(rng, "-", min(total, 7), rng.choice([2, 2, 3]))
        vp = {2: 1, 3: 1, 4: 2}[need] if rng.random() < .75 else 0
        kk, _, text = PEOPLE_AB[ab]
        out.append({"id": f"p{k + 1:02d}", "name": PEOPLE_NAMES[k], "cost": cost, "need": need, "vp": vp, "ab": kk, "text": text})
    return out


def gen_wonders(rng):
    out = []
    for k in range(10):
        a, b = rng.sample(RES, 2)
        req = {a: rng.choice([2, 3]), b: rng.choice([2, 2, 3])}   # 前置：自己要有 N 棟產出該資源的建築
        c1, c2, c3 = rng.sample(RES, 3)
        cost = {c1: rng.choice([4, 5]), c2: rng.choice([3, 4]), c3: rng.choice([2, 3])}
        out.append({"id": f"w{k + 1:02d}", "name": WONDER_NAMES[k], "cost": cost, "req": req, "vp": rng.choice([6, 7, 7, 8])})
    return out


EVENTS = [
    ("harvest", "豐收", "這輪「拿 2 張同種」改成拿 3 張（庫存夠才給）。"),
    ("storm", "風暴", "這輪不能建造成本含魚獲的建築。"),
    ("festival", "慶典", "這輪每招募一位人物，立刻拿 1 枚金幣。"),
    ("tax", "稅收", "這輪結束時，手上資源（含金幣）超過 7 張的人丟到 7 張。"),
    ("drought", "乾旱", "這輪不能拿「2 張同種」。"),
    ("tradewind", "順風", "這輪銀行交易改成 2:1。"),
    ("rush", "趕工", "這輪建造任何牌的成本少 1 個資源（自動扣在你缺口最大的一種）。"),
    ("pirates", "海盜來襲", "這輪結束時，手上資源（含金幣）最多的人（平手全中）丟 2 張。"),
    ("marketday", "趕集日", "這輪封鎖不用付資源。"),
    ("muse", "靈感", "這輪保留時多拿 1 枚金幣（共 2 枚，和人物能力可疊加）。"),
    ("bounty", "賞金", "這輪每人第一次建造建築時額外 +1 分。"),
    ("notrade", "封港", "這輪不能銀行交易。"),
    ("calm", "風平浪靜", "這輪沒有特別的事。"),
]
EVENT_DECK = ["harvest", "harvest", "storm", "festival", "tax", "drought", "tradewind", "rush", "rush", "pirates", "marketday", "muse",
              "bounty", "bounty", "notrade", "calm", "calm", "tax"]

OBJECTIVES = [
    ("o01", "多元產業", "三種不同資源的產出建築各 2 棟以上", "types3x2"),
    ("o02", "大興土木", "擁有 9 棟建築", "build9"),
    ("o03", "招賢納士", "招募 3 位人物", "people3"),
    ("o04", "奇觀締造者", "蓋出 1 座奇觀", "wonder1"),
    ("o05", "高階匠人", "擁有 2 棟三階建築", "t3x2"),
    ("o06", "基層根基", "擁有 6 棟一階建築", "t1x6"),
    ("o07", "專精一業", "同一種資源的產出建築 5 棟", "prod5"),
    ("o08", "四海通達", "四種資源的產出建築各至少 1 棟，且共 7 棟", "all4x7"),
    ("o09", "三階起家", "同時擁有二階與三階建築各 2 棟", "t2t3x2"),
    ("o10", "人物與奇觀", "擁有 2 位人物與 1 座奇觀", "p2w1"),
]


def build():
    rng = random.Random(SEED)
    return {
        "_comment": "列島建國牌庫（tools/kingdom_cards.py 產生，種子固定；平衡調整改產生器再重跑）。規格見 docs/kingdom-spec.md。",
        "res": RES_INFO,
        "buildings": gen_buildings(rng),
        "people": gen_people(rng),
        "wonders": gen_wonders(rng),
        "events": [{"id": i, "name": n, "text": t} for i, n, t in EVENTS],
        "eventDeck": EVENT_DECK,
        "objectives": [{"id": i, "name": n, "text": t, "k": k} for i, n, t, k in OBJECTIVES],
    }


def main():
    data = build()
    text = json.dumps(data, ensure_ascii=False, indent=1) + "\n"
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    old = open(OUT, encoding="utf8", newline="").read() if os.path.exists(OUT) else None
    if old != text:
        open(OUT, "w", encoding="utf8", newline="").write(text)
        print("  kingdom/cards.json 已更新")
    else:
        print("  kingdom/cards.json 沒變")
    b = data["buildings"]
    for tier in (1, 2, 3):
        cs = [c for c in b if c["tier"] == tier]
        print(f"  第 {tier} 階 {len(cs)} 張：平均成本 {sum(sum(c['cost'].values()) for c in cs) / len(cs):.1f}、平均分數 {sum(c['vp'] for c in cs) / len(cs):.2f}、有效果 {sum(1 for c in cs if c['fx'])} 張")


if __name__ == "__main__":
    sys.exit(main())
