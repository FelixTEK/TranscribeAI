import json, re, sys, glob, os
def norm(s): return re.sub(r"[\s\W_]+", "", s.lower(), flags=re.U)
def lev(a, b):
    if not a: return len(b), 0, len(b)
    prev = list(range(len(b)+1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j]+1, cur[j-1]+1, prev[j-1]+(ca != cb)))
        prev = cur
    return prev[-1]
def cer_dir(d, refs):
    err = tot = ins = 0; per = {}
    for name, ref in refs.items():
        p = os.path.join(d, name + ".wav.json")
        hyp = ""
        if os.path.exists(p):
            raw = open(p, "rb").read().decode("latin1")  # structure is ASCII; text bytes may be split mid-char
            segs = json.loads(raw)["transcription"]
            hyp = b"".join(s["text"].encode("latin1") for s in segs).decode("utf-8", "replace")
        r, h = norm(ref), norm(hyp)
        e = lev(r, h); err += e; tot += len(r); per[name] = (e, len(r), hyp)
        ins += max(0, len(h) - len(r))
    return err / tot, per
if __name__ == "__main__":
    refs = json.load(open("refs.json", encoding="utf-8"))
    for d in sys.argv[1:]:
        c, per = cer_dir(d, refs)
        print(f"{d}: CER {c*100:.2f}%  (chars {sum(v[1] for v in per.values())})")
