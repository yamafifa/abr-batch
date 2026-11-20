# Node.js の CPU プロファイル（.cpuprofile）を集計する。使い方: python3 -I analyze-cpuprofile.py ファイル.cpuprofile
# パッケージ別・関数別の「自分の時間」と、呼び出し先を含む時間を表示する
import json,sys,collections,re
p=json.load(open(sys.argv[1]))
nodes={n["id"]:n for n in p["nodes"]}
dt=collections.Counter()
for sid,d in zip(p["samples"],p["timeDeltas"]): dt[sid]+=d
parent={}
for n in p["nodes"]:
  for c in n.get("children",[]): parent[c]=n["id"]
tot=sum(dt.values())/1e6
def lab(n):
  cf=n["callFrame"]; u=cf["url"]
  u=re.sub(r'.*node_modules/','',u).replace('file://','')
  return f'{cf["functionName"] or "(anon)"} {u}:{cf["lineNumber"]+1}'
def pkg(n):
  u=n["callFrame"]["url"]
  m=re.search(r'node_modules/((@[^/]+/)?[^/]+)',u)
  if m: return m.group(1)
  if u.startswith("node:") : return "node内部"
  if not u: return n["callFrame"]["functionName"] or "(native)"
  return "自作コード" if "/src/" in u else u
self_f=collections.Counter(); self_p=collections.Counter(); incl=collections.Counter()
for nid,d in dt.items():
  n=nodes[nid]; self_f[lab(n)]+=d; self_p[pkg(n)]+=d
  seen=set(); x=nid
  while x is not None:
    l=lab(nodes[x])
    if l not in seen: incl[l]+=d; seen.add(l)
    x=parent.get(x)
print(f"合計 {tot:.2f} 秒")
print("== パッケージ別（自分の時間）")
for k,v in self_p.most_common(12): print(f"{v/1e6:7.2f} 秒 {100*v/1e6/tot:5.1f}%  {k}")
print("== 関数別（自分の時間）")
for k,v in self_f.most_common(25): print(f"{v/1e6:7.2f} 秒 {100*v/1e6/tot:5.1f}%  {k}")
print("== 関数別（呼び出し先を含む時間）")
for k,v in incl.most_common(60): print(f"{v/1e6:7.2f} 秒 {100*v/1e6/tot:5.1f}%  {k}")
