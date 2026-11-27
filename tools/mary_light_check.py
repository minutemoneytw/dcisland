#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 小瑪莉送燈鎖死：本機押注與伺服器這注不一致時，light:1 會被拒、燈數不減。
# 重送必須用伺服器的 ma.bets。獎池有錢時付費開獎仍要先領出（這條不能被這次修掉）。
# 用法：python tools/mary_light_check.py
import json, pathlib, re, subprocess, sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
import dev_server  # noqa: E402

SRC = (ROOT / "client" / "js" / "main.js").read_text(encoding="utf-8")
WORKER = (ROOT / "worker" / "src" / "index.js").read_text(encoding="utf-8")
SERVER = (HERE / "dev_server.py").read_text(encoding="utf-8")


def die(msg):
    print("FAIL:", msg)
    sys.exit(1)


def js_fns():
    chunks = []
    for name in ("maryLightBets", "maryBetsLocked"):
        m = re.search(rf"function {name}\([\s\S]*?\n\}}\n", SRC)
        if not m:
            die(f"main.js 找不到 {name}")
        chunks.append(m.group(0))
    return "\n".join(chunks)


def node_eval(expr, fns):
    script = fns + "\nprocess.stdout.write(JSON.stringify(" + expr + "));\n"
    out = subprocess.check_output(["node", "-e", script], text=True)
    return json.loads(out)


def table(lights, bets, pot=0, seq=4):
    return {
        "phase": "playing",
        "log": [],
        "seats": [{"name": "測", "chips": 50000, "cid": 1}],
        "g": {
            "pot": pot, "bets": list(bets), "last": 0, "dcard": -1, "seq": seq, "rseq": seq,
            "lights": lights, "owner": "gold_dragon", "spent": 0, "paid": 0, "lastWin": 0,
            "allwin": False, "show": None, "jp": 0,
        },
    }


def main():
    if "bets: maryLightBets(ma2, S.maryBets)" not in SRC:
        die("maryLightsNext 沒有改送 maryLightBets")
    if re.search(r"bets:\s*S\.maryBets,\s*light:\s*1", SRC):
        die("送燈仍直接送 S.maryBets")
    if "g.pot > 0 && !(g.lights > 0)" not in WORKER or "送燈期間不能改押注" not in WORKER:
        die("worker 的獎池門或送燈押注檢查不見了")
    if 'g["pot"] > 0 and not g.get("lights")' not in SERVER or "送燈期間不能改押注" not in SERVER:
        die("dev_server 的獎池門或送燈押注檢查不見了")

    fns = js_fns()
    server_bets = [10, 0, 0, 0, 0, 0, 0, 0]
    local_bets = [10, 50, 0, 0, 0, 0, 0, 0]
    got = node_eval(f"maryLightBets({{bets:{json.dumps(server_bets)}}}, {json.dumps(local_bets)})", fns)
    if got != server_bets:
        die(f"送燈應送伺服器押注，實際 {got}")
    got = node_eval(f"maryLightBets({{}}, {json.dumps(local_bets)})", fns)
    if got != local_bets:
        die(f"伺服器沒帶 bets 時應退回本機押注，實際 {got}")
    locked = {
        "開獎已送出": "maryBetsLocked({betLock:true}, {lights:0, pot:100})",
        "跑馬燈中": "maryBetsLocked({spin:{}}, {lights:0})",
        "送燈中": "maryBetsLocked({}, {lights:2})",
    }
    for label, expr in locked.items():
        if node_eval(expr, fns) is not True:
            die(f"{label} 應該鎖住改注")
    # 獎池有錢不能改注是另一條（maryAddBet 直接看 pot），不要塞進送燈鎖
    if node_eval("maryBetsLocked({}, {lights:0, pot:80})", fns) is not False:
        die("獎池門被併進 maryBetsLocked")
    if node_eval("maryBetsLocked(null, {lights:0})", fns) is not False:
        die("沒事時不該鎖改注")

    room = dev_server.Room()
    # 開獎固定落在有押的圖案，避免 ONCE MORE 把燈數加回去，這條測的是「拒收／往下消耗」
    dev_server.ma_roll = lambda: "chicken"
    t = table(3, server_bets)
    seq0 = t["g"]["seq"]
    for _ in range(4):
        ok, err = room.ma_spin(t, 0, {"bets": local_bets, "light": 1})
        if (ok, err) != (False, "送燈期間不能改押注") or t["g"]["lights"] != 3 or t["g"]["seq"] != seq0:
            die(f"改過的押注重送應被拒且燈數不動，得到 {(ok, err)} lights={t['g']['lights']} seq={t['g']['seq']}")
    payload = node_eval(f"maryLightBets({{bets:{json.dumps(t['g']['bets'])}}}, {json.dumps(local_bets)})", fns)
    while t["g"]["lights"] > 0:
        before, seq_before = t["g"]["lights"], t["g"]["seq"]
        ok, err = room.ma_spin(t, 0, {"bets": payload, "light": 1})
        if not ok or err is not None or t["g"]["lights"] != before - 1 or t["g"]["seq"] != seq_before + 1:
            die(f"用伺服器押注送燈應消耗一燈，得到 {(ok, err)} lights {before}->{t['g']['lights']}")
    if t["g"]["lights"] != 0:
        die("燈沒有跑完")
    # 燈跑完、獎池有獎金：付費開獎仍要先領出
    t["g"]["pot"] = max(t["g"]["pot"], 20)
    pot = t["g"]["pot"]
    seq1 = t["g"]["seq"]
    ok, err = room.ma_spin(t, 0, {"bets": server_bets})
    if (ok, err) != (False, None) or t["g"]["pot"] != pot or t["g"]["seq"] != seq1:
        die(f"獎池有錢時付費開獎不該被接受，得到 {(ok, err)} pot={t['g']['pot']}")
    ok, err = room.ma_collect(t, 0)
    if not ok or t["g"]["pot"] != 0:
        die(f"領出應該把獎池歸零，得到 {(ok, err)} pot={t['g']['pot']}")
    ok, err = room.ma_spin(t, 0, {"bets": server_bets})
    if not ok or err is not None:
        die(f"領出後應該可以再付費開獎，得到 {(ok, err)}")
    print("ok: 改過的押注重送 4 次都不動燈；改送伺服器押注後 3 燈走完；獎池沒領之前付費開獎被拒，領出後可以再開")


if __name__ == "__main__":
    main()
