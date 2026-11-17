// Experimental bounded A* router. Graph is a versioned R2 JSON object generated
// from OSM. Never fall back to a straight-line route when graph coverage is absent.
const GRAPH_KEY = "routing/sri-lanka-astar-v1.json";
const MAX_EXPANSIONS = 100000;
const MAX_NODES = 180000;
const RAD = Math.PI / 180;
function meters(a,b) {
  const dlat=(b[1]-a[1])*RAD,dlon=(b[0]-a[0])*RAD;
  const x=Math.sin(dlat/2)**2+Math.cos(a[1]*RAD)*Math.cos(b[1]*RAD)*Math.sin(dlon/2)**2;
  return 12742000*Math.asin(Math.min(1,Math.sqrt(x)));
}
class Heap {
  constructor(){this.a=[];}
  push(x){let a=this.a,i=a.length;a.push(x);while(i){let p=(i-1)>>1;if(a[p][0]<=x[0])break;a[i]=a[p];i=p;}a[i]=x;}
  pop(){let a=this.a,r=a[0],x=a.pop();if(a.length){let i=0;while(true){let l=i*2+1;if(l>=a.length)break;let j=l+1<a.length&&a[l+1][0]<a[l][0]?l+1:l;if(a[j][0]>=x[0])break;a[i]=a[j];i=j;}a[i]=x;}return r;}
  get length(){return this.a.length;}
}
function nearest(nodes, point, allowed) {
  let best=-1,dist=Infinity;
  for(let i=0;i<nodes.length;i++){
    if(!allowed.has(i))continue;
    const d=meters(nodes[i],point);
    if(d<dist){dist=d;best=i;}
  }
  return {id:best,distance:dist};
}
function calculate(graph,from,to,mode) {
  if(!Array.isArray(graph.nodes)||!Array.isArray(graph.edges)||graph.nodes.length>MAX_NODES)
    throw new Error("Routing graph is missing or too large for this Worker");
  const nodes=graph.nodes,edges=graph.edges;
  const adjacency=new Map(),eligible=new Set();
  for(const e of edges) {
    // Edge: [fromIndex,toIndex,distanceMeters,modeMask,oneway]
    if(!Array.isArray(e)||e.length<5)continue;
    const [a,b,d,mask,oneway]=e;
    const flag=mode==="walk"?4:mode==="twoWheeler"?2:1;
    if(!(mask&flag)||a<0||b<0||a>=nodes.length||b>=nodes.length||!Number.isFinite(d)||d<=0)continue;
    if(!adjacency.has(a))adjacency.set(a,[]);
    adjacency.get(a).push([b,d]);
    eligible.add(a);eligible.add(b);
    if(!oneway){if(!adjacency.has(b))adjacency.set(b,[]);adjacency.get(b).push([a,d]);}
  }
  const s=nearest(nodes,from,eligible),t=nearest(nodes,to,eligible);
  if(s.id<0||t.id<0||s.distance>1500||t.distance>1500)
    return {error:"No mapped road within 1.5 km of the requested coordinates",status:422};
  const distance=new Float64Array(nodes.length).fill(Infinity),previous=new Int32Array(nodes.length).fill(-1);
  const heap=new Heap();distance[s.id]=0;heap.push([meters(nodes[s.id],nodes[t.id]),s.id]);
  let expansions=0;
  while(heap.length&&expansions++<MAX_EXPANSIONS){
    const [f,u]=heap.pop();
    if(f>distance[u]+meters(nodes[u],nodes[t.id])+0.001)continue;
    if(u===t.id)break;
    for(const [v,w] of adjacency.get(u)||[]){
      const next=distance[u]+w;
      if(next<distance[v]){distance[v]=next;previous[v]=u;heap.push([next+meters(nodes[v],nodes[t.id]),v]);}
    }
  }
  if(!Number.isFinite(distance[t.id]))return {error:"No connected route found in available road graph",status:422};
  const path=[];let cur=t.id;
  for(let i=0;i<=nodes.length&&cur>=0;i++){path.push(nodes[cur]);if(cur===s.id)break;cur=previous[cur];}
  if(cur!==s.id)return {error:"Unable to reconstruct route",status:500};
  path.reverse();
  const speed=mode==="walk"?1.3:mode==="twoWheeler"?8.3:11.1;
  return {geometry:{type:"LineString",coordinates:path},distance:distance[t.id],duration:distance[t.id]/speed,
    steps:[{text:"Follow the highlighted route",distance:distance[t.id]}],
    engine:"sifric-astar",warning:"Estimated duration; no live traffic or turn-by-turn instructions"};
}
export async function routeAStar(body,env){
  const valid=p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)&&p[0]>=78&&p[0]<=82.5&&p[1]>=5&&p[1]<=10.5;
  if(!["drive","twoWheeler","walk"].includes(body?.mode)||!valid(body.origin)||!valid(body.destination))
    return {error:"Invalid routing mode or Sri Lanka coordinates",status:400};
  const obj=await env.TILES_BUCKET.get(GRAPH_KEY);
  if(!obj)return {error:"A* routing graph not published to R2 yet",status:503};
  if(obj.size>18*1024*1024)return {error:"Graph exceeds experimental Worker load budget; sharding required",status:503};
  const graph=await obj.json();
  return calculate(graph,body.origin,body.destination,body.mode);
}
