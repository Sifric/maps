(() => {
const $=id=>document.getElementById(id);
const fab=$("contribute-fab"),sheet=$("contribution-sheet"),backdrop=$("contribution-backdrop"),form=$("contribution-form-sheet"),preview=$("contribution-preview");
if(!fab||!sheet||!form)return;
let previousFocus=null,mode="add";
const categorySelect=$("contribution-category"),categoryButton=$("contribution-category-button"),categoryList=$("contribution-category-list"),categoryLabel=$("contribution-category-label");
function closeCategory(){categoryList.hidden=true;categoryButton.setAttribute("aria-expanded","false");}
function syncCategory(){const option=categorySelect.selectedOptions[0];categoryLabel.textContent=categorySelect.value?option.textContent:"Choose a category";categoryButton.classList.toggle("has-value",!!categorySelect.value);categoryList.querySelectorAll("[data-value]").forEach(item=>item.setAttribute("aria-selected",String(item.dataset.value===categorySelect.value)));}
function openCategory(){
 const scroll=categoryButton.closest(".contribution-scroll");
 const viewport=scroll?.getBoundingClientRect();
 const rect=categoryButton.getBoundingClientRect();
 const bottomSpace=Math.max(0,(viewport?.bottom||innerHeight)-rect.bottom-12);
 const topSpace=Math.max(0,rect.top-(viewport?.top||0)-12);
 const upward=bottomSpace<240&&topSpace>bottomSpace;
 categoryList.classList.toggle("opens-up",upward);
 categoryList.style.maxHeight=Math.max(100,Math.min(320,upward?topSpace:bottomSpace))+"px";
 categoryList.hidden=false;categoryButton.setAttribute("aria-expanded","true");
}
categoryButton.addEventListener("click",()=>{if(categoryList.hidden)openCategory();else closeCategory();});
categoryList.addEventListener("click",e=>{const item=e.target.closest("[data-value]");if(!item)return;categorySelect.value=item.dataset.value;categorySelect.dispatchEvent(new Event("change",{bubbles:true}));categoryButton.classList.remove("category-invalid");categoryButton.removeAttribute("aria-invalid");closeCategory();categoryButton.focus();});
categorySelect.addEventListener("change",syncCategory);
document.addEventListener("pointerdown",e=>{if(!e.target.closest(".contribution-category-control"))closeCategory();});
categoryButton.addEventListener("keydown",e=>{if(e.key==="ArrowDown"||e.key==="Enter"||e.key===" "){e.preventDefault();openCategory();(categoryList.querySelector('[aria-selected="true"]')||categoryList.querySelector("[data-value]"))?.focus();}});
categoryList.addEventListener("keydown",e=>{const items=[...categoryList.querySelectorAll("[data-value]")];const i=items.indexOf(document.activeElement);if(e.key==="Escape"){e.preventDefault();closeCategory();categoryButton.focus();}else if(e.key==="ArrowDown"||e.key==="ArrowUp"){e.preventDefault();items[(i+(e.key==="ArrowDown"?1:items.length-1))%items.length]?.focus();}else if(e.key==="Home"||e.key==="End"){e.preventDefault();items[e.key==="Home"?0:items.length-1]?.focus();}});
syncCategory();

const advancedToggle=$("contribution-advanced-toggle"),advanced=$("contribution-additional");
advancedToggle.addEventListener("click",()=>{const expanded=advancedToggle.getAttribute("aria-expanded")==="true";advancedToggle.setAttribute("aria-expanded",String(!expanded));advanced.hidden=expanded;});
const config={add:["Add a place","Add a missing place to help keep the map useful and accurate.","Place name"],edit:["Update a place","Describe the information that should be corrected.","Existing place name"],report:["Report an issue","Flag a closed, duplicated, or incorrectly mapped place.","Place or issue"]};
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
 if(!main?.getStyle||!container||(sheet.hidden&&!picking))return;
 if(previewMap){
  const selected=document.querySelector('[data-map-type][aria-checked="true"]')?.dataset.mapType||"default";
  if(previewMap._selectedMapType!==selected&&main.isStyleLoaded?.()){
   previewMap._selectedMapType=selected;
   const style=structuredClone(main.getStyle());
   for(const layer of style.layers||[]){if(layer.id.startsWith("mazo-places-"))layer.layout={...(layer.layout||{}),visibility:"none"};}
   nearbyMarkers.forEach(marker=>marker.remove());nearbyMarkers=[];
   previewMap._contributionNearbyKey=null;
   previewMap.setStyle(style);
  }
  requestAnimationFrame(()=>previewMap.resize());return;
 }
 if(!main.isStyleLoaded?.()){
  if(!previewStyleWait){previewStyleWait=true;main.once("style.load",()=>{previewStyleWait=false;if(!sheet.hidden||picking)void ensurePreviewMap();});}
  return;
 }
 if(previewLoading)return previewLoading;
 previewLoading=(async()=>{
  try{
   const lib=await import("https://cdn.jsdelivr.net/npm/maplibre-gl@6.16.0/dist/maplibre-gl.mjs");
   if(sheet.hidden&&!picking)return;
   const style=structuredClone(main.getStyle());
   const placesLayer=(style.layers||[]).find(layer=>layer.id==="mazo-places-icon");
   for(const layer of style.layers||[]){if(layer.id.startsWith("mazo-places-"))layer.layout={...(layer.layout||{}),visibility:"none"};}
   previewMap=new lib.Map({
    container,style,center:previewCenter(),zoom:PREVIEW_ZOOM,
    interactive:false,attributionControl:false,renderWorldCopies:false,
    pitchWithRotate:false,dragRotate:false,maxZoom:20
   });
   previewMap._selectedMapType=document.querySelector('[data-map-type][aria-checked="true"]')?.dataset.mapType||"default";
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
function startPicking(){const map=mapInstance();if(!map?.getCenter){$("contribution-address").focus();return;}picking=true;void ensurePreviewMap();syncTypes();closeTypes();sheet.hidden=true;backdrop.hidden=true;picker.hidden=false;document.body.classList.add("contribution-picking");map.on("move",updateCoordinates);requestAnimationFrame(()=>{map.resize();updateCoordinates();});$("picker-confirm").focus();}
function stopPicking(confirm){if(!picking)return;closeTypes();const map=mapInstance();if(confirm&&map?.getCenter){const c=map.getCenter();$("contribution-coordinates").value=c.lat.toFixed(6)+", "+c.lng.toFixed(6);$("contribution-coordinates").dispatchEvent(new Event("input",{bubbles:true}));}map?.off("move",updateCoordinates);picking=false;picker.hidden=true;sheet.hidden=false;backdrop.hidden=false;document.body.classList.remove("contribution-picking");if(map?.resize)requestAnimationFrame(()=>map.resize());if(confirm)updatePreviewLocation();requestAnimationFrame(()=>{previewMap?.resize();});$("contribution-use-center").focus();}
$("contribution-use-center").addEventListener("click",startPicking);
$("picker-cancel").addEventListener("click",()=>stopPicking(false));
$("picker-confirm").addEventListener("click",()=>stopPicking(true));
const pickerLocationButton=$("picker-live-location");
pickerLocationButton.addEventListener("click",()=>{
 if(!picking||pickerLocationButton.disabled)return;
 if(!navigator.geolocation){alert("Location is not supported by this browser.");return;}
 pickerLocationButton.disabled=true;
 pickerLocationButton.setAttribute("aria-busy","true");
 navigator.geolocation.getCurrentPosition(position=>{
  pickerLocationButton.disabled=false;pickerLocationButton.removeAttribute("aria-busy");
  if(!picking)return;
  const map=mapInstance();
  map?.flyTo({center:[position.coords.longitude,position.coords.latitude],zoom:Math.max(16,map.getZoom()),essential:true});
 },error=>{
  pickerLocationButton.disabled=false;pickerLocationButton.removeAttribute("aria-busy");
  if(!picking)return;
  const message=error.code===1?"Location permission was denied. Enable location access in your browser settings.":error.code===3?"Location request timed out. Please try again.":"Unable to get your current location.";
  alert(message);
 },{enableHighAccuracy:true,timeout:12000,maximumAge:30000});
});
document.addEventListener("keydown",e=>{if(picking&&e.key==="Escape"){e.preventDefault();stopPicking(false)}});

const weekDays=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const shortDays=["S","M","T","W","T","F","S"];
const weeklyHours=weekDays.map(()=>({status:"unset",intervals:[]}));
const hoursBackdrop=$("hours-dialog-backdrop"),hoursContent=$("contribution-hours-content"),hoursToggle=$("contribution-hours-open");
let editingDays=[],editingIntervals=[];
function timeText(t){if(!t)return"";const [h,m]=t.split(":").map(Number);return (h%12||12)+":"+String(m).padStart(2,"0")+(h>=12?" PM":" AM");}
function dayText(entry){if(entry.status==="unset")return"Not set";if(entry.status==="closed")return"Closed";if(entry.status==="24")return"Open 24 hours";return entry.intervals.map(([a,b])=>timeText(a)+"–"+timeText(b)).join(", ");}
function syncHours(){const data=weeklyHours.map((v,i)=>({day:weekDays[i],...v}));$("contribution-hours").value=weeklyHours.some(v=>v.status!=="unset")?JSON.stringify(data):"";const count=weeklyHours.filter(v=>v.status!=="unset").length;$("contribution-hours-summary").textContent=count?count+" of 7 days configured":"Add opening hours (optional)";}
function renderHours(){const list=$("hours-list");list.replaceChildren();weeklyHours.forEach((entry,i)=>{const button=document.createElement("button");button.type="button";button.className="hours-day-row";button.innerHTML='<span>'+weekDays[i]+'</span><span class="hours-day-value"></span><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16 4l4 4-11 11-5 1 1-5L16 4Z"/></svg>';button.querySelector(".hours-day-value").textContent=dayText(entry);button.addEventListener("click",()=>openHoursDialog([i]));list.append(button);});syncHours();}
function toggleHours(){const opening=hoursContent.hidden;hoursContent.hidden=!opening;hoursToggle.setAttribute("aria-expanded",String(opening));if(opening)renderHours();}
function renderIntervals(){
 const target=$("hours-intervals");target.replaceChildren();
 const disabled=$("hours-closed").checked||$("hours-24").checked;
 target.hidden=disabled;$("hours-add-interval").hidden=disabled;if(disabled)return;
 editingIntervals.forEach((pair,i)=>{
  const row=document.createElement("div");row.className="hours-interval-row";
  for(let n=0;n<2;n++){
   const label=document.createElement("label");label.className="hours-time-label";
   label.textContent=n?"Close time":"Open time";
   const field=document.createElement("div");field.className="hours-time-field";
   const display=document.createElement("span");display.className="hours-time-display";
   display.textContent=pair[n]?timeText(pair[n]):"Select time";
   const input=document.createElement("input");input.type="time";input.value=pair[n]||"";
   input.setAttribute("aria-label",(n?"Close":"Open")+" time");
   input.addEventListener("input",()=>{editingIntervals[i][n]=input.value;display.textContent=input.value?timeText(input.value):"Select time";});
   input.addEventListener("change",()=>{editingIntervals[i][n]=input.value;display.textContent=input.value?timeText(input.value):"Select time";});
   const clock=document.createElement("span");clock.className="hours-time-clock";
   clock.innerHTML='<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
   field.append(display,clock,input);
   field.addEventListener("click",()=>{try{input.showPicker();}catch{input.focus();input.click();}});
   label.append(field);row.append(label);
  }
  const remove=document.createElement("button");remove.type="button";remove.textContent="×";remove.setAttribute("aria-label","Remove time range");remove.addEventListener("click",()=>{editingIntervals.splice(i,1);renderIntervals();});row.append(remove);target.append(row);
 });
}
function openHoursDialog(days){editingDays=[...days];const first=weeklyHours[days[0]];editingIntervals=first.intervals.length?first.intervals.map(p=>[...p]):[["09:00","17:00"]];$("hours-closed").checked=first.status==="closed";$("hours-24").checked=first.status==="24";$("hours-error").textContent="";const buttons=$("hours-day-buttons");buttons.replaceChildren();shortDays.forEach((name,i)=>{const b=document.createElement("button");b.type="button";b.textContent=name;b.className="hours-day-chip";b.setAttribute("aria-pressed",String(editingDays.includes(i)));b.setAttribute("aria-label",weekDays[i]);b.addEventListener("click",()=>{if(editingDays.includes(i)){if(editingDays.length>1)editingDays=editingDays.filter(d=>d!==i);}else editingDays.push(i);b.setAttribute("aria-pressed",String(editingDays.includes(i)));});buttons.append(b);});renderIntervals();hoursBackdrop.hidden=false;$("hours-edit-save").focus();}
function closeHoursDialog(){hoursBackdrop.hidden=true;$("hours-error").textContent="";}
hoursToggle.addEventListener("click",toggleHours);
$("hours-edit-cancel").addEventListener("click",closeHoursDialog);
$("hours-24").addEventListener("change",()=>{if($("hours-24").checked)$("hours-closed").checked=false;renderIntervals();});
$("hours-closed").addEventListener("change",()=>{if($("hours-closed").checked)$("hours-24").checked=false;renderIntervals();});
$("hours-add-interval").addEventListener("click",()=>{if(editingIntervals.length>=6)return;editingIntervals.push(["09:00","17:00"]);renderIntervals();});
document.querySelectorAll("[data-hours-preset]").forEach(b=>b.addEventListener("click",()=>openHoursDialog(b.dataset.hoursPreset==="all"?[0,1,2,3,4,5,6]:b.dataset.hoursPreset==="weekdays"?[1,2,3,4,5]:[0,6])));
$("hours-edit-save").addEventListener("click",()=>{const status=$("hours-closed").checked?"closed":$("hours-24").checked?"24":"times";const intervals=editingIntervals.map(p=>[...p]);if(status==="times"&&(!intervals.length||intervals.some(([a,b])=>!a||!b||a===b))){$("hours-error").textContent="Enter a valid opening and closing time for each range.";return;}for(const i of editingDays)weeklyHours[i]={status,intervals:status==="times"?intervals.map(p=>[...p]):[]};closeHoursDialog();renderHours();});
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!hoursBackdrop.hidden){e.preventDefault();closeHoursDialog();}});

form.addEventListener("submit",e=>{e.preventDefault();if(!categorySelect.value){categoryButton.focus();categoryButton.setAttribute("aria-invalid","true");categoryButton.classList.add("category-invalid");openCategory();return;}if(!form.reportValidity())return;const fields=[["Type",config[mode][0]],["Place",form.elements.name.value],["Category",form.elements.category.value],["Address",form.elements.address.value],["Coordinates",form.elements.coordinates.value],["Located within",form.elements.within.value],["Hours",form.elements.hours.value?weeklyHours.map((entry,i)=>weekDays[i]+": "+dayText(entry)).join("\n"):""],["Phone",form.elements.phone.value],["Website",form.elements.website.value],["Details",form.elements.details.value]];const dl=$("contribution-preview-details");dl.replaceChildren();for(const [name,value] of fields){if(!value)continue;const dt=document.createElement("dt"),dd=document.createElement("dd");dt.textContent=name;dd.textContent=value;dl.append(dt,dd)}form.hidden=true;preview.hidden=false;sheet.querySelector(".contribution-scroll").scrollTop=0;});
$("contribution-back").addEventListener("click",()=>{preview.hidden=true;form.hidden=false;});
})();