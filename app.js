'use strict';
/* レシート帳 v2 — local-first, no receipt upload to a server. */
const $=id=>document.getElementById(id);
let db, all=[], selectedFile=null, selectedUrl=null, editId=null;
const DEFAULT_CATEGORIES=['未分類','消耗品費','旅費交通費','通信費','車両費','駐車場代','ガソリン代','高速道路料金','会議費','接待交際費','広告宣伝費','新聞図書費','水道光熱費','地代家賃','支払手数料','保険料','租税公課','修繕費','外注工賃','仕入高','荷造運賃','研修費','諸会費','福利厚生費','減価償却費','雑費','その他'];
const CATEGORY_KEY='receipt-ledger-custom-categories-v2';
const $field=id=>($(id).value||'').trim();
const localDate=()=>{const d=new Date();return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-')};
const money=n=>'¥'+Number(n||0).toLocaleString('ja-JP');
const notice=s=>{$('notice').style.display='block';$('notice').textContent=s};
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
function canvasForImage(img,rotation){let w=img.naturalWidth,h=img.naturalHeight;const s=Math.min(2,2600/Math.max(w,h),Math.max(1,1200/Math.min(w,h)));const cw=Math.max(1,Math.round(w*s)),ch=Math.max(1,Math.round(h*s));const rotated=rotation%180!==0;const c=document.createElement('canvas');c.width=rotated?ch:cw;c.height=rotated?cw:ch;const ctx=c.getContext('2d',{willReadFrequently:true});ctx.save();ctx.translate(c.width/2,c.height/2);ctx.rotate(rotation*Math.PI/180);ctx.drawImage(img,-cw/2,-ch/2,cw,ch);ctx.restore();return c}
function canvasPagesForOcr(img,rotation){
 // Very long receipts become unreadable when the whole image is shrunk to a small width.
 // Read such photos in overlapping, full-resolution bands instead.
 const w=img.naturalWidth,h=img.naturalHeight;
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
function enhancedCanvas(original){const c=document.createElement('canvas');c.width=original.width;c.height=original.height;const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(original,0,0);const im=ctx.getImageData(0,0,c.width,c.height),p=im.data;
 const hist=new Uint32Array(256);for(let i=0;i<p.length;i+=4*9){hist[clamp(Math.round(p[i]*.299+p[i+1]*.587+p[i+2]*.114),0,255)]++}
 const total=hist.reduce((a,b)=>a+b,0);let cumulative=0,lo=0,hi=255;for(let k=0;k<256;k++){cumulative+=hist[k];if(cumulative>=total*.03){lo=k;break}}
 cumulative=0;for(let k=0;k<256;k++){cumulative+=hist[k];if(cumulative>=total*.98){hi=k;break}}const scale=255/Math.max(90,hi-lo);
 for(let i=0;i<p.length;i+=4){const g=p[i]*.299+p[i+1]*.587+p[i+2]*.114;const x=clamp(Math.round((g-lo)*scale),0,255);p[i]=x;p[i+1]=x;p[i+2]=x;p[i+3]=255}
 ctx.putImageData(im,0,0);return c}
function canvasToDataUrl(c){try{return c.toDataURL('image/jpeg',.79)}catch{return null}}
async function compactPhoto(file){try{const img=await decodeImage(file);const s=img.naturalHeight/img.naturalWidth>2.8?Math.min(1,6500/img.naturalHeight):Math.min(1,2200/Math.max(img.naturalWidth,img.naturalHeight));const c=document.createElement('canvas');c.width=Math.max(1,Math.round(img.naturalWidth*s));c.height=Math.max(1,Math.round(img.naturalHeight*s));c.getContext('2d').drawImage(img,0,0,c.width,c.height);return canvasToDataUrl(c)||await toDataUrl(file)}catch{return await toDataUrl(file)}}
function setPreview(url){$('preview').style.display=url?'block':'none';if(url)$('preview').src=url;else $('preview').removeAttribute('src')}
$('photo').addEventListener('change',e=>{if(selectedUrl)URL.revokeObjectURL(selectedUrl);selectedFile=e.target.files[0]||null;selectedUrl=selectedFile?URL.createObjectURL(selectedFile):null;setPreview(selectedUrl)});
function resetForm(){selectedFile=null;editId=null;if(selectedUrl)URL.revokeObjectURL(selectedUrl);selectedUrl=null;$('photo').value='';setPreview(null);$('date').value=localDate();$('amount').value='';$('store').value='';$('detail').value='';$('category').value='未分類';$('payment').value='未設定';$('taxRate').value='';$('taxAmount').value='';$('businessRate').value='100';$('invoiceNo').value='';$('memo').value='';$('rotation').value='0';$('ocrText').textContent='まだ解析していません。';$('save').textContent='💾 領収書を保存する';updateBusinessEstimate()}
$('clear').onclick=()=>{resetForm();notice('入力をクリアしました')};
function updateBusinessEstimate(){let v=Number($('businessRate').value);if(!Number.isFinite(v))v=100;v=clamp(v,0,100);$('businessAmount').textContent=`経費計上の目安：${money(businessAmount($('amount').value,v))}（事業使用割合${v}%）`}
$('amount').addEventListener('input',updateBusinessEstimate);$('businessRate').addEventListener('input',updateBusinessEstimate);
$('addCategory').onclick=()=>{const value=$field('customCategory');if(!value){notice('追加する科目名を入力してください');return}const vals=getCustomCategories();if(!currentCategories().includes(value)){vals.push(value);try{localStorage.setItem(CATEGORY_KEY,JSON.stringify(vals))}catch{notice('科目を保存できませんでした')}}fillCategories();$('category').value=value;$('customCategory').value='';notice(`「${value}」を経費科目に追加しました`)};

// Receipt parser — context-weighted extraction to avoid mixing up tax, change and total.
const normalizeText=t=>String(t||'').normalize('NFKC').replace(/[￥﹩]/g,'¥').replace(/(?<=\d)[.．](?=\d{3}(?:\D|$))/g,',').replace(/\r/g,'');
function validDate(year,month,day){const d=new Date(year,month-1,day);return d.getFullYear()===year&&d.getMonth()===month-1&&d.getDate()===day&&year>=2000&&year<=2100}
function findDate(lines){const now=new Date();const list=[];for(let i=0;i<lines.length;i++){
 let s=lines[i];const dateLabel=/(領収日|発行日|購入日|取引日|お買い上げ日|お買上日|利用日|売上日|日時|DATE|購入日時)/i.test(s);
 const patterns=[{r:/(20\d{2})\s*[年/\-.]\s*(\d{1,2})\s*[月/\-.]\s*(\d{1,2})\s*日?/g,type:'full'},
 {r:/(?:令和|R)\s*(\d{1,2})\s*[年/\-.]\s*(\d{1,2})\s*[月/\-.]\s*(\d{1,2})/gi,type:'reiwa'},
 {r:/(?:^|\D)(\d{2})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{1,2})(?=\D|$)/g,type:'short'},
 {r:/(20\d{2})(\d{2})(\d{2})(?!\d)/g,type:'compact'}];
 for(const {r,type} of patterns){for(const m of s.matchAll(r)){const year=type==='reiwa'?2018+Number(m[1]):type==='short'?2000+Number(m[1]):Number(m[1]),month=Number(m[2]),day=Number(m[3]);if(!validDate(year,month,day))continue;const d=new Date(year,month-1,day);const diff=Math.abs((now-d)/(86400000));let score=50+(dateLabel?30:0)+(i<8?12:0)-Math.min(diff/365,15);if(d>new Date(now.getTime()+3*86400000))score-=25;list.push({value:`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`,score})}}
 }return list.sort((a,b)=>b.score-a.score)[0]||null}
function numericValues(s){const out=[];const reg=/([¥]?\s*(?:\d{1,3}(?:,\d{3})+|\d{2,9})\s*円?)/g;for(const m of s.matchAll(reg)){
 const chunk=m[1].replace(/\s/g,'');const n=Number(chunk.replace(/[¥円,]/g,''));if(Number.isFinite(n)&&n>=1&&n<=99999999)out.push({value:n,text:chunk,yen:/[¥円]/.test(chunk),index:m.index||0})}return out}
function findAmount(lines){const candidates=[];
 const good=/(総合計|お支払合計|お支払い合計|税込合計|合計金額|領収金額|ご請求額|お買上金額|ご利用金額|お支払金額|今回ご利用額|お買上計|お買い上げ計|現計|合\s*計|TOTAL|AMOUNT\s*DUE)/i;
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
function findStore(lines){const banned=/(領収書|レシート|お買上|お買い上げ|売上票|RECEIPT|明細|消費税|登録番号|インボイス|合計|小計|電話|TEL|FAX|〒|税抜|税込|¥|\d{2,}[,]\d{3}|ポイント|ご利用|お問い合わせ|いつも|ありがとう|カード|会員|現金|お釣|NO[.:])/i;
 const candidates=[];lines.slice(0,12).forEach((line,i)=>{let x=line.replace(/^[*#●\s]+/,'').replace(/\s+/g,' ').trim();if(x.length<2||x.length>60||banned.test(x)||/^\d/.test(x)||/\d{2}[:/.-]\d{2}/.test(x)||/^https?:/i.test(x))return;const kana=(x.match(/[ぁ-んァ-ヶ一-龥a-zA-Z]/g)||[]).length;const ratio=kana/x.length;if(ratio<.5)return;const score=45-i*5+(x.length>=4&&x.length<=28?12:0)+(/(株式会社|有限会社|店|ストア|商店|薬局|スーパー|マーケット|カフェ|駐車場|石油)/.test(x)?12:0)-(/^(住所|大阪|東京都|都道府県)/.test(x)?8:0);candidates.push({value:x,score})});return candidates.sort((a,b)=>b.score-a.score)[0]||null}
function findTax(lines){const cand=[];for(let i=0;i<lines.length;i++){const line=lines[i];if(!/(消費税額|内消費税|消費税|税額|内税)/.test(line)||/(税率|税率別)/.test(line)&&!/(消費税額|税額)/.test(line))continue;const v=numericValues(line).filter(x=>x.value>=1);for(const n of v)cand.push({value:n.value,score:(/(消費税額|内消費税|税額)/.test(line)?80:50)+(n.yen?8:0)-i});}
 if(cand.length>=2){
  const values=[...new Set(cand.map(x=>x.value))];
  // Multiple tax-rate breakdowns: add clearly distinct tax amounts, but let the user verify.
  if(values.length===2&&values.every(v=>v<1000000))return {value:values[0]+values[1],score:53};
 }
 return cand.sort((a,b)=>b.score-a.score)[0]||null}
function findInvoice(text){const match=normalizeText(text).replace(/\s/g,'').match(/T\s*\d{13}(?!\d)/i);return match?{value:match[0].toUpperCase(),score:92}:null}
function findPayment(text){const t=normalizeText(text);const variants=[[/PayPay|ペイペイ|d払い|楽天ペイ|au\s*PAY|QR決済/i,'QR決済'],[/VISA|Master\s?Card|JCB|AMEX|クレジット|クレカ|カード決済|カード払い/i,'クレジットカード'],[/Suica|PASMO|ICOCA|交通系|電子マネー|nanaco|WAON|iD決済/i,'電子マネー'],[/デビット/i,'デビットカード'],[/銀行振込|振込先|振込明細/i,'銀行振込'],[/現\s*金|CASH/i,'現金']];for(const [r,value] of variants){if(r.test(t))return {value,score:60}}return null}
function findTaxRate(text){const t=normalizeText(text);if(/(?:10\s*%|10パーセント)/i.test(t)&&/(?:8\s*%|軽減)/i.test(t))return{value:'mixed',score:50};if(/10\s*%/.test(t))return{value:'10',score:45};if(/8\s*%|軽減税率/.test(t))return{value:'8',score:45};return null}
function suggestCategory(text){const t=normalizeText(text).toLowerCase();const rules=[[/駐車場|パーキング|駐車料金|タイムズ|リパーク/,'駐車場代'],[/ガソリン|軽油|ハイオク|レギュラー|apollostation|eneos|出光/,'ガソリン代'],[/高速料金|通行料金|etc\s*利用/,'高速道路料金'],[/タクシー|鉄道|交通費|電車|新幹線|乗車|バス乗車|切符/,'旅費交通費'],[/切手|郵送|送料|宅配|ヤマト運輸|佐川急便/,'荷造運賃'],[/携帯電話|インターネット料金|光回線|モバイル通信/,'通信費'],[/印刷|コピー用紙|文房具|筆記具|事務用品/,'消耗品費'],[/書籍|参考書|新聞代/,'新聞図書費'],[/講習|研修参加|セミナー/,'研修費'],[/広告費|宣伝費/,'広告宣伝費']];for(const [re,val] of rules){if(re.test(t))return {value:val,score:40}}return null}
function parseReceipt(text){const normalized=normalizeText(text);const lines=normalized.split(/\n/).map(x=>x.replace(/\s+/g,' ').trim()).filter(Boolean);
 const fields={date:findDate(lines),amount:findAmount(lines),store:findStore(lines),taxAmount:findTax(lines),invoiceNo:findInvoice(normalized),payment:findPayment(normalized),taxRate:findTaxRate(normalized),category:suggestCategory(normalized)};
 if(fields.taxAmount&&fields.amount&&fields.taxAmount.value>fields.amount.value)fields.taxAmount=null;
 return {fields,raw:normalized};}
function mergeFields(one,two){const data={};for(const field of ['date','amount','store','taxAmount','invoiceNo','payment','taxRate','category']){
 const a=one?.fields[field],b=two?.fields[field];data[field]=a&&b?(a.score>=b.score?a:b):(a||b||null)}return data}
$('ocr').onclick=async()=>{
 if(!selectedFile){notice('先に領収書の写真を選んでください');return}
 const btn=$('ocr');btn.disabled=true;btn.textContent='解析中…';let worker;
 try{
  const img=await decodeImage(selectedFile),rotation=Number($('rotation').value)||0;
  const pages=canvasPagesForOcr(img,rotation);notice('文字認識の準備をしています…');
  if(!window.Tesseract)await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
  worker=await Tesseract.createWorker('jpn+eng',1,{logger:msg=>{if(msg.status==='recognizing text')notice(`文字認識中：${Math.round(msg.progress*100)}%\n完了後、金額や日付を必ず確認してね。`)}});
  await worker.setParameters({preserve_interword_spaces:'1'});
  notice('通常画像の文字を解析しています…');
  const rawOne=[];for(let i=0;i<pages.length;i++){
   notice(`通常画像を解析中（${i+1}/${pages.length}ページ）…`);
   rawOne.push((await worker.recognize(pages[i])).data.text);
  }
  const first=parseReceipt(rawOne.join('\n'));
  let second=null;if($('ocrMode').value==='high'){
   const rawTwo=[];for(let i=0;i<pages.length;i++){
    notice(`画像補正後を再解析中（${i+1}/${pages.length}ページ）…`);
    const enhanced=enhancedCanvas(pages[i]);rawTwo.push((await worker.recognize(enhanced)).data.text);
    enhanced.width=0;enhanced.height=0;
   }
   second=parseReceipt(rawTwo.join('\n'));
  }
  for(const page of pages){page.width=0;page.height=0;}
  const data=mergeFields(first,second);for(const key of ['date','amount','store','taxAmount','invoiceNo','payment','taxRate','category']){
   if(!data[key])continue;const id=key; if($(id))$(id).value=data[key].value;
  }
  $('ocrText').textContent=first.raw+(second?'\n\n===== 補正画像の認識結果 =====\n'+second.raw:'');
  updateBusinessEstimate();const missing=[];if(!data.date)missing.push('日付');if(!data.amount)missing.push('金額');if(!data.store)missing.push('店名');
  const amountNote=data.amount&&data.amount.score<70?'※金額候補があいまいです。':'';
  notice(`読み取り完了。${missing.length?'未認識：'+missing.join('・')+'。':'主要項目を入力しました。'}${amountNote}\n「小計・お釣り・税額」と間違っていないか、原本と照らし合わせて保存してください。`);
 }catch(e){notice('読み取りできませんでした：'+(e.message||e)+'\n画像を明るく撮り直すか、手入力してください。')}
 finally{if(worker)try{await worker.terminate()}catch{}btn.disabled=false;btn.textContent='🔍 写真から自動入力'}
};
function filtered(){const month=$('month').value,period=$('period').value,c=$('filter').value;return all.filter(x=>{const date=String(x.date||'');const inPeriod=period==='all'||(period==='year'?date.startsWith(month.slice(0,4)):date.startsWith(month));return inPeriod&&(!c||x.category===c)}).sort((a,b)=>String(b.date).localeCompare(String(a.date)))}
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
}
function editReceipt(x){editId=x.id;selectedFile=null;if(selectedUrl)URL.revokeObjectURL(selectedUrl);selectedUrl=null;$('photo').value='';for(const key of ['date','amount','store','detail','category','payment','taxRate','taxAmount','invoiceNo','memo']){
 if($(key))$(key).value=x[key]??(key==='payment'?'未設定':'')}
 $('businessRate').value=x.businessRate==null?100:x.businessRate;setPreview(x.photo||null);$('save').textContent='💾 変更を保存する';updateBusinessEstimate();window.scrollTo({top:0,behavior:'smooth'});notice('編集中です。写真を変更しなければ元の領収書画像は維持されます')}
$('save').onclick=async()=>{if(!db){notice('データベースが利用できません');return}const date=$field('date'),amount=Number($field('amount')),store=$field('store'),rate=Number($field('businessRate'));
 if(!date||$field('amount')===''||!Number.isFinite(amount)||amount<0||!Number.isSafeInteger(amount)){notice('正しい日付・整数の金額を入力してください');return}
 if($field('businessRate')===''||!Number.isFinite(rate)||rate<0||rate>100){notice('事業使用割合は0～100%で入力してください');return}
 let taxAmount=$field('taxAmount')===''?null:Number($field('taxAmount'));if(taxAmount!==null&&(!Number.isFinite(taxAmount)||taxAmount<0||taxAmount>amount)){notice('消費税額が支払総額を超えないか確認してください');return}
 const invoiceNo=$field('invoiceNo').replace(/\s/g,'').toUpperCase();if(invoiceNo&&!/^T\d{13}$/.test(invoiceNo)){notice('適格請求書番号はTと13桁の数字です');return}
 const original=editId?all.find(x=>x.id===editId):null;const same=all.find(x=>x.id!==editId&&x.date===date&&Number(x.amount)===amount&&(x.store||'').trim().toLowerCase()===store.toLowerCase());
 if(same&&!confirm('同じ日付・店名・金額の領収書が登録済みです。重複して保存しますか？'))return;
 try{const photo=selectedFile?await compactPhoto(selectedFile):(original?.photo||null);const receipt={id:editId||(crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2)),date,amount,store,detail:$field('detail'),category:$field('category')||'未分類',payment:$field('payment')||'未設定',taxRate:$field('taxRate'),taxAmount,businessRate:rate,invoiceNo,memo:$field('memo'),photo,createdAt:original?.createdAt||new Date().toISOString()};
 await saveItem(receipt);$('month').value=date.slice(0,7);$('period').value='month';$('filter').value='';resetForm();await refresh();notice('保存しました！ 写真と入力内容を確認できます。')
 }catch(e){notice('保存に失敗しました。iPhoneの空き容量を確認してください：'+e.message)}
};
$('month').addEventListener('change',render);$('period').addEventListener('change',render);$('filter').addEventListener('change',render);
function exportRows(){const headers=['日付','店名・支払先','購入内容・用途','経費科目','支払方法','支払総額(税込円)','税率','消費税額(円)','事業使用割合(%)','経費計上額(円)','適格請求書番号','メモ'];const data=filtered().map(x=>[x.date,x.store||'',x.detail||'',x.category||'未分類',x.payment||'未設定',Number(x.amount||0),x.taxRate||'',x.taxAmount??'',x.businessRate??100,businessAmount(x.amount,x.businessRate==null?100:x.businessRate),x.invoiceNo||'',x.memo||'']);return [headers,...data]}
function exportName(ext){const t=$('period').value;return `領収書_${t==='all'?'全期間':t==='year'?$('month').value.slice(0,4)+'年':$('month').value}.${ext}`}
function download(blob,filename){const u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),25000)}
const csvEscape=value=>{let s=String(value??'');if(/^[\s]*[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"'};
$('csv').onclick=()=>{const text='\ufeff'+exportRows().map(r=>r.map(csvEscape).join(',')).join('\r\n');download(new Blob([text],{type:'text/csv;charset=utf-8'}),exportName('csv'))};
$('xlsx').onclick=async()=>{try{notice('Excel出力の準備中…');if(!window.XLSX)await loadScript('https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js');const ws=XLSX.utils.aoa_to_sheet(exportRows());ws['!cols']=[{wch:13},{wch:25},{wch:28},{wch:18},{wch:15},{wch:17},{wch:9},{wch:14},{wch:20},{wch:17},{wch:20},{wch:40}];const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'経費一覧');XLSX.writeFile(wb,exportName('xlsx'));notice('Excelファイルを出力しました。ダウンロード先を確認してください')}
 catch(e){notice('Excelの出力に失敗しました。CSV出力なら追加ライブラリなしで使えます：'+e.message)}};
$('backup').onclick=()=>{const payload={version:2,createdAt:new Date().toISOString(),customCategories:getCustomCategories(),receipts:all};download(new Blob([JSON.stringify(payload)],{type:'application/json'}),`領収書バックアップ_${localDate()}.json`)};
$('restore').onclick=()=>$('restoreFile').click();$('restoreFile').onchange=async event=>{
 try{const file=event.target.files?.[0];if(!file)return;const data=JSON.parse(await file.text());if(!Array.isArray(data.receipts))throw Error('レシート帳のバックアップ形式ではありません');
 if(!confirm(`${data.receipts.length}件を復元します。同じIDのデータは上書きされます。よいですか？`))return;
 if(Array.isArray(data.customCategories))try{localStorage.setItem(CATEGORY_KEY,JSON.stringify(data.customCategories.filter(x=>typeof x==='string'&&x.length<=30)))}catch{}
 for(const x of data.receipts){if(!x||typeof x.id!=='string'||typeof x.date!=='string'||!/^20\d{2}-\d{2}-\d{2}$/.test(x.date)||!Number.isFinite(Number(x.amount)))continue;await saveItem({...x,category:x.category||'未分類',businessRate:x.businessRate??100});}
 await refresh();notice('バックアップを復元しました')
 }catch(e){notice('復元できませんでした：'+e.message)}finally{event.target.value=''}
};
(async()=>{try{$('date').value=localDate();$('month').value=localDate().slice(0,7);db=await openDb();await refresh();updateBusinessEstimate();
 if('serviceWorker'in navigator&&location.protocol.startsWith('http'))navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'}).catch(()=>{});
 }catch(e){notice('端末内データベースを使用できません：'+e.message+'\nSafariの通常モードから開いてください')}})();
