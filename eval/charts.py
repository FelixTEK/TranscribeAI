"""Make the slide charts (PNG, 16:9-friendly) from the structured result files in eval/.
usage (repo root):  data/eval/venv/Scripts/python.exe eval/charts.py
Reads eval/chart-data.json, verify-data.json, search-data.json, summary-data.json (whichever exist) and writes eval/charts/*.png.
Charts whose data file is missing are skipped.
"""
import json
import os
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager

FONT = "C:/Windows/Fonts/THSarabunNew.ttf"
FONT_BOLD = "C:/Windows/Fonts/THSarabunNew Bold.ttf"
for f in (FONT, FONT_BOLD):
    if os.path.exists(f):
        font_manager.fontManager.addfont(f)
plt.rcParams.update({
    "font.family": "TH Sarabun New", "font.size": 22, "axes.titlesize": 28, "axes.labelsize": 22,
    "axes.spines.top": False, "axes.spines.right": False, "axes.unicode_minus": False,
    "figure.figsize": (13.33, 7.5), "figure.dpi": 150, "savefig.bbox": "tight", "savefig.facecolor": "white",
})

# colour-blind-safe palette; the chosen configuration (C3) always gets the strong colour
C_MAIN, C_OTHER, C_BASE = "#0072B2", "#9AA5B1", "#D55E00"
C_S, C_D, C_I = "#E69F00", "#56B4E9", "#CC79A7"

OUT = "eval/charts"
os.makedirs(OUT, exist_ok=True)


def load(name):
    p = os.path.join("eval", name)
    return json.load(open(p, encoding="utf-8")) if os.path.exists(p) else None


def save(fig, name):
    fig.savefig(os.path.join(OUT, name))
    plt.close(fig)
    print("wrote", os.path.join(OUT, name))


LABELS = {
    "C1": "C1\nถอดทั้งไฟล์\n(baseline)", "C2": "C2\n+ ตัวกรอง VAD", "C3": "C3\nตัดท่อนเอง\n(ที่เลือก)",
    "C3k": "C3k\nส่งช่วงเงียบ\nด้วย", "C4": "C4\nturbo", "C5": "C5\nturbo + VAD",
}
FILES = {"L1": "L1 (19 นาที มีกับดัก)", "L2": "L2 (16 นาที พูดต่อเนื่อง)", "LD": "LD (dev 10 นาที)", "LT": "LT (test 10 นาที)"}

data = load("chart-data.json")
if data:
    # 1) CER per configuration, one chart per long file that has the full set
    for label in ("L1", "L2"):
        rows = data.get(label, {})
        ids = [i for i in LABELS if i in rows]
        if not ids:
            continue
        fig, ax = plt.subplots()
        vals = [rows[i]["cerNum"] * 100 for i in ids]
        colors = [C_MAIN if i == "C3" else C_BASE if i == "C1" else C_OTHER for i in ids]
        bars = ax.bar([LABELS[i] for i in ids], vals, color=colors)
        for b, v in zip(bars, vals):
            ax.text(b.get_x() + b.get_width() / 2, v + 0.6, f"{v:.1f}%", ha="center", fontsize=24)
        ax.set_ylabel("CER (ยิ่งต่ำยิ่งดี) %")
        ax.set_title(f"อัตราผิดระดับตัวอักษรบนไฟล์ {FILES[label]}")
        ax.set_ylim(0, max(vals) * 1.15)
        save(fig, f"cer_{label}.png")

    # 2) S / D / I stacked (L1): shows C2 breaking on deletions and C3k on insertions
    rows = data.get("L1", {})
    ids = [i for i in LABELS if i in rows]
    if ids:
        fig, ax = plt.subplots()
        bottom = [0] * len(ids)
        for key, name, col in (("S", "ถอดผิด (S)", C_S), ("D", "ตกหล่น (D)", C_D), ("I", "เกินมา/แต่งเพิ่ม (I)", C_I)):
            v = [rows[i][key] for i in ids]
            ax.bar([LABELS[i] for i in ids], v, bottom=bottom, label=name, color=col)
            bottom = [b + x for b, x in zip(bottom, v)]
        ax.set_ylabel("จำนวนตัวอักษรที่ผิด (เฉลย 9,490 ตัว)")
        ax.set_title("ชนิดข้อผิดพลาดบนไฟล์ L1")
        ax.legend(frameon=False, fontsize=20)
        save(fig, "sdi_L1.png")

    # 3) CER vs time trade-off (L1)
    if ids:
        fig, ax = plt.subplots()
        for i in ids:
            col = C_MAIN if i == "C3" else C_BASE if i == "C1" else C_OTHER
            ax.scatter(rows[i]["seconds"], rows[i]["cerNum"] * 100, s=260, color=col, zorder=3)
            ax.annotate(i, (rows[i]["seconds"], rows[i]["cerNum"] * 100), textcoords="offset points", xytext=(12, 8), fontsize=24)
        ax.set_xlabel("เวลาถอดเสียงไฟล์ 19 นาที (วินาที) ยิ่งซ้ายยิ่งเร็ว")
        ax.set_ylabel("CER % (ยิ่งต่ำยิ่งแม่น)")
        ax.set_title("ความแม่นกับความเร็ว (L1)")
        ax.grid(alpha=0.3)
        save(fig, "cer_vs_time_L1.png")

    # 4) held-out test file: baseline vs chosen vs turbo
    rows = data.get("LT", {})
    ids = [i for i in ("C1", "C3", "C4") if i in rows]
    if len(ids) >= 2:
        fig, ax = plt.subplots()
        vals = [rows[i]["cerNum"] * 100 for i in ids]
        colors = [C_MAIN if i == "C3" else C_BASE if i == "C1" else C_OTHER for i in ids]
        bars = ax.bar([LABELS[i] for i in ids], vals, color=colors)
        for b, v in zip(bars, vals):
            ax.text(b.get_x() + b.get_width() / 2, v + 0.6, f"{v:.1f}%", ha="center", fontsize=24)
        ax.set_ylabel("CER % (ยิ่งต่ำยิ่งดี)")
        ax.set_title("ชุดทดสอบ LT (ไม่ได้ใช้ปรับค่า)")
        ax.set_ylim(0, max(vals) * 1.15)
        save(fig, "cer_LT.png")

verify = load("verify-data.json")
if verify:
    rows = verify["rows"]
    fig, ax = plt.subplots()
    th = [r["threshold"] for r in rows]
    for key, name, col in (("precision", "Precision", C_S), ("recall", "Recall", C_D), ("f1", "F1", C_MAIN)):
        ax.plot(th, [r[key] for r in rows], marker="o", linewidth=3, markersize=9, label=name, color=col)
    ax.axvline(verify["default"], color="#555555", linestyle="--", linewidth=1.5)
    ax.text(verify["default"] + 0.005, 0.52, "ค่าที่โปรแกรมใช้ 0.85", fontsize=20, color="#333333")
    ax.set_xlabel("เกณฑ์ (สัดส่วนชิ้นส่วนคำอ้างอิงที่ต้องพบในบทถอดเสียง)")
    ax.set_ylabel("คะแนน")
    ax.set_title("ตัวตรวจคำอ้างอิงปลอม: Precision / Recall / F1")
    ax.set_ylim(0.4, 1.05)
    ax.grid(alpha=0.3)
    ax.legend(frameon=False, fontsize=22, loc="lower left")
    save(fig, "verify_prf.png")

search = load("search-data.json")
if search and search.get("beam"):
    rows = search["beam"]
    fig, ax = plt.subplots()
    names = [f"beam {r['beam']}" + (" (greedy)" if r["beam"] == 1 else " (ค่าเริ่มต้น)" if r["beam"] == 5 else "") for r in rows]
    vals = [r["cer"] * 100 for r in rows]
    bars = ax.bar(names, vals, color=[C_BASE if r["beam"] == 1 else C_MAIN if r["beam"] == 5 else C_OTHER for r in rows])
    for b, v, r in zip(bars, vals, rows):
        ax.text(b.get_x() + b.get_width() / 2, v + 0.3, f"{v:.1f}%\n{r['seconds']:.0f} วินาที", ha="center", fontsize=22)
    ax.set_ylabel("CER % บนชุดทดสอบ LT")
    ax.set_title("Greedy เทียบ Beam search")
    ax.set_ylim(0, max(vals) * 1.3)
    save(fig, "beam.png")
if search and search.get("hill"):
    hill = search["hill"]
    pts = hill["tried"]
    fig, ax = plt.subplots()
    sc = ax.scatter([p["max"] for p in pts], [p["drop"] for p in pts], c=[p["cer"] * 100 for p in pts], cmap="viridis_r", s=900, zorder=3)
    for p in pts:
        ax.text(p["max"], p["drop"], f"{p['cer'] * 100:.1f}", ha="center", va="center", color="white", fontsize=17, zorder=4)
    path = hill["path"]
    ax.plot([p["max"] for p in path], [p["drop"] for p in path], color="#D55E00", linewidth=4, zorder=2)
    ax.scatter([path[0]["max"]], [path[0]["drop"]], s=1700, facecolors="none", edgecolors="#D55E00", linewidths=4, zorder=5)
    ax.set_xlabel("ความยาวท่อนสูงสุด (วินาที)")
    ax.set_ylabel("เกณฑ์ทิ้งช่วงเงียบ (วินาที)")
    ax.set_title(f"Hill-Climbing บน LD: ประเมิน {len(pts)} จุด จากตาราง {hill['grid']} จุด (เส้นส้ม = เส้นทาง)")
    fig.colorbar(sc, label="CER %")
    save(fig, "hill_climbing.png")

summary = load("summary-data.json")
if summary:
    fig, ax = plt.subplots()
    metrics = ("precision", "recall", "f1")
    names = ("Precision", "Recall", "F1")
    w = 0.36
    xs = range(3)
    ax.bar([x - w / 2 for x in xs], [summary["llm"][m] for m in metrics], w, label="LLM (Typhoon 2.5 4B)", color=C_MAIN)
    ax.bar([x + w / 2 for x in xs], [summary["baseline"][m] for m in metrics], w, label="baseline: บรรทัดแรกของบทถอดเสียง", color=C_OTHER)
    for x in xs:
        ax.text(x - w / 2, summary["llm"][metrics[x]] + 0.02, f"{summary['llm'][metrics[x]]:.2f}", ha="center", fontsize=22)
        ax.text(x + w / 2, summary["baseline"][metrics[x]] + 0.02, f"{summary['baseline'][metrics[x]]:.2f}", ha="center", fontsize=22)
    ax.set_xticks(list(xs), names)
    ax.set_ylim(0, 1.15)
    ax.set_title(f"คุณภาพของสรุป เทียบเฉลยข้อเท็จจริง {summary['facts']} ข้อ (3 ไฟล์)")
    ax.legend(frameon=False, fontsize=20, loc="upper right")
    save(fig, "summary_prf.png")

if not os.listdir(OUT):
    sys.exit("no charts written (no data files found)")
