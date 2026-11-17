(() => {
const $=id=>document.getElementById(id);
const fab=$("contribute-fab"),sheet=$("contribution-sheet"),backdrop=$("contribution-backdrop"),form=$("contribution-form-sheet"),preview=$("contribution-preview");
if(!fab||!sheet||!form)return;
let previousFocus=null,mode="add";
const advancedToggle=$("contribution-advanced-toggle"),advanced=$("contribution-additional");
advancedToggle.addEventListener("click",()=>{const expanded=advancedToggle.getAttribute("aria-expanded")==="true";advancedToggle.setAttribute("aria-expanded",String(!expanded));advanced.hidden=expanded;});
const config={add:["Add a place","Add a missing place to help keep the map useful and accurate.","Place name"],edit:["Suggest an edit","Describe the information that should be corrected.","Existing place name"],report:["Report an issue","Flag a closed, duplicated, or incorrectly mapped place.","Place or issue"]};
function open(){previousFocus=document.activeElement;sheet.hidden=false;backdrop.hidden=false;fab.setAttribute("aria-expanded","true");document.body.classList.add("contribution-open");if(mode==="add")requestAnimationFrame(()=>void ensurePreviewMap());$("contribution-close").focus();}
function close(){if(picking)stopPicking(false);sheet.hidden=true;backdrop.hidden=true;fab.setAttribute("aria-expanded","false");document.body.classList.remove("contribution-open");(previousFocus?.isConnected?previousFocus:fab).focus();}
fab.addEventListener("click",open);$("contribution-close").addEventListener("click",close);$("contribution-cancel").addEventListener("click",close);backdrop.addEventListener("click",close);
document.addEventListener("keydown",e=>{if(sheet.hidden)return;if(e.key==="Escape"){e.preventDefault();close()}if(e.key==="Tab"){const nodes=[...sheet.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled])')].filter(el=>el.getClientRects().length);if(!nodes.length)return;const first=nodes[0],last=nodes[nodes.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}}});
document.querySelectorAll("[data-contribution-mode]").forEach(b=>b.addEventListener("click",()=>{mode=b.dataset.contributionMode;document.querySelectorAll("[data-contribution-mode]").forEach(x=>x.setAttribute("aria-pressed",String(x===b)));$("contribution-title").textContent=config[mode][0];$("contribution-explainer").textContent=config[mode][1];$("contribution-name-label").firstChild.textContent=config[mode][2]+" ";advancedToggle.hidden=mode!=="add";advanced.hidden=mode!=="add"||advancedToggle.getAttribute("aria-expanded")!=="true";preview.hidden=true;form.hidden=false;if(mode==="add")requestAnimationFrame(()=>void ensurePreviewMap());}));
const picker=$("contribution-picker");let picking=false;
const typeSheet=$("picker-map-types"),typeButton=$("picker-layers-button");
function closeTypes(){typeSheet.hidden=true;typeButton.setAttribute("aria-expanded","false");}
typeButton.addEventListener("click",()=>{const show=typeSheet.hidden;typeSheet.hidden=!show;typeButton.setAttribute("aria-expanded",String(show));});
$("picker-layers-close").addEventListener("click",closeTypes);
function syncTypes(){document.querySelectorAll("[data-picker-type]").forEach(button=>{const original=document.querySelector('[data-map-type="'+button.dataset.pickerType+'"]');button.setAttribute("aria-checked",original?.getAttribute("aria-checked")==="true"?"true":"false");});}
document.querySelectorAll("[data-picker-type]").forEach(button=>button.addEventListener("click",()=>{const original=document.querySelector('[data-map-type="'+button.dataset.pickerType+'"]');if(original)original.click();syncTypes();closeTypes();}));

const mapInstance=()=>window.map||window.sifricMap;

let previewMap=null,previewLoading=null,previewStyleWait=false,nearbyMarkers=[];
const PREVIEW_ZOOM=16;
function chosenLocation(){
 const raw=$("contribution-coordinates").value.trim();
 const values=raw.split(",").map(Number);
 return raw&&values.length===2&&values.every(Number.isFinite)&&Math.abs(values[0])<=90&&Math.abs(values[1])<=180?[values[1],values[0]]:null;
}
function previewCenter(){return chosenLocation()||mapInstance()?.getCenter()?.toArray()||[80.7,7.9];}
async function ensurePreviewMap(){
 const main=mapInstance(),container=$("contribution-preview-map");
 if(!main?.getStyle||!container||sheet.hidden)return;
 if(previewMap){requestAnimationFrame(()=>previewMap.resize());return;}
 if(!main.isStyleLoaded?.()){
  if(!previewStyleWait){previewStyleWait=true;main.once("style.load",()=>{previewStyleWait=false;if(!sheet.hidden)void ensurePreviewMap();});}
  return;
 }
 if(previewLoading)return previewLoading;
 previewLoading=(async()=>{
  try{
   const lib=await import("https://cdn.jsdelivr.net/npm/maplibre-gl@6.16.0/dist/maplibre-gl.mjs");
   if(sheet.hidden)return;
   const style=structuredClone(main.getStyle());
   const placesLayer=(style.layers||[]).find(layer=>layer.id==="mazo-places-icon");
   for(const layer of style.layers||[]){if(layer.id.startsWith("mazo-places-"))layer.layout={...(layer.layout||{}),visibility:"none"};}
   previewMap=new lib.Map({
    container,style,center:previewCenter(),zoom:PREVIEW_ZOOM,
    interactive:false,attributionControl:false,renderWorldCopies:false,
    pitchWithRotate:false,dragRotate:false,maxZoom:20
   });
   previewMap.on("styleimagemissing",e=>{
    if(previewMap.hasImage(e.id))return;
    const image=main.hasImage(e.id)?main.getImage(e.id):null;
    if(image)previewMap.addImage(e.id,image,{pixelRatio:4});
   });
   previewMap.on("load",()=>{requestAnimationFrame(()=>{previewMap.resize();updatePreviewLocation();});});
   previewMap.on("idle",()=>showNearbyPlaces(placesLayer,lib));
   const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting))requestAnimationFrame(()=>previewMap?.resize());},{threshold:0.01});
   observer.observe(container);
   previewMap.on("error",e=>console.warn("Contribution preview map error",e.error||e));
  }catch(error){previewMap=null;console.warn("Map preview unavailable",error)}
  finally{previewLoading=null}
 })();
 return previewLoading;
}
function showNearbyPlaces(layer,lib){
 if(!previewMap||!layer)return;
 const source=previewMap.getSource(layer.source);
 if(!source)return;
 const options=layer["source-layer"]?{sourceLayer:layer["source-layer"]}:{};
 let features=[];
 try{features=previewMap.querySourceFeatures(layer.source,options)}catch{return;}
 const center=previewMap.getCenter(),unique=new Set();
 const nearby=features.filter(f=>{
  const coords=f.geometry?.type==="Point"?f.geometry.coordinates:null;
  if(!coords||!Number.isFinite(coords[0])||!Number.isFinite(coords[1]))return false;
  const key=String(f.id??f.properties?.id??coords.join(","));
  if(unique.has(key))return false;unique.add(key);return true;
 }).map(f=>({feature:f,distance:Math.hypot((f.geometry.coordinates[0]-center.lng)*Math.cos(center.lat*Math.PI/180),f.geometry.coordinates[1]-center.lat)}))
 .sort((a,b)=>a.distance-b.distance).slice(0,3);
 const key=nearby.map(x=>x.feature.id??x.feature.geometry.coordinates.join(",")).join("|");
 if(previewMap._contributionNearbyKey===key)return;
 previewMap._contributionNearbyKey=key;
 nearbyMarkers.forEach(m=>m.remove());nearbyMarkers=[];
 const colors={food:"#ff8126",shopping:"#0095f6",health:"#ef5261",finance:"#547bc4",leisure:"#18a879",culture:"#b44df0",worship:"#7b969f",transport:"#567a9a",government:"#78909c",landmark:"#b44df0",other:"#82969d"};
 for(const {feature} of nearby){
  const el=document.createElement("div");
  el.className="contribution-nearby-marker";
  el.title=feature.properties?.name||feature.properties?.label||"Nearby place";
  const color=colors[feature.properties?.kind]||colors.other;
  el.innerHTML='<svg viewBox="0 0 24 34" width="23" height="33" aria-hidden="true"><path d="M12 1C5.9 1 1 5.8 1 12c0 8.5 11 21 11 21s11-12.5 11-21C23 5.8 18.1 1 12 1Z" fill="'+color+'" stroke="#fff" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="#fff"/></svg>';
  nearbyMarkers.push(new lib.Marker({element:el,anchor:"bottom"}).setLngLat(feature.geometry.coordinates).addTo(previewMap));
 }
}
function updatePreviewLocation(){
 if(!previewMap){void ensurePreviewMap();return;}
 previewMap._contributionNearbyKey=null;
 previewMap.jumpTo({center:previewCenter(),zoom:PREVIEW_ZOOM});
 requestAnimationFrame(()=>previewMap?.resize());
}
function updateCoordinates(){const map=mapInstance();if(!map?.getCenter)return;const c=map.getCenter();$("picker-coordinates").textContent=c.lat.toFixed(6)+", "+c.lng.toFixed(6);}
function startPicking(){const map=mapInstance();if(!map?.getCenter){$("contribution-address").focus();return;}picking=true;syncTypes();closeTypes();sheet.hidden=true;backdrop.hidden=true;picker.hidden=false;document.body.classList.add("contribution-picking");map.on("move",updateCoordinates);requestAnimationFrame(()=>{map.resize();updateCoordinates();});$("picker-confirm").focus();}
function stopPicking(confirm){if(!picking)return;closeTypes();const map=mapInstance();if(confirm&&map?.getCenter){const c=map.getCenter();$("contribution-coordinates").value=c.lat.toFixed(6)+", "+c.lng.toFixed(6);$("contribution-coordinates").dispatchEvent(new Event("input",{bubbles:true}));}map?.off("move",updateCoordinates);picking=false;picker.hidden=true;sheet.hidden=false;backdrop.hidden=false;document.body.classList.remove("contribution-picking");if(map?.resize)requestAnimationFrame(()=>map.resize());if(confirm)updatePreviewLocation();$("contribution-use-center").focus();}
$("contribution-use-center").addEventListener("click",startPicking);
$("picker-cancel").addEventListener("click",()=>stopPicking(false));
$("picker-confirm").addEventListener("click",()=>stopPicking(true));
document.addEventListener("keydown",e=>{if(picking&&e.key==="Escape"){e.preventDefault();stopPicking(false)}});
form.addEventListener("submit",e=>{e.preventDefault();if(!form.reportValidity())return;const fields=[["Type",config[mode][0]],["Place",form.elements.name.value],["Category",form.elements.category.value],["Address",form.elements.address.value],["Coordinates",form.elements.coordinates.value],["Located within",form.elements.within.value],["Hours",form.elements.hours.value],["Phone",form.elements.phone.value],["Website",form.elements.website.value],["Details",form.elements.details.value]];const dl=$("contribution-preview-details");dl.replaceChildren();for(const [name,value] of fields){if(!value)continue;const dt=document.createElement("dt"),dd=document.createElement("dd");dt.textContent=name;dd.textContent=value;dl.append(dt,dd)}form.hidden=true;preview.hidden=false;sheet.querySelector(".contribution-scroll").scrollTop=0;});
$("contribution-back").addEventListener("click",()=>{preview.hidden=true;form.hidden=false;});
})();