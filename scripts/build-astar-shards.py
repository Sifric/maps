#!/usr/bin/env python3
"""Generate a whole-country directed OSM road graph in R2-friendly spatial shards.

pip install osmium
python scripts/build-astar-shards.py sri-lanka.osm.pbf --out build/astar
Every road segment is indexed by its *source* node tile; reverse edges have
their own source. Node identifiers remain global OSM IDs across tile boundaries.
"""
import argparse,collections,json,math,pathlib,osmium
RAD=math.pi/180
CAR={"motorway","trunk","primary","secondary","tertiary","unclassified","residential","living_street","service","motorway_link","trunk_link","primary_link","secondary_link","tertiary_link"}
WALK=CAR|{"pedestrian","footway","path","steps","track","cycleway","bridleway"}
def distance(a,b):
    x=math.sin((b[1]-a[1])*RAD/2)**2+math.cos(a[1]*RAD)*math.cos(b[1]*RAD)*math.sin((b[0]-a[0])*RAD/2)**2
    return round(12742000*math.asin(min(1,math.sqrt(x))),2)
def tile(p,scale=10):
    return f"{math.floor(p[1]*scale)}_{math.floor(p[0]*scale)}"
class Extract(osmium.SimpleHandler):
    def __init__(self):
        super().__init__();self.shards=collections.defaultdict(lambda:{"nodes":{},"edges":[]});self.segments=0
    def way(self,w):
        t=w.tags;h=t.get("highway")
        if h not in WALK or t.get("access") in ("private","no"):return
        motor=t.get("motor_vehicle") not in ("private","no")
        mask=(int(h in CAR and motor and t.get("motorcar") not in ("private","no"))|
              (int(h in CAR and motor and t.get("motorcycle") not in ("private","no"))<<1)|
              (int(h in WALK and t.get("foot") not in ("private","no") and h not in ("motorway","motorway_link"))<<2))
        if not mask:return
        forward=t.get("oneway") in ("yes","1","true") or t.get("junction")=="roundabout"
        reverse=t.get("oneway")=="-1"
        points=[]
        for n in w.nodes:
            if not n.location.valid():return
            points.append((str(n.ref),[round(n.lon,7),round(n.lat,7)]))
        for (aid,a),(bid,b) in zip(points,points[1:]):
            if a==b:continue
            d=distance(a,b)
            if not d:continue
            # Walking is bidirectional unless explicitly restricted by foot:forward/backward.
            fw=mask if not reverse else mask&4
            bw=mask if not forward else mask&4
            if reverse:fw=mask&4;bw=mask
            if t.get("foot:forward")=="no":fw &= ~4
            if t.get("foot:backward")=="no":bw &= ~4
            for source,coord,target,targetcoord,allowed in ((aid,a,bid,b,fw),(bid,b,aid,a,bw)):
                if not allowed:continue
                sh=self.shards[tile(coord)]
                sh["nodes"][source]=coord
                sh["edges"].append([source,target,d,allowed])
                self.shards[tile(targetcoord)]["nodes"][target]=targetcoord
                self.segments+=1
def main():
    ap=argparse.ArgumentParser();ap.add_argument("pbf");ap.add_argument("--out",default="build/astar")
    args=ap.parse_args();out=pathlib.Path(args.out);out.mkdir(parents=True,exist_ok=True)
    e=Extract();e.apply_file(args.pbf,locations=True)
    manifest={"version":2,"tileScale":10,"shards":[],"nodes":0,"edges":e.segments,"limitations":["OSM turn restrictions not yet modeled","No elevation or live traffic","OSM conditional access not evaluated"]}
    for name,sh in sorted(e.shards.items()):
        data={"version":2,"nodes":sh["nodes"],"edges":sh["edges"]}
        path=out/f"{name}.json";path.write_text(json.dumps(data,separators=(",",":")))
        manifest["shards"].append({"id":name,"bytes":path.stat().st_size,"nodes":len(sh["nodes"]),"edges":len(sh["edges"])})
        manifest["nodes"]+=len(sh["nodes"])
    (out/"manifest.json").write_text(json.dumps(manifest,separators=(",",":")))
    print(json.dumps({"shards":len(manifest["shards"]),"nodeRecords":manifest["nodes"],"directedEdges":e.segments}))
if __name__=="__main__":main()
