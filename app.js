'use strict';
/* レシート帳 v12 — safe batch review/save, confidence hints, backup reminders, advanced search and reports. Data stays local. */
const $=id=>document.getElementById(id);
let db, all=[], selectedFile=null, selectedUrl=null, editId=null, cropBox=null, cropImg=null, cropDraft=null, cropDragging=false, lastOcrData=null, batchActiveIndex=null;
const DEFAULT_CATEGORIES=['未分類','消耗品費','印刷製本費','旅費交通費','通信費','車両費','駐車場代','ガソリン代','高速道路料金','会議費','接待交際費','広告宣伝費','新聞図書費','水道光熱費','地代家賃','支払手数料','保険料','租税公課','修繕費','外注工賃','仕入高','荷造運賃','研修費','諸会費','福利厚生費','減価償却費','雑費','その他'];
const CATEGORY_KEY='receipt-ledger-custom-categories-v2';
const $field=id=>($(id).value||'').trim();
const localDate=()=>{const d=new Date();return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-')};
const money=n=>'¥'+Number(n||0).toLocaleString('ja-JP');
const notice=s=>{$('notice').style.display='block';$('notice').textContent=s};
function showSaveStatus(message,kind='error',fieldId=null){
 const el=$('saveStatus');el.className='saveStatus '+kind;el.style.display='block';el.textContent=message;
 for(const input of document.querySelectorAll('.input-invalid'))input.classList.remove('input-invalid');
 if(fieldId&&$(fieldId))$(fieldId).classList.add('input-invalid');
 el.scrollIntoView({block:'center',behavior:'smooth'});
}
function clearSaveStatus(){const el=$('saveStatus');if(!el)return;el.textContent='';el.style.display='none';el.className='saveStatus';for(const x of document.querySelectorAll('.input-invalid'))x.classList.remove('input-invalid')}
function normalizeInvoiceInput(value){
 let x=String(value||'').normalize('NFKC').replace(/[\s－―ー‐−–—.-]/g,'').toUpperCase();
 // The OCR often loses the leading T, but 13 digits alone are also a valid user input format.
 if(/^\d{13}$/.test(x))x='T'+x;
 return x;
}
const clamp=(x,min,max)=>Math.max(min,Math.min(max,x));
const businessAmount=(amount,rate)=>Math.round(Number(amount||0)*Number(rate==null?100:rate)/100);
function getCustomCategories(){try{const a=JSON.parse(localStorage.getItem(CATEGORY_KEY)||'[]');return Array.isArray(a)?a.filter(x=>typeof x==='string'&&x.length<=30):[]}catch{return []}}
function currentCategories(){return [...new Set([...DEFAULT_CATEGORIES,...getCustomCategories(),...all.map(x=>x.category).filter(Boolean)])]}
function fillCategories(){const selected=$('category').value,filter=$('filter').value;
 $('category').replaceChildren();$('filter').replaceChildren();
 $('filter').add(new Option('すべての科目',''));
 for(const name of currentCategories()){ $('category').add(new Option(name,name));$('filter').add(new Option(name,name)); }
 $('category').value=currentCategories().includes(selected)?selected:'未分類';$('filter').value=currentCategories().includes(filter)?filter:'';
}
function openDb(){return new Promise((resolve,reject)=>{const req=indexedDB.open('receipt-ledger-v1',1);req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains('receipts'))req.result.createObjectStore('receipts',{keyPath:'id'})};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})}
function txWrite(fn){return new Promise((resolve,reject)=>{const tx=db.transaction('receipts','readwrite');fn(tx.objectStore('receipts'));tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)})}
function getAll(){return new Promise((resolve,reject)=>{const req=db.transaction('receipts').objectStore('receipts').getAll();req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})}
const saveItem=x=>txWrite(s=>s.put(x)); const deleteItem=id=>txWrite(s=>s.delete(id));
async function refresh(){all=await getAll();fillCategories();render()}
function loadScript(src){return new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=src;script.onload=resolve;script.onerror=()=>reject(Error('ネットワーク上の認識ライブラリを読み込めませんでした'));document.head.append(script)})}
function toDataUrl(file){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.readAsDataURL(file)})}
function decodeImage(file){return new Promise((resolve,reject)=>{const img=new Image();const url=URL.createObjectURL(file);img.onload=()=>{URL.revokeObjectURL(url);resolve(img)};img.onerror=()=>{URL.revokeObjectURL(url);reject(Error('画像を開けません。JPEGまたはPNG形式にして再度お試しください'))};img.src=url})}
function canvasForImage(img,rotation){let w=img.naturalWidth||img.width,h=img.naturalHeight||img.height;const s=Math.min(3,3000/Math.max(w,h),Math.max(1,1100/Math.min(w,h)));const cw=Math.max(1,Math.round(w*s)),ch=Math.max(1,Math.round(h*s));const rotated=rotation%180!==0;const c=document.createElement('canvas');c.width=rotated?ch:cw;c.height=rotated?cw:ch;const ctx=c.getContext('2d',{willReadFrequently:true});ctx.save();ctx.translate(c.width/2,c.height/2);ctx.rotate(rotation*Math.PI/180);ctx.drawImage(img,-cw/2,-ch/2,cw,ch);ctx.restore();return c}
function canvasPagesForOcr(img,rotation){
 // Very long receipts become unreadable when the whole image is shrunk to a small width.
 // Read such photos in overlapping, full-resolution bands instead.
 const w=img.naturalWidth||img.width,h=img.naturalHeight||img.height;
 if(rotation!==0 || h/w<2.8)return [canvasForImage(img,rotation)];
 const scale=Math.min(2.2,Math.max(1,1100/w));
 const bandHeight=Math.round(2100/scale),overlap=Math.round(90/scale),step=Math.max(200,bandHeight-overlap);
 const canvases=[];
 for(let y=0;y<h&&canvases.length<8;y+=step){
  const cropH=Math.min(h-y,bandHeight),c=document.createElement('canvas');
  c.width=Math.round(w*scale);c.height=Math.round(cropH*scale);
  c.getContext('2d',{willReadFrequently:true}).drawImage(img,0,y,w,cropH,0,0,c.width,c.height);
  canvases.push(c);if(y+cropH>=h)break;
 }
 // Unusually long images are processed as one complete page rather than silently omitting the bottom.
 if(canvases.length===8&&((8-1)*step+bandHeight)<h)return [canvasForImage(img,rotation)];
 return canvases;
}
// v11 — Trim obvious dark desk margins while keeping the original photo unchanged.
// Conservative: only trim if all three scan lines agree on a bright central document.
function autoTrimReceiptSource(img){
 const w=img.naturalWidth||img.width,h=img.naturalHeight||img.height;
 if(w<160||h<150)return img;
 const sw=192,sh=144,c=document.createElement('canvas');c.width=sw;c.height=sh;
 const cx=c.getContext('2d',{willReadFrequently:true});cx.drawImage(img,0,0,sw,sh);
 const pix=cx.getImageData(0,0,sw,sh).data;
 const light=(x,y)=>{const k=(y*sw+x)*4;return .299*pix[k]+.587*pix[k+1]+.114*pix[k+2]};
 const spans=[];
 for(const fr of [.37,.53,.68]){
  const y=Math.round(sh*fr);let outer=0;
  for(let t=0;t<12;t++)outer+=(light(t,y)+light(sw-1-t,y))/24;
  const center=Array.from({length:24},(_,i)=>light(Math.round(sw*.44)+i,y)).reduce((x,v)=>x+v,0)/24;
  if(center<145||center<outer+28)return img;
  const threshold=Math.max(outer+23,(outer+center)/2);
  let left=Math.round(sw*.1),right=Math.round(sw*.9);
  for(let x=8;x<sw*.49;x++){
   const sample=Array.from({length:7},(_,k)=>light(x+k,y)).reduce((q,v)=>q+v,0)/7;
   if(sample>threshold){left=x;break}
  }
  for(let x=sw-9;x>sw*.51;x--){
   const sample=Array.from({length:7},(_,k)=>light(x-k,y)).reduce((q,v)=>q+v,0)/7;
   if(sample>threshold){right=x;break}
  }
  spans.push({left,right});
 }
 const l=Math.min(...spans.map(z=>z.left)),r=Math.max(...spans.map(z=>z.right));
 const disagreements=Math.max(...spans.map(z=>z.left))-Math.min(...spans.map(z=>z.left)) + Math.max(...spans.map(z=>z.right))-Math.min(...spans.map(z=>z.right));
 if(r-l<sw*.35||r-l>sw*.88||disagreements>sw*.15)return img;
 const pad=Math.round(sw*.028),x1=Math.max(0,l-pad),x2=Math.min(sw,r+pad);
 const crop=document.createElement('canvas');crop.width=Math.round((x2-x1)*w/sw);crop.height=h;
 crop.getContext('2d',{willReadFrequently:true}).drawImage(img,x1*w/sw,0,(x2-x1)*w/sw,h,0,0,crop.width,h);
 return crop;
}
// v14: Detect a bright horizontal receipt surrounded by darker tabletop.
// Crop only when the contrast and two outside margins are unambiguous.
// This never changes the stored original photo; it affects OCR input only.
function autoCropHorizontalReceiptSource(img){
 const w=img.naturalWidth||img.width,h=img.naturalHeight||img.height;
 if(w<300||h<450||h/w<.7)return img;
 const sw=160,sh=160,c=document.createElement('canvas');c.width=sw;c.height=sh;
 const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(img,0,0,sw,sh);
 const p=ctx.getImageData(0,0,sw,sh).data,rows=[];
 for(let y=0;y<sh;y++){
  let sum=0,count=0;
  for(let x=16;x<sw-16;x+=3){const i=(y*sw+x)*4;sum+=p[i]*.299+p[i+1]*.587+p[i+2]*.114;count++}
  rows.push(sum/count);
 }
 const avg=(s,e)=>rows.slice(s,e).reduce((a,b)=>a+b,0)/Math.max(1,e-s);
 const outside=(avg(1,19)+avg(141,159))/2;
 // A white page already fills the frame, or contrast is insufficient.
 if(outside>180)return img;
 const threshold=Math.max(181,outside+28);
 const smooth=rows.map((_,y)=>avg(Math.max(0,y-3),Math.min(sh,y+4)));
 let best=null,start=-1,gap=0;
 for(let y=0;y<=sh;y++){
  const bright=y<sh&&smooth[y]>threshold;
  if(bright){if(start<0)start=y;gap=0}
  else if(start>=0){gap++;if(gap>5||y===sh){const end=y-gap+1,span=end-start;
   if(span>=sh*.15&&(!best||span>best.span))best={start,end,span};
   start=-1;gap=0;
  }}
 }
 if(!best||best.span>sh*.76||best.start<sh*.07||best.end>sh*.93)return img;
 const center=avg(best.start,best.end);
 if(center<outside+30)return img;
 const pad=7,startY=Math.max(0,best.start-pad),endY=Math.min(sh,best.end+pad);
 const y1=Math.floor(startY*h/sh),cropH=Math.ceil((endY-startY)*h/sh);
 if(cropH<=0||cropH>h*.91)return img;
 const out=document.createElement('canvas');out.width=w;out.height=Math.min(h-y1,cropH);
 out.getContext('2d',{willReadFrequently:true}).drawImage(img,0,y1,w,out.height,0,0,w,out.height);
 return out;
}
// Re-scan the upper store and the lower date separately. Neither pass makes up missing text.
function focusedCanvasForOcr(img,rotation,start,end){
 const full=canvasForImage(img,rotation),y=Math.round(full.height*start),height=Math.max(1,Math.round(full.height*end)-y);
 const sc=Math.min(2,Math.max(1,1900/Math.max(full.width,height)));
 const c=document.createElement('canvas');c.width=Math.max(1,Math.round(full.width*sc));c.height=Math.max(1,Math.round(height*sc));
 c.getContext('2d',{willReadFrequently:true}).drawImage(full,0,y,full.width,height,0,0,c.width,c.height);
 full.width=0;full.height=0;return c;
}
function headerCanvasForOcr(img,rotation){
 const c=canvasForImage(img,rotation);const h=Math.max(1,Math.round(c.height*.52));
 const scale=Math.min(1.7,Math.max(1,1700/Math.max(1,c.width)));
 const top=document.createElement('canvas');top.width=Math.round(c.width*scale);top.height=Math.round(h*scale);
 top.getContext('2d',{willReadFrequently:true}).drawImage(c,0,0,c.width,h,0,0,top.width,top.height);
 c.width=0;c.height=0;return top;
}
function enhancedCanvas(original){const c=document.createElement('canvas');c.width=original.width;c.height=original.height;const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(original,0,0);const im=ctx.getImageData(0,0,c.width,c.height),p=im.data;
 const hist=new Uint32Array(256);for(let i=0;i<p.length;i+=4*9){hist[clamp(Math.round(p[i]*.299+p[i+1]*.587+p[i+2]*.114),0,255)]++}
 const total=hist.reduce((a,b)=>a+b,0);let cumulative=0,lo=0,hi=255;for(let k=0;k<256;k++){cumulative+=hist[k];if(cumulative>=total*.03){lo=k;break}}
 cumulative=0;for(let k=0;k<256;k++){cumulative+=hist[k];if(cumulative>=total*.98){hi=k;break}}const scale=255/Math.max(90,hi-lo);
 for(let i=0;i<p.length;i+=4){const g=p[i]*.299+p[i+1]*.587+p[i+2]*.114;const x=clamp(Math.round((g-lo)*scale),0,255);p[i]=x;p[i+1]=x;p[i+2]=x;p[i+3]=255}
 ctx.putImageData(im,0,0);return c}
function canvasToDataUrl(c){try{return c.toDataURL('image/jpeg',.79)}catch{return null}}
async function compactPhoto(file){try{const img=await decodeImage(file);const s=img.naturalHeight/img.naturalWidth>2.8?Math.min(1,6500/img.naturalHeight):Math.min(1,2200/Math.max(img.naturalWidth,img.naturalHeight));const c=document.createElement('canvas');c.width=Math.max(1,Math.round(img.naturalWidth*s));c.height=Math.max(1,Math.round(img.naturalHeight*s));c.getContext('2d').drawImage(img,0,0,c.width,c.height);return canvasToDataUrl(c)||await toDataUrl(file)}catch{return await toDataUrl(file)}}
function setPreview(url){$('preview').style.display=url?'block':'none';if(url)$('preview').src=url;else $('preview').removeAttribute('src')}
function cropImageSource(img,box){
 if(!box)return img;
 const c=document.createElement('canvas'); c.width=Math.max(1,Math.round(box.w));c.height=Math.max(1,Math.round(box.h));
 c.getContext('2d',{willReadFrequently:true}).drawImage(img,box.x,box.y,box.w,box.h,0,0,c.width,c.height);
 return c;
}
function resetCrop(){cropBox=null;cropDraft=null;cropImg=null;$('cropPanel').classList.add('hidden');$('cropReset').classList.add('hidden')}
$('photo').addEventListener('change',e=>{if(selectedUrl)URL.revokeObjectURL(selectedUrl);selectedFile=e.target.files[0]||null;selectedUrl=selectedFile?URL.createObjectURL(selectedFile):null;resetCrop();setPreview(selectedUrl)});
function cropPt(ev){const c=$('cropCanvas'),rect=c.getBoundingClientRect();return {x:clamp((ev.clientX-rect.left)*c.width/rect.width,0,c.width),y:clamp((ev.clientY-rect.top)*c.height/rect.height,0,c.height)}}
function cropRectFromPoints(a,b){const x=Math.min(a.x,b.x),y=Math.min(a.y,b.y);return {x,y,w:Math.abs(b.x-a.x),h:Math.abs(b.y-a.y)}}
function paintCrop(){if(!cropImg)return;const c=$('cropCanvas'),ctx=c.getContext('2d');ctx.clearRect(0,0,c.width,c.height);ctx.drawImage(cropImg,0,0,c.width,c.height);
 if(cropDraft&&cropDraft.w>=5&&cropDraft.h>=5){const r=cropDraft;
  ctx.fillStyle='rgba(3,16,12,.43)';ctx.fillRect(0,0,c.width,r.y);ctx.fillRect(0,r.y,r.x,r.h);ctx.fillRect(r.x+r.w,r.y,c.width-r.x-r.w,r.h);ctx.fillRect(0,r.y+r.h,c.width,c.height-r.y-r.h);
  ctx.lineWidth=3;ctx.strokeStyle='#17e6aa';ctx.strokeRect(r.x+1,r.y+1,r.w-2,r.h-2);
 }
}
let cropAnchor=null;
$('cropStart').onclick=async()=>{if(!selectedFile){notice('先に領収書の写真を選んでね');return}
 try{cropImg=await decodeImage(selectedFile);const c=$('cropCanvas');const s=Math.min(1,680/cropImg.naturalWidth,850/cropImg.naturalHeight);c.width=Math.max(1,Math.round(cropImg.naturalWidth*s));c.height=Math.max(1,Math.round(cropImg.naturalHeight*s));
  cropDraft=null;$('cropPanel').classList.remove('hidden');paintCrop();$('cropPanel').scrollIntoView({behavior:'smooth',block:'center'});
 }catch(e){notice('切り抜き画面を開けませんでした：'+e.message)}
};
$('cropCanvas').onpointerdown=e=>{if(!cropImg)return;cropDragging=true;cropAnchor=cropPt(e);cropDraft={x:cropAnchor.x,y:cropAnchor.y,w:0,h:0};$('cropCanvas').setPointerCapture(e.pointerId);e.preventDefault()};
$('cropCanvas').onpointermove=e=>{if(!cropDragging||!cropAnchor)return;cropDraft=cropRectFromPoints(cropAnchor,cropPt(e));paintCrop();e.preventDefault()};
$('cropCanvas').onpointerup=e=>{if(!cropDragging)return;cropDragging=false;cropDraft=cropRectFromPoints(cropAnchor,cropPt(e));paintCrop();e.preventDefault()};
$('cropCanvas').onpointercancel=()=>{cropDragging=false};
$('cropApply').onclick=()=>{if(!cropImg||!cropDraft||cropDraft.w<25||cropDraft.h<20){notice('領収書の四隅を指で囲んで範囲を選択してください');return}
 const canvas=$('cropCanvas'),sx=cropImg.naturalWidth/canvas.width,sy=cropImg.naturalHeight/canvas.height;
 cropBox={x:Math.round(cropDraft.x*sx),y:Math.round(cropDraft.y*sy),w:Math.round(cropDraft.w*sx),h:Math.round(cropDraft.h*sy)};
 const preview=cropImageSource(cropImg,cropBox);setPreview(preview.toDataURL('image/jpeg',.88));preview.width=0;preview.height=0;
 $('cropReset').classList.remove('hidden');$('cropPanel').classList.add('hidden');notice('領収書だけ切り抜いたよ。次に「写真から自動入力」を押してね。元の写真はそのまま保存されるよ。')
};
$('cropCancel').onclick=()=>{$('cropPanel').classList.add('hidden')};
$('cropReset').onclick=()=>{resetCrop();setPreview(selectedUrl);notice('切り抜きを取り消しました')};
function resetForm(){clearSaveStatus();lastOcrData=null;batchActiveIndex=null;selectedFile=null;editId=null;resetCrop();if(selectedUrl)URL.revokeObjectURL(selectedUrl);selectedUrl=null;$('photo').value='';setPreview(null);$('date').value=localDate();$('amount').value='';$('store').value='';$('detail').value='';$('category').value='未分類';$('payment').value='未設定';$('taxRate').value='';$('taxAmount').value='';$('businessRate').value='100';$('invoiceNo').value='';$('memo').value='';$('rotation').value='0';$('receiptType').value='その他';$('learnVendor').checked=false;$('invoiceVerified').checked=false;$('reviewed').checked=false;$('ocrEvidence').replaceChildren();$('ocrText').textContent='まだ解析していません。';$('save').textContent='💾 領収書を保存する';updateBusinessEstimate()}
$('clear').onclick=()=>{resetForm();notice('入力をクリアしました')};
function updateBusinessEstimate(){let v=Number($('businessRate').value);if(!Number.isFinite(v))v=100;v=clamp(v,0,100);$('businessAmount').textContent=`経費計上の目安：${money(businessAmount($('amount').value,v))}（事業使用割合${v}%）`}
$('amount').addEventListener('input',updateBusinessEstimate);$('businessRate').addEventListener('input',updateBusinessEstimate);
$('invoiceNo').addEventListener('blur',()=>{const raw=$field('invoiceNo');if(raw){const normalized=normalizeInvoiceInput(raw);if(/^T\d{13}$/.test(normalized))$('invoiceNo').value=normalized}});
for(const field of ['date','amount','invoiceNo','taxAmount','businessRate'])$(field).addEventListener('input',()=>{if($('saveStatus').classList.contains('error'))clearSaveStatus()});
$('addCategory').onclick=()=>{const value=$field('customCategory');if(!value){notice('追加する科目名を入力してください');return}const vals=getCustomCategories();if(!currentCategories().includes(value)){vals.push(value);try{localStorage.setItem(CATEGORY_KEY,JSON.stringify(vals))}catch{notice('科目を保存できませんでした')}}fillCategories();$('category').value=value;$('customCategory').value='';notice(`「${value}」を経費科目に追加しました`)};

// Receipt parser — context-weighted extraction to avoid mixing up tax, change and total.
const normalizeText=t=>String(t||'').normalize('NFKC').replace(/[￥﹩]/g,'¥').replace(/(?<=\d)[.．](?=\d{3}(?:\D|$))/g,',').replace(/\r/g,'');
function validDate(year,month,day){const d=new Date(year,month-1,day);return d.getFullYear()===year&&d.getMonth()===month-1&&d.getDate()===day&&year>=2000&&year<=2100}
function findDate(lines){const now=new Date();const list=[];for(let i=0;i<lines.length;i++){
 let s=lines[i].replace(/(?<=\d)\s+(?=\d)/g,'').replace(/[年月日]\s+/g,m=>m.trim());const dateLabel=/(領収日|発行日|購入日|取引日|お買い上げ日|お買上日|利用日|売上日|日時|DATE|購入日時)/i.test(s);
 const patterns=[{r:/(20\d{2})\s*[年/\-.]\s*(\d{1,2})\s*[月/\-.]\s*(\d{1,2})\s*日?/g,type:'full'},
 {r:/(?:令和|R)\s*(\d{1,2})\s*[年/\-.]\s*(\d{1,2})\s*[月/\-.]\s*(\d{1,2})/gi,type:'reiwa'},
 {r:/(?:^|\D)(\d{2})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{1,2})(?=\D|$)/g,type:'short'},
 {r:/(20\d{2})(\d{2})(\d{2})(?!\d)/g,type:'compact'}];
 for(const {r,type} of patterns){for(const m of s.matchAll(r)){const year=type==='reiwa'?2018+Number(m[1]):type==='short'?2000+Number(m[1]):Number(m[1]),month=Number(m[2]),day=Number(m[3]);if(!validDate(year,month,day))continue;const d=new Date(year,month-1,day);const diff=Math.abs((now-d)/(86400000));let score=50+(dateLabel?30:0)+(i<8?12:0)-Math.min(diff/365,15);if(d>new Date(now.getTime()+3*86400000))score-=25;list.push({value:`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`,score})}}
 }return list.sort((a,b)=>b.score-a.score)[0]||null}
function numericValues(s){
 // A tax component can be only ¥4 (the old version ignored single-digit numbers).
 // Reject partial matches from long IDs, telephone numbers, and dates.
 const out=[];
 const reg=/(?<![\dA-Za-z])([¥]?\s*(?:\d{1,3}(?:,\d{3})+|\d{1,9})\s*円?)(?!\d)/g;
 for(const m of s.matchAll(reg)){
  const chunk=m[1].replace(/\s/g,'');
  const n=Number(chunk.replace(/[¥円,]/g,''));
  if(Number.isFinite(n)&&n>=1&&n<=99999999)out.push({value:n,text:chunk,yen:/[¥円]/.test(chunk),index:m.index||0});
 }
 return out;
}
function findAmount(lines){const candidates=[];
 const good=/(総合計|お支払合計|お支払い合計|税込合計|合計金額|領収金額|ご請求額|お買上金額|ご利用金額|お支払金額|現金支払額|現金支払い額|お支払額|今回ご利用額|お買上計|お買い上げ計|現計|合\s*計|TOTAL|AMOUNT\s*DUE)/i;
 const bad=/(お釣|おつり|釣銭|お預り|預り金|現金お預り|小計|消費税|税額|内税|外税|値引|割引|ポイント|クーポン|残高|単価|税抜|T\d{10,}|TEL|電話|領収書NO|レジNO|登録番号)/i;
 for(let i=0;i<lines.length;i++){
  const line=lines[i],goodHit=good.test(line),badHit=bad.test(line),vals=numericValues(line);
  for(const token of vals){let score=token.yen?14:0;const afterLabel=goodHit?line.search(good)<=token.index:true;
   if(goodHit&&afterLabel)score+=95;else if(goodHit)score+=60;
   if(badHit&&!goodHit)score-=95;
   if(/(税抜|税率|税込\s*10%|10%|8%)/.test(line)&&!goodHit)score-=45;
   if(/20\d{2}\s*[/-]\s*\d{1,2}|20\d{6}|\d{1,2}:\d{2}/.test(line)&&!goodHit&&!token.yen)score-=70;
   if(/^\s*\d{10,}/.test(line))score-=80;
   if(i<22)score+=3;
   if(goodHit&&badHit)score-=12;
   if(token.value<10)score-=30;
   candidates.push({value:token.value,score,why:line})
  }
  if(goodHit&&!vals.length&&i+1<lines.length){for(const token of numericValues(lines[i+1]))candidates.push({value:token.value,score:100+(token.yen?10:0),why:line+' / '+lines[i+1]})}
 }
 const best=candidates.sort((a,b)=>b.score-a.score||b.value-a.value)[0];return best&&best.score>=6?best:null}
function condensedShopText(s){return String(s||'').normalize('NFKC').replace(/[‐－ーｰ―—–\s・.:：]/g,'').replace(/７/g,'7')}
function sevenElevenStore(lines){
 const top=lines.slice(0,24);
 const brand=top.some((line,i)=>{
  const a=condensedShopText(line);
  const pair=condensedShopText(line+' '+(top[i+1]||''));
  return /セ[ブプ][ンソ].*?イレ[ブプ][ンソ]/.test(a)||/セ[ブプ][ンソ].*?イレ[ブプ][ンソ]/.test(pair)||/7ELEVEN/i.test(a)||/SEVEN.?ELEVEN/i.test(a)||(/セブン/.test(a)&&/イレブン/.test(pair));
 });
 if(!brand)return null; // never infer a 7-Eleven only from branch/address or a tax invoice number
 const branches=[];
 for(let i=0;i<Math.min(25,lines.length);i++){
  let x=String(lines[i]).normalize('NFKC').replace(/\s+/g,'').trim();
  if(/〒|電話|TEL|登録|インボイス|領収書|202[0-9]|レシート|大阪府|[￥¥]|\d{2}:\d{2}/i.test(x))continue;
  x=x.replace(/^(セ[ブプ]ン[‐ー-]?イレ[ブプ]ン)[-・\s]*/,'');
  const match=x.match(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\d]{2,26}(?:(?:\d+|[一二三四五六七八九十])丁目)?店)$/u);
  if(match&&match[1].length<28)branches.push({name:match[1].replace(/^[1-9]*/,'').replace(/(?:店){2,}$/,'店'),score:100-i});
 }
 branches.sort((a,b)=>b.score-a.score);
 return {value:'セブン‐イレブン'+(branches[0]?' '+branches[0].name:''),score:180};
}
function findStore(lines){
 const seven=sevenElevenStore(lines);if(seven)return seven;

 // Do not invent store names from random fragments of the photo background.
 const banned=/(領収書|レシート|お買上|お買い上げ|売上票|RECEIPT|明細|消費税|登録番号|インボイス|合計|小計|電話|TEL|FAX|〒|税抜|税込|¥|金額|ポイント|ご利用|お問い合せ|お問い合わせ|ありがとう|カード|会員|現金|お釣|NO[.:]|印紙|免税|保存上のお願い|枚数|担当者|伝票)/i;
 const candidates=[];
 lines.slice(0,60).forEach((line,i)=>{
  const x=line.replace(/^[*#●\s]+/,'').replace(/\s+/g,' ').trim();
  if(x.length<3||x.length>48||banned.test(x)||/^\d/.test(x)||/\d{2}[:/.-]\d{2}/.test(x)||/https?:|@/.test(x))return;
  const japanese=(x.match(/[ぁ-んァ-ヶ一-龥a-zA-Z]/g)||[]).length;
  if(japanese/x.length<.65)return;
  const branch=/(?:店|支店|営業所|センター|会館|ホテル|ショップ|モール)\s*$/.test(x);
  const company=/(株式会社|有限会社|合同会社|合同事務所|商事|商会|企業|カンパニー)/.test(x);
  const named=/(ビッグウッド|マート|ストア|スーパー|ドラッグ|ファミリー|ファミマ|ローソン|セブン|ENEOS|イオン|DCM|コーナン|ダイソー)/i.test(x);
  // Business suffix is required unless the image clearly contains a known business word.
  if(!branch&&!company&&!named)return;
  let score=32+(branch?55:0)+(company?34:0)+(named?18:0)+(x.length>=4&&x.length<=24?12:0)-Math.min(i,25)*.7;
  if(/^[^\s]+(市|区|町|丁目|番地|号)/.test(x))score-=24;
  if(/T\d{8,}|\d{5,}|\d{2,}[-‐]\d+/.test(x))score-=40;
  if((x.match(/[をにのはへでがを]/g)||[]).length>=5)score-=40;
  candidates.push({value:x,score});
 });
 return candidates.sort((a,b)=>b.score-a.score)[0]||null;
}
function findTax(lines,amount){
 const candidate=[];
 const labelRe=/(消費税等|内消費税|内\s*税|消費税額|消費税|税額|税合計|内訳\s*税|\d{1,2}\s*%\s*対象.*税)/i;
 const negative=/(税抜合計|税込合計|合計金額|小計|お釣り|釣銭|お預り)/;
 for(let i=0;i<lines.length;i++){
  const line=lines[i];if(!labelRe.test(line))continue;
  const labelIndex=line.search(labelRe);
  const values=numericValues(line).filter(v=>v.value>=1 &&(!amount || v.value<=amount));
  for(const token of values){
   // Prefer values printed to the right of the tax label; avoid the '10' from '10%'.
   if(token.index<labelIndex)continue;
   if(/\d\s*%/.test(line.slice(Math.max(0,token.index-2),token.index+token.text.length+1)) && token.value<=10)continue;
   let score=105+(token.yen?12:0)-(negative.test(line)?18:0)-i*.2;
   if(/(?:内消費税|消費税等|消費税額|内\s*税|税合計)/.test(line))score+=22;
   if(amount){const ratio=token.value/amount;if(ratio>=.067&&ratio<=.095)score+=25;else if(ratio>.13||ratio<.002)score-=65;}
   candidate.push({value:token.value,score});
  }
  // Some OCR results have the tax amount on the line immediately below the label.
  if(!values.length&&i+1<lines.length){
   const n=numericValues(lines[i+1]).filter(v=>v.value>0&&(!amount||v.value<=amount));
   for(const token of n)candidate.push({value:token.value,score:75+(token.yen?10:0)-i*.2});
  }
 }
 const best=candidate.sort((a,b)=>b.score-a.score)[0];return best&&best.score>=30?best:null;
}
function fixInvoiceDigits(s){return String(s||'').normalize('NFKC').toUpperCase().replace(/[ＯOo〇○]/g,'0').replace(/[ＩIl|ｌ]/g,'1').replace(/[Ｓs]/g,'5').replace(/[Ｂb]/g,'8').replace(/[Ｚz]/g,'2').replace(/[Ｇg]/g,'6').replace(/[\s,－―ー‐−–—.:・]/g,'')}
function findInvoice(text){
 const lines=normalizeText(text).split(/\n/).map(x=>x.trim()).filter(Boolean), candidates=[];
 const labelRe=/(事業者.{0,5}登.{0,6}番|登録\s*番号|登錄\s*番号|適格請求書|インボイス|登録\s*[NＮ]o)/i;
 for(let i=0;i<lines.length;i++){
  const raw=lines[i],label=labelRe.test(raw);
  // Broken print may put the T-number on the next line after the label.
  const combined=label?lines.slice(i,i+3).join(' '):raw;
  for(const m of combined.matchAll(/[TＴtｔ丁〒]\s*[:：]?\s*((?:[0-9０-９ＯOo〇○ＩIl|ｌＳsＢbＺzＧg][,－―ー‐−–—.:・\s]*){13})(?![0-9０-９])/g)){
   const digits=fixInvoiceDigits(m[1]);
   if(/^\d{13}$/.test(digits))candidates.push({value:'T'+digits,score:label?180:100});
  }
  if(label){
   // Only recover a missing 'T' when the receipt actually mentions a registration number.
   for(const value of combined.matchAll(/(?<![\d])((?:[0-9０-９ＯOo〇○ＩIl|ｌＳsＢbＺz][,－―ー‐−–—.:・\s]*){13})(?![0-9０-９])/g)){
    const digits=fixInvoiceDigits(value[1]);
    if(/^\d{13}$/.test(digits))candidates.push({value:'T'+digits,score:77});
   }
  }
 }
 return candidates.sort((a,b)=>b.score-a.score)[0]||null;
}
function findPayment(text){const t=normalizeText(text);const variants=[[/PayPay|ペイペイ|d払い|楽天ペイ|au\s*PAY|QR決済/i,'QR決済'],[/VISA|Master\s?Card|JCB|AMEX|クレジット|クレカ|カード決済|カード払い/i,'クレジットカード'],[/Suica|PASMO|ICOCA|交通系|電子マネー|nanaco|WAON|iD決済/i,'電子マネー'],[/デビット/i,'デビットカード'],[/銀行振込|振込先|振込明細/i,'銀行振込'],[/現\s*金|CASH/i,'現金']];for(const [r,value] of variants){if(r.test(t))return {value,score:60}}return null}
function findTaxRate(text){const t=normalizeText(text);if(/(?:10\s*%|10パーセント)/i.test(t)&&/(?:8\s*%|軽減)/i.test(t))return{value:'mixed',score:50};if(/10\s*%/.test(t))return{value:'10',score:45};if(/8\s*%|軽減税率/.test(t))return{value:'8',score:45};return null}
function suggestCategory(text){const t=normalizeText(text).toLowerCase();const rules=[[/駐車場|パーキング|駐車料金|タイムズ|リパーク/,'駐車場代'],[/ガソリン|軽油|ハイオク|レギュラー|apollostation|eneos|出光/,'ガソリン代'],[/高速料金|通行料金|etc\s*利用/,'高速道路料金'],[/タクシー|鉄道|交通費|電車|新幹線|乗車|バス乗車|切符/,'旅費交通費'],[/切手|郵送|送料|宅配|ヤマト運輸|佐川急便/,'荷造運賃'],[/携帯電話|インターネット料金|光回線|モバイル通信/,'通信費'],[/印刷|コピー代|コピ一代|コピー料金|複写代|コピー用紙|文房具|筆記具|事務用品/,'消耗品費'],[/書籍|参考書|新聞代/,'新聞図書費'],[/講習|研修参加|セミナー/,'研修費'],[/広告費|宣伝費/,'広告宣伝費']];for(const [re,val] of rules){if(re.test(t))return {value:val,score:40}}return null}

// v6: OCR extraction for toll-road, fuel, parking and ordinary receipts.
// Don't silently invent numbers. A missing/ambiguous result must be reviewed against the original.
function findDateV6(lines){
 const candidates=[];const patterns=[
  {re:/(20\d{2})\s*[年/\-.]\s*(\d{1,2})\s*[月/\-.]\s*(\d{1,2})\s*日?/g,kind:'full'},
  {re:/(?:令和|R)\s*(\d{1,2})\s*[年/\-.]\s*(\d{1,2})\s*[月/\-.]\s*(\d{1,2})\s*日?/gi,kind:'reiwa'},
  {re:/(?:^|\D)(\d{2})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{1,2})(?=\D|$)/g,kind:'short'},
  {re:/(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)/g,kind:'compact'}
 ];
 for(let i=0;i<lines.length;i++){
  const line=lines[i].replace(/(?<=\d)\s+(?=\d)/g,'').replace(/[年月日]\s+/g,m=>m.trim());
  for(const {re,kind} of patterns)for(const match of line.matchAll(re)){
   const y=kind==='reiwa'?2018+Number(match[1]):kind==='short'?2000+Number(match[1]):Number(match[1]);
   const m=Number(match[2]),d=Number(match[3]);if(!validDate(y,m,d))continue;
   let score=65;
   if(/(?:通行|利用|通過|給油|取引|購入|売上|領収|お買上|お買い上げ|発行|決済|出庫|入庫|精算|受付|日付|日時|DATE|受領)/i.test(line))score+=35;
   if(/(?:通行日|利用日|ご利用日|利用年月日|給油日|売上日|取引日|購入日)/.test(line))score+=26;
   if(/(?:発行|領収)/.test(line))score+=6;
   if(/(?:有効期限|使用期限|支払期限|請求期限|契約日|次回|前回|登録日|カード期限|印刷日|集計期間|対象期間)/.test(line))score-=100;
   if(i<18)score+=12; if(i>75)score-=8;
   const now=new Date(),date=new Date(y,m-1,d);if(date.getTime()>now.getTime()+86400000*4)score-=80;
   candidates.push({value:[y,String(m).padStart(2,'0'),String(d).padStart(2,'0')].join('-'),score,why:line});
  }
 }
 return candidates.filter(x=>x.score>20).sort((a,b)=>b.score-a.score)[0]||null;
}
// v11 — read fragmented dates even if the OCR inserts spaces or line breaks.
function findDateV11(lines){
 const original=findDateV6(lines), candidates=[];
 const cleaned=lines.map(line=>line.replace(/[ＯＯOｏo]/g,'0').replace(/(?<=\d)\s+(?=\d)/g,'')
   .replace(/(20\d{2})\s*[年]?\s*(?=[01][0-9]\s*月)/,'$1年'));
 for(let i=0;i<cleaned.length;i++){
  // Never concatenate arbitrary unrelated text. Require the date's four digit year.
  const joined=cleaned.slice(i,i+2).join('').replace(/[\s　]/g,'');
  const match=joined.match(/(?<!\d)(20\d{2})[年\/\-.]?(\d{1,2})[月\/\-.](\d{1,2})日?(?!\d)/);
  if(!match)continue;
  const year=+match[1],month=+match[2],day=+match[3];if(!validDate(year,month,day))continue;
  const value=[year,String(month).padStart(2,'0'),String(day).padStart(2,'0')].join('-');
  // A date printed twice is stronger evidence than a single uncertain pass.
  const score=62+(i<12?10:0)+(/日付|利用日|取引日|発行日|お買上/.test(joined)?24:0)
    + (cleaned.some((other,j)=>j!==i&&other.includes(`${year}年${month}月${day}日`))?18:0);
  candidates.push({value,score,why:joined.slice(0,80)});
 }
 candidates.sort((x,y)=>y.score-x.score);
 const fallback=candidates[0];
 if(!original)return fallback||null;
 if(!fallback||fallback.value===original.value)return original;
 // Date conflict: do not silently decide between two similarly plausible dates.
 return original.score>fallback.score+22?original:fallback.score>original.score+22?fallback:null;
}
function amountLineContext(line){
 const positive=/(?:総合計|ご請求(?:金額|額)|請求金額|お支払(?:い)?(?:金額|合計|額)|お買(?:い)?上(?:げ)?(?:金額|計|合計)|販売(?:金額|合計)|通行(?:料金|料)|利用(?:料金|金額|料|額)|精算(?:金額|額)|領収(?:金額|額)|料金合計|支払(?:総額|金額|額)|税込(?:合計|金額|総額)|合計(?:金額|額)?|現計|お会計|今回ご利用額|決済金額|TOTAL(?: AMOUNT)?|AMOUNT DUE|BALANCE DUE)/i;
 const negative=/(?:小計|税抜|税別|本体価格|単価|数量|ﾘｯﾄﾙ|リットル|給油量|給油数量|燃料油単価|お釣り?|おつり|釣銭|お預り|預り金|値引|割引|クーポン|ポイント|残高|消費税|内税|外税|税額|税率|登録番号|事業者番号|請求書番号|カード番号|車両番号|お客様番号|領収書NO|伝票番号|処理番号|認証番号|取引番号|管理番号|電話|TEL|FAX|受付番号|整理番号|有効期限|区間番号)/i;
 return {positive,negative};
}
function findAmountV6(lines){
 const {positive,negative}=amountLineContext();const candidates=[];
 for(let i=0;i<lines.length;i++){
  const line=lines[i];const isPositive=positive.test(line),isNegative=negative.test(line);
  const dateOrId=/(?:電話|TEL|登録番号|車両番号|カード番号|ETCカード|ICカード|会員番号|ナンバー|スタンド番号|レシート番号|領収番号|請求書番号|伝票番号|取引番号|認証番号|郵便番号)/i.test(line);
  if(dateOrId)continue;
  for(const token of numericValues(line)){
   const near=line.slice(Math.max(0,token.index-8),token.index+token.text.length+4);
   if(/\d\s*[%％]|(?:\d+(?:\.\d+)?\s*(?:L|ℓ|リットル|km|㎞|個|点|枚))\b/i.test(near))continue;
   let score=(token.yen?28:0)+(i<22?4:0);
   if(isPositive){score+=108;if(/(?:通行料金|通行料|販売金額|領収金額|精算金額|ご利用金額|お支払金額|支払総額|合計金額|合計)/i.test(line))score+=22;}
   if(isNegative)score-=isPositive?85:155;
   if(/(?:10\s*%|8\s*%|税率|内消費税|税額)/.test(line))score-=90;
   if(/(?:[0-9]{2,4}[:/.-][0-9]{1,2}|20\d{6})/.test(line)&&!token.yen)score-=80;
   if(token.value<10)score-=14;
   candidates.push({value:token.value,score,why:line});
  }
  if(isPositive&&!isNegative&&numericValues(line).length===0&&i+1<lines.length){
   const following=lines[i+1];if(!negative.test(following)&&!/(?:番号|カード|電話|TEL|日付|日時)/.test(following)){
    for(const token of numericValues(following))if(token.yen||/^[¥\d,\s円]+$/.test(following))candidates.push({value:token.value,score:116+(token.yen?15:0),why:line+' / '+following});
   }
  }
 }
 // Do not choose a bare unrelated number when no total/payment wording or yen mark exists.
 const best=candidates.sort((a,b)=>b.score-a.score||b.value-a.value)[0];return best&&best.score>=28?best:null;
}
function findTaxV6(lines,amount){
 const candidates=[];const taxWord=/(?:内(?:消費)?税(?:等|額)?|消費税(?:等|額)?|税額(?:合計)?|税合計|外税|税相当額|内訳\s*税)/i;
 for(let i=0;i<lines.length;i++){
  const line=lines[i];if(!taxWord.test(line))continue;
  if(/(?:登録番号|法人番号|消費税課税事業者|税務署)/.test(line))continue;
  const toks=numericValues(line);let found=false;
  for(const token of toks){
   if(amount!=null&&token.value>amount)continue;
   const after=line.slice(token.index+token.text.length,token.index+token.text.length+3);
   if(/[%％]/.test(after))continue;
   if(/(?:対象|課税対象|対象額|課税売上|商品代金)/.test(line)&&!/(?:内税|内消費税|税額)/.test(line))continue;
   const before=line.slice(0,token.index);
   if(!taxWord.test(before))continue;
   let score=100+(token.yen?19:0)+(line.includes('内消費税')?25:0);
   if(/(?:消費税額|税額合計|税合計)/.test(line))score+=17;
   if(/(?:対象額|課税対象)/.test(line))score-=12;
   if(amount>0){const ratio=token.value/amount;if(ratio>.14)score-=110;else if(ratio>.06&&ratio<.10)score+=12;}
   candidates.push({value:token.value,score,why:line});found=true;
  }
  if(!found&&i+1<lines.length&&!/(?:対象|課税対象)/.test(line)){
   const next=lines[i+1];if(/^[\s¥\\￥\d,円()（）-]+$/.test(next))for(const token of numericValues(next)){if(amount&&token.value>amount)continue;candidates.push({value:token.value,score:90+(token.yen?14:0),why:line+' / '+next})}
  }
 }
 const best=candidates.sort((a,b)=>b.score-a.score)[0];return best&&best.score>=45?best:null;
}
function findInvoiceV6(text){
 const t=normalizeText(text);const lines=t.split('\n').map(v=>v.trim()).filter(Boolean);
 const label=/(?:事業者.{0,8}登.{0,5}番|(?:適格)?請求書.{0,5}登録|(?:登録|登錄|事業者|適格請求書|インボイス).{0,7}(?:番号|NO|No)|登録番号)/i;
 const found=[];
 // This tolerates OCR spaces, hyphens and confusable O/0, I/1 in a 13-digit registration number.
 for(let i=0;i<lines.length;i++){
  const isLabel=label.test(lines[i]);const segment=isLabel?lines.slice(i,i+3).join(' '):lines[i];
  for(const m of segment.matchAll(/(?:[TＴtｔ丁〒])\s*[:：‐－-]?\s*((?:[0-9０-９ＯOo〇○ＩIl|ｌＳsＢbＺzＧg][,－―ー‐−–—.:・\s]*){13})(?![0-9０-９])/g)){
   const digits=fixInvoiceDigits(m[1]);if(!/^\d{13}$/.test(digits))continue;
   found.push({value:'T'+digits,score:(isLabel?195:125)+(i<18?9:0),why:lines[i]});
  }
  if(isLabel){
   for(const m of segment.matchAll(/(?<![\d])((?:[0-9０-９ＯOo〇○ＩIl|ｌＳsＢbＺzＧg][,－―ー‐−–—.:・\s]*){13})(?![0-9０-９])/g)){
    const digits=fixInvoiceDigits(m[1]);if(/^\d{13}$/.test(digits))found.push({value:'T'+digits,score:82+(i<18?9:0),why:lines[i]});
   }
  }
 }
 const ranked=found.sort((a,b)=>b.score-a.score);return ranked[0]||null;
}
function findStoreV11(lines){
 const original=findStoreV6(lines);
 const top=lines.slice(0,24).map(x=>String(x).normalize('NFKC'));
 const joined=top.join(' '),compact=condensedShopText(joined);
 const evidence=/(?:セ[ブプフ][ンソ].{0,6}イレ[ブプフ][ンソ]|7.?ELEVEN|SEVEN.?ELEVEN|セブン.{0,5}レブン)/i.test(compact);
 if(!evidence)return original;
 const branches=[];
 for(let i=0;i<Math.min(20,top.length);i++){
  const line=top[i].replace(/[ 　]/g,'');
  if(/(?:電話|TEL|事業者|登録|大阪府|市|〒|￥|¥|領収|10:|16:|2026年)/.test(line))continue;
  const match=line.match(/([一-龠々ぁ-んァ-ヶA-Za-z0-9ー]{2,28}店)/);
  if(match&&match[1].length<=28){
    let name=match[1].replace(/^.*?(?:イレブン|イレプン)/,'').replace(/^[-‐ー]/,'');
    if(name.length>=3 && !/(領収|商店|印刷|商品)/.test(name))branches.push({value:name,score:120-i});
  }
 }
 const shop=branches.sort((x,y)=>y.score-x.score)[0];
 const candidate={value:'セブン‐イレブン'+(shop?' '+shop.value:''),score:shop?205:155,why:joined.slice(0,80)};
 if(original&&original.value.startsWith('セブン‐イレブン')&&original.value.length>candidate.value.length)return original;
 return candidate;
}
function findStoreV6(lines){
 const base=findStore(lines);const known=[
  {pattern:/\b(?:NEXCO|ネクスコ)\s*(?:東日本|中日本|西日本)?\b/i,name:null},
  {pattern:/(?:阪神高速(?:道路)?(?:株式会社)?|首都高速(?:道路)?(?:株式会社)?|本州四国連絡高速(?:道路)?)/i,name:null},
  {pattern:/(?:ENEOS|エネオス|apollostation|アポロステーション|コスモ石油|キグナス石油|SOLATO|出光興産|JA-SS|シェル石油|セルフステーション)/i,name:null},
  {pattern:/(?:タイムズ(?:パーキング)?|Times(?: パーキング)?|三井のリパーク|NPC24H|名鉄協商|エコロパーク)/i,name:null},
  {pattern:/(?:セブン[‐\-ー・ ]?イレブン|ローソン|ファミリーマート|ミニストップ|デイリーヤマザキ)/i,name:null}
 ];
 const ranked=[];
 for(let i=0;i<Math.min(lines.length,28);i++){
  const v=lines[i].trim();
  for(const {pattern,name} of known){const m=v.match(pattern);if(!m)continue;
   const value=v.length<54&&!/(?:〒|TEL|電話|登録番号|¥|お支払|金額|年\d+月)/.test(v)?v:name||m[0];
   ranked.push({value,score:135-i*.5,why:v});
  }
 }
 const knownShop=ranked.sort((a,b)=>b.score-a.score)[0]||null;
 return base&&(base.score>=100||!knownShop)?base:knownShop;
}
function suggestCategoryV6(text){
 const t=normalizeText(text);
 // Prefer purpose words over shop names; ENEOS can appear on a convenience store advertisement.
 const rules=[
  [/(?:通行料金|通行料|高速道路|高速料金|ETC\s*利用|NEXCO|阪神高速|首都高速|料金所|入口IC|出口IC|通行証明)/i,'高速道路料金'],
  [/(?:ガソリン|軽油|レギュラー|ハイオク|給油|油種|燃料油|燃料代|ENEOS|エネオス|apollostation|コスモ石油|キグナス|JA-SS|SOLATO)/i,'ガソリン代'],
  [/(?:駐車料金|駐車代|駐車場|パーキング|タイムズ|リパーク|駐車券|出庫精算)/i,'駐車場代']
 ];
 for(const [re,value] of rules)if(re.test(t))return {value,score:74};
 return suggestCategory(t);
}
function parseReceipt(text){const normalized=normalizeText(text);const lines=normalized.split(/\n/).map(x=>x.replace(/\s+/g,' ').trim()).filter(Boolean);
 const total=findAmountV6(lines),tax=findTaxV6(lines,total?.value);
 const fields={date:findDateV11(lines),amount:total,store:findStoreV11(lines),taxAmount:tax,invoiceNo:findInvoiceV6(normalized),payment:findPayment(normalized),taxRate:findTaxRate(normalized),category:suggestCategoryV6(normalized)};
 if(fields.taxAmount&&fields.amount){
  const tax=fields.taxAmount.value,total=fields.amount.value;
  if(tax>total||tax<total*.0005||tax>total*.12)fields.taxAmount=null;
  else if(!fields.taxRate){const ten=total*10/110,eight=total*8/108;
   if(Math.abs(tax-ten)<=Math.max(1,total*.0015))fields.taxRate={value:'10',score:30};
   else if(Math.abs(tax-eight)<=Math.max(1,total*.0012))fields.taxRate={value:'8',score:30};}
 }
 return {fields,raw:normalized};
}
function mergeFields(one,two){const data={};for(const field of ['date','amount','store','taxAmount','invoiceNo','payment','taxRate','category']){
 const a=one?.fields[field],b=two?.fields[field];
 if(a&&b&&a.value!==b.value&&['invoiceNo','amount','date'].includes(field)&&Math.abs(a.score-b.score)<16){data[field]=null;continue;}
 data[field]=a&&b?(a.score>=b.score?a:b):(a||b||null);
 }return data}
$('ocr').onclick=async()=>{
 if(!selectedFile){notice('先に領収書の写真を選んでください');return}
 const btn=$('ocr');btn.disabled=true;btn.textContent='解析中…';let worker;
 let pages=[];
 try{
  const img=await decodeImage(selectedFile),rotation=Number($('rotation').value)||0;
  // Prefer explicit receipt-region crop over full background.
  const manuallyCropped=cropImageSource(img,cropBox);
  const trimmed=(!cropBox&&$('autoTrim').checked)?autoTrimReceiptSource(manuallyCropped):manuallyCropped;
  const source=(!cropBox&&$('autoTrim').checked&&rotation%180===0)?autoCropHorizontalReceiptSource(trimmed):trimmed;
  pages=canvasPagesForOcr(source,rotation);
  notice('文字認識の準備をしています…');
  if(!window.Tesseract)await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
  worker=await Tesseract.createWorker('jpn+eng',1,{logger:msg=>{if(msg.status==='recognizing text')notice(`文字認識中：${Math.round(msg.progress*100)}%\n完了後、金額・日付・店名を確認してね。`)}});
  await worker.setParameters({preserve_interword_spaces:'1',tessedit_pageseg_mode:'11'});
  const rawOne=[];
  for(let i=0;i<pages.length;i++){
   notice(`領収書の文字を読み取り中（${i+1}/${pages.length}）…`);
   rawOne.push((await worker.recognize(pages[i])).data.text);
  }
  const first=parseReceipt(rawOne.join('\n'));
  let second=null;
  if($('ocrMode').value==='high'){
   await worker.setParameters({tessedit_pageseg_mode:'6'});
   const rawTwo=[];
   for(let i=0;i<pages.length;i++){
    notice(`補正した画像を再解析中（${i+1}/${pages.length}）…`);
    const enhanced=enhancedCanvas(pages[i]);rawTwo.push((await worker.recognize(enhanced)).data.text);
    enhanced.width=0;enhanced.height=0;
   }
   second=parseReceipt(rawTwo.join('\n'));
  }
  let data=mergeFields(first,second),third=null,fourth=null;
  if($('ocrMode').value==='high'&&(!data.store||!data.invoiceNo||!data.date)){
   notice('領収書の上部（店名・T番号）を拡大しています…');
   const upper=focusedCanvasForOcr(source,rotation,0,.46);
   try{
    await worker.setParameters({tessedit_pageseg_mode:'6'});
    third=parseReceipt((await worker.recognize(upper)).data.text);
    for(const key of ['store','invoiceNo'])if(third.fields[key]&&(!data[key]||third.fields[key].score>data[key].score+25))data[key]=third.fields[key];
    if(!data.date&&third.fields.date)data.date=third.fields.date;
   }finally{upper.width=0;upper.height=0}
  }
  if($('ocrMode').value==='high'&&!data.date){
   notice('領収書の下部（日付）を拡大しています…');
   const lower=focusedCanvasForOcr(source,rotation,.43,.95);
   try{
    await worker.setParameters({tessedit_pageseg_mode:'6'});
    fourth=parseReceipt((await worker.recognize(lower)).data.text);
    if(fourth.fields.date)data.date=fourth.fields.date;
   }finally{lower.width=0;lower.height=0}
  }
  let fifth=null;
  if($('ocrMode').value==='high'&&(!data.store||!data.invoiceNo||!data.taxAmount)){
   notice('領収証の中央〜下部（店名・税額・T番号）を拡大して確認中…');
   const middle=focusedCanvasForOcr(source,rotation,.18,.98);
   try{
    await worker.setParameters({tessedit_pageseg_mode:'6'});
    fifth=parseReceipt((await worker.recognize(middle)).data.text);
    for(const key of ['store','invoiceNo','taxAmount']){
     const v=fifth.fields[key];if(v&&(!data[key]||v.score>data[key].score+25))data[key]=v;
    }
   }finally{middle.width=0;middle.height=0}
  }
  // Never allow the initial value (today) or a previous scan's values to masquerade as OCR results.
  for(const key of ['date','amount','store','taxAmount','invoiceNo'])$(key).value=data[key]?.value??'';
  if(data.invoiceNo)$('invoiceNo').value=normalizeInvoiceInput(data.invoiceNo.value);
  for(const key of ['payment','taxRate'])$(key).value=data[key]?.value??(key==='payment'?'未設定':'');
  $('category').value=suggestVendorCategory(data.store?.value)||data.category?.value||'未分類';
  $('receiptType').value=guessReceiptType(first.raw+' '+(second?.raw||''));
  $('reviewed').checked=false;$('invoiceVerified').checked=false;lastOcrData=data;renderOcrEvidence(data);
  if(/(?:コピー代|コピ一代|コピー料金|複写代)/.test((first.raw||'')+' '+(second?.raw||'')+' '+(third?.raw||'')))$('detail').value='コピー代';
  else $('detail').value='';
  $('ocrText').textContent=first.raw+(second?'\n\n===== 補正画像の認識結果 =====\n'+second.raw:'')+(third?'\n\n===== 上部の再解析 =====\n'+third.raw:'')+(fourth?'\n\n===== 下部の日付の再解析 =====\n'+fourth.raw:'')+(fifth?'\n\n===== 中央〜下部の再解析 =====\n'+fifth.raw:'');
  updateBusinessEstimate();
  const missing=[];if(!data.date)missing.push('日付');if(!data.amount)missing.push('金額');if(!data.store)missing.push('店名');
  if(!data.invoiceNo||!data.taxAmount)showSaveStatus('T番号や消費税額を認識できなかったときは空欄のままです。高速道路・ガソリン等でも原本と照合して保存してね。','info');
  const unresolved=missing.length?'未認識または判定が一致しない項目：'+missing.join('・')+'。':'主要3項目を入力しました。';
  const help=!cropBox?'\n背景が多い写真は「領収書だけを囲んで読み取る」を使うと改善することがあります。':'';
  notice('読み取り完了。'+unresolved+help+'\n日付が取れない場合は空欄にしています。間違った値がないか原本で確認してね。');
 }catch(e){notice('読み取りできませんでした：'+(e.message||e)+'\n写真を明るく撮る・領収書部分を囲む・手入力を試してください。')}
 finally{for(const page of pages){page.width=0;page.height=0}if(worker)try{await worker.terminate()}catch{}btn.disabled=false;btn.textContent='🔍 写真から自動入力'}
};
function filtered(){const month=$('month').value,period=$('period').value,c=$('filter').value;return all.filter(x=>{const date=String(x.date||'');const inPeriod=period==='all'||(period==='year'?date.startsWith(month.slice(0,4)):date.startsWith(month));return inPeriod&&(!c||x.category===c)&&advancedReceiptFilter(x)}).sort((a,b)=>String(b.date).localeCompare(String(a.date)))}
function render(){const rows=filtered();const paid=rows.reduce((n,x)=>n+Number(x.amount||0),0),expensed=rows.reduce((n,x)=>n+businessAmount(x.amount,x.businessRate==null?100:x.businessRate),0);
 $('total').textContent=money(expensed);$('totalPaid').textContent='支払総額 '+money(paid);$('count').textContent=rows.length+'枚';
 $('totalLabel').textContent=($('period').value==='all'?'全期間':$('period').value==='year'?'選択年':'表示月')+'の経費';
 const grouped={};for(const x of rows)grouped[x.category||'未分類']=(grouped[x.category||'未分類']||0)+businessAmount(x.amount,x.businessRate==null?100:x.businessRate);
 $('breakdown').replaceChildren();if(!rows.length)$('breakdown').textContent='この期間の領収書はありません';
 for(const [category,sum] of Object.entries(grouped).sort((a,b)=>b[1]-a[1])){
  const title=document.createElement('div');title.textContent=category+'：'+money(sum);const bar=document.createElement('div');bar.className='bar';const fill=document.createElement('span');fill.style.width=(expensed?100*sum/expensed:0)+'%';bar.append(fill);$('breakdown').append(title,bar)
 }
 $('entries').replaceChildren();for(const x of rows){const row=document.createElement('div');row.className='entry';
  const img=document.createElement('img');img.alt='領収書の画像';if(x.photo){img.src=x.photo;img.onclick=()=>window.open(x.photo,'_blank')}else img.className='hidden';
  const main=document.createElement('main'),name=document.createElement('b'),meta=document.createElement('div');name.textContent=x.store||'支払先なし';meta.className='meta';meta.textContent=`${x.date} ・ ${x.category||'未分類'}${x.detail?' ・ '+x.detail:''}${x.payment&&x.payment!=='未設定'?' ・ '+x.payment:''}`;main.append(name,meta);
  const right=document.createElement('div'),amount=document.createElement('div'),action=document.createElement('div');amount.className='amount';amount.textContent=money(businessAmount(x.amount,x.businessRate==null?100:x.businessRate));
  if(x.businessRate!=null&&Number(x.businessRate)!==100){const sm=document.createElement('small');sm.textContent='支払 '+money(x.amount);amount.append(sm)}
  action.className='miniActions';const edit=document.createElement('button');edit.className='secondary';edit.textContent='編集';edit.onclick=()=>editReceipt(x);
  const del=document.createElement('button');del.className='danger';del.textContent='削除';del.onclick=async()=>{if(confirm('この領収書を削除してよいですか？')){await deleteItem(x.id);await refresh()}};action.append(edit,del);right.append(amount,action);row.append(img,main,right);$('entries').append(row)
 }
 renderAdvancedDashboard(rows);updateBackupReminder();
}
function editReceipt(x){editId=x.id;lastOcrData=null;batchActiveIndex=null;selectedFile=null;resetCrop();if(selectedUrl)URL.revokeObjectURL(selectedUrl);selectedUrl=null;$('photo').value='';for(const key of ['date','amount','store','detail','category','payment','taxRate','taxAmount','invoiceNo','memo']){
 if($(key))$(key).value=x[key]??(key==='payment'?'未設定':'')}
 $('businessRate').value=x.businessRate==null?100:x.businessRate;$('receiptType').value=x.receiptType||'その他';$('invoiceVerified').checked=Boolean(x.invoiceVerified);$('reviewed').checked=Boolean(x.reviewed);$('ocrEvidence').replaceChildren();setPreview(x.photo||null);$('save').textContent='💾 変更を保存する';updateBusinessEstimate();window.scrollTo({top:0,behavior:'smooth'});notice('編集中です。写真を変更しなければ元の領収書画像は維持されます')}
$('save').onclick=async()=>{
 const btn=$('save');clearSaveStatus();
 if(!db){showSaveStatus('この端末で保存用データベースが利用できません。Safariの通常モードで開いてね。');return}
 const date=$field('date'),amountRaw=$field('amount'),amount=Number(amountRaw),store=$field('store'),rateRaw=$field('businessRate'),rate=Number(rateRaw);
 if(!date){showSaveStatus('保存できません：日付が空欄です。領収書の日付を入力してね。','error','date');return}
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)){showSaveStatus('保存できません：日付が正しくありません。','error','date');return}
 if(amountRaw===''||!Number.isFinite(amount)||amount<=0||!Number.isSafeInteger(amount)){showSaveStatus('保存できません：支払総額を1円以上の整数で入力してね。','error','amount');return}
 if(rateRaw===''||!Number.isFinite(rate)||rate<0||rate>100){showSaveStatus('保存できません：事業使用割合は0～100%で入力してね。','error','businessRate');return}
 let taxAmount=$field('taxAmount')===''?null:Number($field('taxAmount'));
 if(taxAmount!==null&&(!Number.isFinite(taxAmount)||!Number.isSafeInteger(taxAmount)||taxAmount<0||taxAmount>amount)){showSaveStatus('保存できません：消費税額が正しいか確認してね。','error','taxAmount');return}
 const invoiceNo=normalizeInvoiceInput($field('invoiceNo'));
 if(invoiceNo&&!/^T\d{13}$/.test(invoiceNo)){showSaveStatus('保存できません：T番号は「T＋13桁の数字」で入力してね。数字だけ13桁でもOKだよ。','error','invoiceNo');return}
 $('invoiceNo').value=invoiceNo;
 const original=editId?all.find(x=>x.id===editId):null;
 const photoHash=selectedFile?await digestPhoto(selectedFile):null;
 const same=all.find(x=>x.id!==editId&&x.date===date&&Number(x.amount)===amount&&(x.store||'').trim().toLowerCase()===store.toLowerCase());
 const exact=photoHash&&all.find(x=>x.id!==editId&&x.imageHash===photoHash);
 if((same||exact)&&!confirm((exact?'同一の写真が既に登録されています。':'日付・店名・金額が一致する領収書が登録済みです。')+'重複して保存しますか？')){showSaveStatus('重複のため保存を中止しました。','info');return}
 btn.disabled=true;btn.textContent='💾 保存しています…';showSaveStatus('写真と入力内容を端末内に保存しています…','info');
 try{
  const photo=selectedFile?await compactPhoto(selectedFile):(original?.photo||null);
  const receipt={id:editId||(crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2)),date,amount,store,detail:$field('detail'),category:$field('category')||'未分類',payment:$field('payment')||'未設定',taxRate:$field('taxRate'),taxAmount,businessRate:rate,invoiceNo,memo:$field('memo'),photo,createdAt:original?.createdAt||new Date().toISOString(),
      receiptType:$field('receiptType')||'その他',reviewed:$('reviewed').checked,invoiceVerified:!!(invoiceNo&&$('invoiceVerified').checked),invoiceVerifiedAt:invoiceNo&&$('invoiceVerified').checked?(original?.invoiceNo===invoiceNo&&original?.invoiceVerifiedAt?original.invoiceVerifiedAt:new Date().toISOString()):null,
      imageHash:photoHash||original?.imageHash||null,ocrConfidence:lastOcrData?confidenceSummary(lastOcrData):original?.ocrConfidence||null,updatedAt:new Date().toISOString(),history:editId?[...(original?.history||[]).slice(-19),{at:new Date().toISOString(),action:'編集',oldAmount:original?.amount,oldCategory:original?.category}]:original?.history||[]};
      if($('learnVendor').checked&&store)learnVendorCategory(store,receipt.category);
      const savedBatch=batchActiveIndex;
  await saveItem(receipt);
  $('month').value=date.slice(0,7);$('period').value='month';$('filter').value='';resetForm();
  await refresh(); if(savedBatch!=null)markBatchDone(savedBatch);updateBackupReminder();
  showSaveStatus('✅ 保存できたよ！ 下の「保存した領収書」に登録されました。','success');
  notice('保存しました！');
 }catch(e){
  const message=String(e?.message||e||'不明なエラー');
  showSaveStatus('保存できませんでした。iPhoneの空き容量、プライベートブラウズの使用、端末ストレージの制限を確認してね。\n詳細：'+message,'error');
  notice('保存に失敗しました：'+message);
 }finally{btn.disabled=false;btn.textContent=editId?'💾 変更を保存する':'💾 領収書を保存する'}
};
$('month').addEventListener('change',render);$('period').addEventListener('change',render);$('filter').addEventListener('change',render);
function exportRows(){const headers=['日付','店名・支払先','内容','領収書種類','経費科目','支払方法','支払総額(税込円)','税率','消費税額(円)','事業使用割合(%)','経費計上額(円)','適格請求書番号','番号確認済み(手動)','原本確認済み','OCR信頼度(参考)','メモ','登録日時','更新日時'];const data=filtered().map(x=>[x.date,x.store||'',x.detail||'',x.receiptType||'',x.category||'未分類',x.payment||'未設定',Number(x.amount||0),x.taxRate||'',x.taxAmount??'',x.businessRate??100,businessAmount(x.amount,x.businessRate==null?100:x.businessRate),x.invoiceNo||'',x.invoiceVerified?'はい':'未確認',x.reviewed?'はい':'未確認',x.ocrConfidence||'',x.memo||'',x.createdAt||'',x.updatedAt||'']);return [headers,...data]}
function exportName(ext){const t=$('period').value;return `領収書_${t==='all'?'全期間':t==='year'?$('month').value.slice(0,4)+'年':$('month').value}.${ext}`}
function download(blob,filename){const u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),25000)}
const csvEscape=value=>{let s=String(value??'');if(/^[\s]*[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"'};
$('csv').onclick=()=>{const text='\ufeff'+exportRows().map(r=>r.map(csvEscape).join(',')).join('\r\n');download(new Blob([text],{type:'text/csv;charset=utf-8'}),exportName('csv'))};
$('xlsx').onclick=async()=>{try{notice('Excel出力の準備中…');if(!window.XLSX)await loadScript('https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js');const ws=XLSX.utils.aoa_to_sheet(exportRows());ws['!cols']=exportRows()[0].map(()=>({wch:20}));const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'経費一覧');XLSX.writeFile(wb,exportName('xlsx'));notice('Excelファイルを出力しました。ダウンロード先を確認してください')}
 catch(e){notice('Excelの出力に失敗しました。CSV出力なら追加ライブラリなしで使えます：'+e.message)}};
$('backup').onclick=()=>{const payload={version:10,createdAt:new Date().toISOString(),customCategories:getCustomCategories(),vendorRules:getVendorRules(),receipts:all};download(new Blob([JSON.stringify(payload)],{type:'application/json'}),`領収書バックアップ_${localDate()}.json`);localStorage.setItem('receipt-last-backup-v10',JSON.stringify({time:Date.now(),count:all.length}));updateBackupReminder();notice('バックアップファイルの保存先を確認してね。自動でクラウドには送られません。')};
$('restore').onclick=()=>$('restoreFile').click();$('restoreFile').onchange=async event=>{
 try{const file=event.target.files?.[0];if(!file)return;const data=JSON.parse(await file.text());if(!Array.isArray(data.receipts))throw Error('レシート帳のバックアップ形式ではありません');
 if(!confirm(`${data.receipts.length}件を復元します。同じIDのデータは上書きされます。よいですか？`))return;
 if(Array.isArray(data.customCategories))try{localStorage.setItem(CATEGORY_KEY,JSON.stringify(data.customCategories.filter(x=>typeof x==='string'&&x.length<=30)))}catch{}
 if(data.vendorRules&&typeof data.vendorRules==='object')try{localStorage.setItem('receipt-vendor-categories-v10',JSON.stringify(data.vendorRules))}catch{}
 for(const x of data.receipts){if(!x||typeof x.id!=='string'||typeof x.date!=='string'||!/^20\d{2}-\d{2}-\d{2}$/.test(x.date)||!Number.isFinite(Number(x.amount)))continue;await saveItem({...x,category:x.category||'未分類',businessRate:x.businessRate??100});}
 await refresh();notice('バックアップを復元しました')
 }catch(e){notice('復元できませんでした：'+e.message)}finally{event.target.value=''}
};
(async()=>{try{$('date').value=localDate();$('month').value=localDate().slice(0,7);db=await openDb();await refresh();updateBusinessEstimate();
 if('serviceWorker'in navigator&&location.protocol.startsWith('http'))navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'}).catch(()=>{});
 }catch(e){notice('端末内データベースを使用できません：'+e.message+'\nSafariの通常モードから開いてください')}})();
