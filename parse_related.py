import json, os, re, datetime, sys

D = r"C:\Users\blueb\AppData\Local\Temp\dsh-spill-xr7Iid\session-6965a7a1885d"
SEEDS = ["BV1henu6YETi","BV1Uoe46mErV","BV1Mb421J7W8","BV11u411f7fD",
         "BV15xZPYRE4R","BV1kUYM67EGD","BV1Negj6nEt1","BV1XP411L7Tc"]

KW = ["食","吃","餐","饮","营养","热量","添加剂","配料表","保质期","防腐","烹饪","菜","肉","奶","蛋","糖","油","盐","酱","醋","酒","茶","咖啡","零食","外卖","预制菜","发酵","菌","蛋白","脂肪","碳水","维生素","代糖","致癌","农残","激素","辐照","食品安全","美食","厨","风味","食谱","减肥","血糖","胆固醇"]

# map seed -> file
files = {}
for name in os.listdir(D):
    p = os.path.join(D, name)
    if not name.endswith(".txt"): continue
    raw = open(p, encoding="utf-8").read()
    m = re.search(r"bvid=(BV[0-9A-Za-z]+)", raw)
    if not m: continue
    files[m.group(1)] = (p, raw)

def parse(raw):
    i = raw.find("{")
    return json.loads(raw[i:])

def fmt_dur(sec):
    if sec is None: return "-"
    try: sec = int(sec)
    except: return "-"
    return "%d:%02d" % (sec//60, sec % 60)

TZ = datetime.timezone(datetime.timedelta(hours=8))
def fmt_date(ts):
    if ts in (None, 0, ""): return "-"
    try: ts = int(ts)
    except: return "-"
    return datetime.datetime.fromtimestamp(ts, TZ).strftime("%Y-%m-%d")

rows = []
seen = set()
report = []
for seed in SEEDS:
    if seed not in files:
        report.append((seed, "NO FILE", 0, 0))
        continue
    p, raw = files[seed]
    j = parse(raw)
    data = j.get("data") or []
    if isinstance(data, dict):  # detail endpoint shape
        data = data.get("Related") or []
    cands = []
    for it in data:
        bvid = it.get("bvid") or it.get("bvid") or ""
        if not bvid: continue
        if bvid == seed: continue
        title = (it.get("title") or "").strip()
        desc = it.get("desc") or ""
        if desc in ("-",): desc = ""
        hit = [k for k in KW if k in title or k in desc]
        if not hit: continue
        view = (it.get("stat") or {}).get("view")
        try: view = int(view)
        except: view = 0
        cands.append({
            "bvid": bvid, "title": title,
            "up": (it.get("owner") or {}).get("name") or "-",
            "view": view, "dur": it.get("duration"), "pub": it.get("pubdate"),
            "hit": hit,
        })
    cands.sort(key=lambda x: -x["view"])
    kept = 0
    for c in cands:
        if kept >= 12: break
        if c["bvid"] in seen: continue
        seen.add(c["bvid"])
        rows.append((seed, c))
        kept += 1
    report.append((seed, os.path.basename(p), len(data), len(cands), kept))

for r in report:
    print("SEEDCHK", r, file=sys.stderr)

out = ["种子BVID|相关BVID|标题|UP主|播放|时长|发布日|命中词"]
for seed, c in rows:
    t = c["title"].replace("|", "｜").replace("\n", " ").strip()
    up = c["up"].replace("|", "｜").strip()
    hit = "、".join(c["hit"])
    out.append("|".join([seed, c["bvid"], t, up, str(c["view"]), fmt_dur(c["dur"]), fmt_date(c["pub"]), hit]))
with open(r"C:\Users\blueb\Documents\deepseek-harness\default-workspace\related_table.txt", "w", encoding="utf-8", newline="\n") as f:
    f.write("\n".join(out) + "\n")
print("ROWS", len(rows), file=sys.stderr)