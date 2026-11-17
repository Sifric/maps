#!/usr/bin/env python3
"""Build a small-region A* graph from a Geofabrik Sri Lanka OSM PBF.

Requires: pip install osmium
Usage: python scripts/build-astar-graph.py sri-lanka.osm.pbf --bbox 81.65,7.65,81.77,7.77 --output graph.json
Upload output as R2 object routing/sri-lanka-astar-v1.json only for a
separate experimental Worker. Whole-country graph needs sharding.
"""
import argparse
import json
import math
import osmium

ROAD_CAR = {"motorway","trunk","primary","secondary","tertiary","unclassified","residential","living_street","service",
            "motorway_link","trunk_link","primary_link","secondary_link","tertiary_link"}
ROAD_WALK = ROAD_CAR | {"pedestrian","footway","path","steps","track","cycleway"}
def haversine(a,b):
    r=math.pi/180
    x=math.sin((b[1]-a[1])*r/2)**2+math.cos(a[1]*r)*math.cos(b[1]*r)*math.sin((b[0]-a[0])*r/2)**2
    return 12742000*math.asin(min(1,math.sqrt(x)))
class Roads(osmium.SimpleHandler):
    def __init__(self,bbox):
        super().__init__();self.bbox=bbox;self.nodes=[];self.index={};self.edges=[]
    def node_id(self,node):
        k=int(node.ref)
        if k not in self.index:
            self.index[k]=len(self.nodes)
            self.nodes.append([round(node.lon,7),round(node.lat,7)])
        return self.index[k]
    def way(self,w):
        tags=w.tags;highway=tags.get("highway")
        if highway not in ROAD_WALK or len(w.nodes)<2:return
        if tags.get("access") in ("no","private"):return
        car=int(highway in ROAD_CAR and tags.get("motor_vehicle") not in ("no","private") and tags.get("motorcar") not in ("no","private"))
        moto=int(highway in ROAD_CAR and tags.get("motor_vehicle") not in ("no","private") and tags.get("motorcycle") not in ("no","private"))
        walk=int(highway in ROAD_WALK and tags.get("foot") not in ("no","private") and highway not in ("motorway","motorway_link"))
        mask=car|(moto<<1)|(walk<<2)
        if not mask:return
        oneway=tags.get("oneway") in ("yes","true","1") or tags.get("junction")=="roundabout"
        reverse=tags.get("oneway")=="-1"
        pts=[]
        for n in w.nodes:
            if not n.location.valid():return
            lon,lat=n.lon,n.lat
            if not(self.bbox[0]<=lon<=self.bbox[2] and self.bbox[1]<=lat<=self.bbox[3]):return
            pts.append(n)
        for a,b in zip(pts,pts[1:]):
            ai,bi=self.node_id(a),self.node_id(b)
            if reverse:ai,bi=bi,ai
            self.edges.append([ai,bi,round(haversine(self.nodes[ai],self.nodes[bi]),2),mask,int(oneway or reverse)])
def main():
    p=argparse.ArgumentParser();p.add_argument("pbf");p.add_argument("--bbox",required=True);p.add_argument("--output",default="graph.json")
    args=p.parse_args();bbox=list(map(float,args.bbox.split(",")))
    if len(bbox)!=4 or not(bbox[0]<bbox[2] and bbox[1]<bbox[3]):p.error("invalid bbox")
    roads=Roads(bbox);roads.apply_file(args.pbf,locations=True)
    with open(args.output,"w") as f:json.dump({"version":1,"bbox":bbox,"nodes":roads.nodes,"edges":roads.edges},f,separators=(",",":"))
    print(f"Nodes: {len(roads.nodes)} Edges: {len(roads.edges)}")
    print("WARNING: bounding-box-clipped ways and OSM turn restrictions are not handled. Experimental graph only.")
if __name__=="__main__":main()
