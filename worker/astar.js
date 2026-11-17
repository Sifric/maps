// Sifric experimental A* over directed OSM edges in spatial R2 shards.
// Does not claim turn restrictions, real-time traffic or guaranteed free-tier CPU.
const PREFIX="routing/astar-v2/";
const R=Math.PI/180;
const dist=(a,b)=>{const x=Math.sin((b[1]-a[1])*R/2)**2+Math.cos(a[1]*R)*Math.cos(b[1]*R)*Math.sin((b[0]-a[0])*R/2)**2;return 12742000*Math.asin(Math.min(1,Math.sqrt(x)));};
const tile=p=>Math.floor(p[1]*10)+"_"+Math.floor(p[0]*10);
class Heap{
 constructor(){this.a=[];}
 push(v){const a=this.a;let i=a.length;a.push(v);while(i){const p=(i-1)>>1;if(a[p][0]<=v[0])break;a[i]=a[p];i=p;}a[i]=v;}
 pop(){const a=this.a,r=a[0],v=a.pop();if(a.length){let i=0;for(;;){const l=i*2+1;if(l>=a.length)break;const j=l+1<a.length&&a[l+1][0]<a[l][0]?l+1:l;if(a[j][0]>=v[0])break;a[i]=a[j];i=j;}a[i]=v;}return r;}
 get length(){return this.a.length;}
}
function nearby(point){const lat=Math.floor(point[1]*10),lon=Math.floor(point[0]*10),ids=[];for(let y=-1;y<=1;y++)for(let x=-1;x<=1;x++)ids.push((lat+y)+"_"+(lon+x));return ids;}
export async function routeAStar(body,env){
 const valid=p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)&&p[0]>=78&&p[0]<=82.5&&p[1]>=5&&p[1]<=10.5;
 if(!["drive","twoWheeler","walk"].includes(body?.mode)||!valid(body.origin)||!valid(body.destination))
  return {status:400,error:"Invalid mode or coordinates"};
 const manifest=await env.TILES_BUCKET.get(PREFIX+"manifest.json");
 if(!manifest)return {status:503,error:"A* routing dataset not deployed"};
 const meta=await manifest.json();if(meta.version!==2)return {status:503,error:"Incompatible routing graph version"};
 const available=new Set(meta.shards.map(s=>s.id));
 const cache=new Map(),positions=new Map(),adj=new Map(),MAX_SHARDS=32,MAX_EXPANSIONS=20000;
 async function load(id){
  if(cache.has(id))return cache.get(id);
  if(!available.has(id))return null;
  if(cache.size>=MAX_SHARDS)throw new Error("Routing exceeds per-request shard budget");
  const obj=await env.TILES_BUCKET.get(PREFIX+id+".json");
  if(!obj)throw new Error("Routing shard missing");
  if(obj.size>4*1024*1024)throw new Error("Routing shard exceeds 4 MiB");
  const data=await obj.json();cache.set(id,data);
  for(const [k,p] of Object.entries(data.nodes))positions.set(k,p);
  for(const [from,to,d,mask] of data.edges){
   if(!adj.has(from))adj.set(from,[]);
   adj.get(from).push([to,d,mask]);
  }
  return data;
 }
 async function snap(point){
  await Promise.all(nearby(point).filter(x=>available.has(x)).map(load));
  let id=null,best=Infinity;
  for(const [k,p] of positions){const d=dist(point,p);if(d<best){id=k;best=d;}}
  return {id,distance:best};
 }
 try{
  const source=await snap(body.origin),target=await snap(body.destination);
  if(!source.id||!target.id||source.distance>1500||target.distance>1500)return {status:422,error:"No nearby mapped road"};
  const goal=positions.get(target.id),g=new Map([[source.id,0]]),previous=new Map(),heap=new Heap();
  heap.push([dist(positions.get(source.id),goal),source.id]);
  const mask=body.mode==="walk"?4:body.mode==="twoWheeler"?2:1;
  let count=0,found=false;
  while(heap.length&&count++<MAX_EXPANSIONS){
   const [f,u]=heap.pop(),pos=positions.get(u),cost=g.get(u);
   if(!pos||f>cost+dist(pos,goal)+0.01)continue;
   if(u===target.id){found=true;break;}
   await load(tile(pos));
   for(const [v,d,flags] of adj.get(u)||[]){
    if(!(flags&mask))continue;
    const next=cost+d;
    if(next<(g.get(v)??Infinity)){
     const vp=positions.get(v);if(!vp)continue;
     g.set(v,next);previous.set(v,u);heap.push([next+dist(vp,goal),v]);
    }
   }
  }
  if(!found)return {status:422,error:"No route found within free-tier search budget",explored:count};
  const path=[];let u=target.id;
  for(let i=0;i<=count;i++){path.push(positions.get(u));if(u===source.id)break;u=previous.get(u);if(!u)break;}
  if(u!==source.id)return {status:500,error:"Route reconstruction failed"};
  path.reverse();
  const length=g.get(target.id),speed=body.mode==="walk"?1.3:body.mode==="twoWheeler"?8.3:11.1;
  return {geometry:{type:"LineString",coordinates:path},distance:length,duration:length/speed,
   steps:[{text:"Follow the highlighted route",distance:length}],engine:"sifric-astar",
   warning:"Estimated duration. Turn restrictions and turn-by-turn directions are not yet supported."};
 }catch(e){return {status:503,error:"A* routing capacity or graph error",detail:String(e.message||e)};}
}
