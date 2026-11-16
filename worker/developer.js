const enc = new TextEncoder();
const json = (v,s=200,h={}) => new Response(JSON.stringify(v),{status:s,headers:{"Content-Type":"application/json","Cache-Control":"no-store","X-Content-Type-Options":"nosniff",...h}});
const cookie = r => (r.headers.get("Cookie")||"").split(";").map(x=>x.trim()).find(x=>x.startsWith("sifric_session="))?.split("=")[1];
const bytes = n => crypto.getRandomValues(new Uint8Array(n));
const hex = b => [...b].map(x=>x.toString(16).padStart(2,"0")).join("");
const random = n => hex(bytes(n));
const digest = async x => hex(new Uint8Array(await crypto.subtle.digest("SHA-256",enc.encode(x))));
const hashPassword = async (password,salt) => {
 const key=await crypto.subtle.importKey("raw",enc.encode(password),"PBKDF2",false,["deriveBits"]);
 return hex(new Uint8Array(await crypto.subtle.deriveBits({name:"PBKDF2",salt:enc.encode(salt),iterations:310000,hash:"SHA-256"},key,256)));
};
const equal = (a,b) => {if(typeof a!=="string"||typeof b!=="string"||a.length!==b.length)return false;let x=0;for(let i=0;i<a.length;i++)x|=a.charCodeAt(i)^b.charCodeAt(i);return x===0};
const secureCookie=(value,maxAge)=>`sifric_session=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
const originOK=r=>{const o=r.headers.get("Origin");return o===new URL(r.url).origin};
const parse=async r=>{if(Number(r.headers.get("Content-Length")||0)>8192)throw Error("Payload too large");const t=await r.text();if(t.length>8192)throw Error("Payload too large");return JSON.parse(t)};
async function session(r,db){const token=cookie(r);if(!token||!/^[a-f0-9]{64}$/.test(token))return null;return db.prepare("SELECT u.id,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?").bind(await digest(token),Date.now()).first()}
async function createSession(db,userId){const token=random(32);await db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)").bind(await digest(token),userId,Date.now()+604800000).run();return secureCookie(token,604800)}
async function oauthStart(r,env,provider){
 const config=oauthConfig(env,provider);if(!config)return json({error:"Provider not configured"},503);
 const state=random(32),verifier=random(32),redirect=new URL("/auth/callback/"+provider,r.url).href;
 const params=new URLSearchParams({client_id:config.id,redirect_uri:redirect,response_type:"code",scope:provider==="github"?"read:user user:email":"openid email profile",state});
 if(provider==="google"){const challenge=await crypto.subtle.digest("SHA-256",enc.encode(verifier));params.set("code_challenge",btoa(String.fromCharCode(...new Uint8Array(challenge))).replaceAll("+","-").replaceAll("/","_").replace(/=+$/,""));params.set("code_challenge_method","S256")}
 await env.DB.prepare("INSERT INTO oauth_states(state_hash,provider,verifier,expires_at) VALUES(?,?,?,?)").bind(await digest(state),provider,verifier,Date.now()+600000).run();
 return Response.redirect(config.authorize+"?"+params,302)
}
function oauthConfig(env,p){if(p==="github"&&env.GITHUB_CLIENT_ID&&env.GITHUB_CLIENT_SECRET)return{id:env.GITHUB_CLIENT_ID,secret:env.GITHUB_CLIENT_SECRET,authorize:"https://github.com/login/oauth/authorize",token:"https://github.com/login/oauth/access_token"};if(p==="google"&&env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET)return{id:env.GOOGLE_CLIENT_ID,secret:env.GOOGLE_CLIENT_SECRET,authorize:"https://accounts.google.com/o/oauth2/v2/auth",token:"https://oauth2.googleapis.com/token"};return null}
async function oauthCallback(r,env,provider){
 const u=new URL(r.url),state=u.searchParams.get("state"),code=u.searchParams.get("code");if(!state||!code)return json({error:"OAuth cancelled"},400);
 const row=await env.DB.prepare("DELETE FROM oauth_states WHERE state_hash=? RETURNING provider,verifier,expires_at").bind(await digest(state)).first();
 if(!row||row.provider!==provider||row.expires_at<Date.now())return json({error:"Invalid OAuth state"},400);
 const cfg=oauthConfig(env,provider);if(!cfg)return json({error:"Provider not configured"},503);
 const redirect=new URL("/auth/callback/"+provider,r.url).href;
 const params=new URLSearchParams({client_id:cfg.id,client_secret:cfg.secret,code,redirect_uri:redirect});
 if(provider==="google"){params.set("grant_type","authorization_code");params.set("code_verifier",row.verifier)}
 const t=await fetch(cfg.token,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","Accept":"application/json"},body:params});
 if(!t.ok)return json({error:"OAuth token exchange failed"},502);
 const tokens=await t.json();if(!tokens.access_token)return json({error:"OAuth token missing"},502);
 let subject,email,verified=false;
 if(provider==="github"){
  const h={Authorization:"Bearer "+tokens.access_token,Accept:"application/vnd.github+json","User-Agent":"Sifric-Maps"};
  const profile=await fetch("https://api.github.com/user",{headers:h});if(!profile.ok)return json({error:"GitHub profile unavailable"},502);
  subject=String((await profile.json()).id);
  const emails=await fetch("https://api.github.com/user/emails",{headers:h});
  if(emails.ok){const list=await emails.json();email=list.find(x=>x.primary&&x.verified)?.email||list.find(x=>x.verified)?.email;verified=!!email}
 }else{
  const profile=await fetch("https://openidconnect.googleapis.com/v1/userinfo",{headers:{Authorization:"Bearer "+tokens.access_token}});
  if(!profile.ok)return json({error:"Google profile unavailable"},502);
  const data=await profile.json();subject=data.sub;email=data.email;verified=data.email_verified===true;
 }
 if(!subject||!email||!verified)return json({error:"A verified email address is required"},403);
 email=email.toLowerCase();
 let identity=await env.DB.prepare("SELECT user_id FROM identities WHERE provider=? AND subject=?").bind(provider,subject).first();
 let userId=identity?.user_id;
 if(!userId){
  // Do not auto-link an existing password/OAuth account by email; that requires an authenticated linking flow.
  const existing=await env.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first();
  if(existing)return json({error:"An account already uses this email. Sign in using its original method."},409);
  userId=crypto.randomUUID();
  await env.DB.batch([
   env.DB.prepare("INSERT INTO users(id,email,created_at) VALUES(?,?,?)").bind(userId,email,Date.now()),
   env.DB.prepare("INSERT INTO identities(provider,subject,user_id) VALUES(?,?,?)").bind(provider,subject,userId)
  ]);
 }
 const token=await createSession(env.DB,userId);
 return new Response(null,{status:303,headers:{Location:"/dashboard","Set-Cookie":token,"Cache-Control":"no-store"}});
}
export async function handleDeveloper(request,env){
 const url=new URL(request.url),path=url.pathname,method=request.method;
 if(!env.DB)return json({error:"Developer database is not configured"},503);
 if(path==="/auth/google"||path==="/auth/github"){if(method!=="GET")return json({error:"Method not allowed"},405);return oauthStart(request,env,path.split("/")[2])}
 if(path.startsWith("/auth/callback/")){if(method!=="GET")return json({error:"Method not allowed"},405);const p=path.split("/")[3];if(!["google","github"].includes(p))return json({error:"Not found"},404);return oauthCallback(request,env,p)}
 if(method==="OPTIONS")return new Response(null,{status:204,headers:{Allow:"GET, POST, DELETE, OPTIONS"}});
 if(!["GET","POST","DELETE"].includes(method))return json({error:"Method not allowed"},405);
 if(method!=="GET"&&!originOK(request))return json({error:"Invalid origin"},403);
 const db=env.DB;
 if(path==="/api/developer/register"&&method==="POST"){
  const b=await parse(request);const email=String(b.email||"").trim().toLowerCase(),password=b.password;
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254||typeof password!=="string"||password.length<12||password.length>128)return json({error:"Valid email and password of 12–128 characters required"},400);
  const salt=random(16),hash=await hashPassword(password,salt),id=crypto.randomUUID();
  try{await db.prepare("INSERT INTO users(id,email,password_salt,password_hash,created_at) VALUES(?,?,?,?,?)").bind(id,email,salt,hash,Date.now()).run()}catch{return json({error:"Account already exists"},409)}
  return json({ok:true},201,{"Set-Cookie":await createSession(db,id)});
 }
 if(path==="/api/developer/login"&&method==="POST"){
  const b=await parse(request),email=String(b.email||"").trim().toLowerCase(),password=b.password;
  if(typeof password!=="string"||password.length>128)return json({error:"Invalid credentials"},401);
  const u=await db.prepare("SELECT id,password_salt,password_hash FROM users WHERE email=?").bind(email).first();
  // Always execute a password KDF to reduce user enumeration timing.
  const hash=await hashPassword(password,u?.password_salt||"00000000000000000000000000000000");
  if(!u?.password_hash||!equal(hash,u.password_hash))return json({error:"Invalid credentials"},401);
  return json({ok:true},200,{"Set-Cookie":await createSession(db,u.id)});
 }
 const user=await session(request,db);
 if(path==="/api/developer/me"&&method==="GET")return user?json({user}):json({error:"Unauthorized"},401);
 if(path==="/api/developer/logout"&&method==="POST"){
  const t=cookie(request);if(t)await db.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await digest(t)).run();
  return json({ok:true},200,{"Set-Cookie":secureCookie("",0)});
 }
 if(!user)return json({error:"Unauthorized"},401);
 if(path==="/api/developer/keys"&&method==="GET"){
  const keys=await db.prepare("SELECT id,name,prefix,created_at,expires_at,revoked_at FROM api_keys WHERE user_id=? ORDER BY created_at DESC LIMIT 100").bind(user.id).all();
  return json({keys:keys.results});
 }
 if(path==="/api/developer/keys"&&method==="POST"){
  const b=await parse(request),name=String(b.name||"").trim();
  if(!name||name.length>80)return json({error:"Key name must be 1–80 characters"},400);
  const count=await db.prepare("SELECT count(*) n FROM api_keys WHERE user_id=? AND revoked_at IS NULL").bind(user.id).first();
  if(count.n>=10)return json({error:"Maximum 10 active keys"},429);
  const secret="sm_"+random(32),id=crypto.randomUUID(),now=Date.now(),expires=now+90*86400000;
  await db.prepare("INSERT INTO api_keys(id,user_id,name,prefix,key_hash,created_at,expires_at) VALUES(?,?,?,?,?,?,?)").bind(id,user.id,name,secret.slice(0,11),await digest(secret),now,expires).run();
  return json({id,key:secret,expires_at:expires},201);
 }
 const match=path.match(/^\/api\/developer\/keys\/([a-f0-9-]{36})$/);
 if(match&&method==="DELETE"){
  const result=await db.prepare("UPDATE api_keys SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL").bind(Date.now(),match[1],user.id).run();
  return json({revoked:result.meta.changes>0});
 }
 if(path==="/api/developer/usage"&&method==="GET"){
  const usage=await db.prepare("SELECT key_id,day,requests FROM api_usage WHERE key_id IN (SELECT id FROM api_keys WHERE user_id=?) ORDER BY day DESC LIMIT 100").bind(user.id).all();
  return json({usage:usage.results});
 }
 return json({error:"Not found"},404);
}
export async function authenticateApiKey(request,env){
 const header=request.headers.get("Authorization")||"";
 if(!/^Bearer sm_[a-f0-9]{64}$/.test(header))return {error:json({error:"API key required"},401)};
 if(!env.DB)return {error:json({error:"API unavailable"},503)};
 const key=await env.DB.prepare("SELECT id,user_id FROM api_keys WHERE key_hash=? AND revoked_at IS NULL AND expires_at>?").bind(await digest(header.slice(7)),Date.now()).first();
 if(!key)return {error:json({error:"Invalid or expired API key"},401)};
 const day=new Date().toISOString().slice(0,10);
 // Atomic quota reservation: a single statement handles concurrent requests.
 const reservation=await env.DB.prepare("INSERT INTO api_usage(key_id,day,requests) VALUES(?,?,1) ON CONFLICT(key_id,day) DO UPDATE SET requests=requests+1 WHERE requests<10000").bind(key.id,day).run();
 if(reservation.meta.changes!==1)return {error:json({error:"Daily API quota reached"},429)};
 const count=await env.DB.prepare("SELECT requests FROM api_usage WHERE key_id=? AND day=?").bind(key.id,day).first();
 
 return {key};
}
