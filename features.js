'use strict';
/* レシート帳 v10: local-only enhancements. OCR is advisory, never a verified tax record. */
const VENDOR_RULE_KEY='receipt-vendor-categories-v10';
const BACKUP_KEY='receipt-last-backup-v10';
const pendingBatch=[];
let batchCancelled=false,batchRunning=false;
const createEl=(tag,text,className)=>{const x=document.createElement(tag);if(text!=null)x.textContent=text;if(className)x.className=className;return x};
function confidenceSummary(fields){
 const essential=['date','amount','store'];
 if(essential.some(k=>!fields?.[k]))return '要確認';
 if(essential.some(k=>(fields[k].score||0)<85))return '一部要確認';
 return '参考：認識候補あり';
}
function renderOcrEvidence(fields){
 const el=$('ocrEvidence');el.replaceChildren();
 for(const [id,label] of [['date','日付'],['amount','支払総額'],['store','支払先'],['taxAmount','消費税額'],['invoiceNo','T番号']]){
   const item=fields?.[id];const content=item?String(item.value)+(id==='amount'||id==='taxAmount'?'円':''):'認識できず';
   const badge=createEl('span',`${label}：${content}`,!item||item.score<85?'uncertain':'');
   el.append(badge);
 }
}
function guessReceiptType(text){
 const v=String(text||'');
 for(const [r,kind] of [
  [/通行料金|ETC|高速道路|料金所|NEXCO|阪神高速/i,'高速道路・ETC'],
  [/給油|油種|レギュラー|ハイオク|ENEOS|出光|コスモ石油/i,'ガソリン'],
  [/駐車場|駐車料金|パーキング|リパーク|タイムズ/i,'駐車場'],
  [/コピー代|コピー料金|コピーサービス|印刷料/i,'印刷・コピー'],
  [/セブン.?イレブン|ファミリーマート|ローソン|スーパー|マート/i,'コンビニ・スーパー'],
  [/飲食代|レストラン|居酒屋|食事代|喫茶店/i,'飲食'],
  [/タクシー|乗車券|鉄道|新幹線|電車|交通機関/i,'交通'],
  [/Amazon|楽天市場|通販|ご注文番号/i,'通販']
 ])if(r.test(v))return kind;
 return 'その他';
}
function getVendorRules(){try{const value=JSON.parse(localStorage.getItem(VENDOR_RULE_KEY)||'{}');return value&&typeof value==='object'&&!Array.isArray(value)?value:{}}catch{return {}}}
function vendorKey(store){return String(store||'').normalize('NFKC').toLowerCase().replace(/[\s　・‐－—–]/g,'').slice(0,50)}
function learnVendorCategory(store,category){
 const key=vendorKey(store);if(key.length<3||!category)return;
 const rules=getVendorRules();rules[key]=category;
 try{localStorage.setItem(VENDOR_RULE_KEY,JSON.stringify(rules))}catch{}
}
function suggestVendorCategory(store){const key=vendorKey(store);return key?getVendorRules()[key]||null:null}
async function digestPhoto(file){
 try{if(!file||!crypto?.subtle)return null;const buffer=await file.arrayBuffer();const arr=new Uint8Array(await crypto.subtle.digest('SHA-256',buffer));return Array.from(arr,b=>b.toString(16).padStart(2,'0')).join('')}
 catch{return null}
}
function advancedReceiptFilter(x){
 const term=$field('searchText').normalize('NFKC').toLowerCase(), min=$field('minAmount'),max=$field('maxAmount'),from=$field('fromDate'),to=$field('toDate'),state=$field('reviewFilter'),invoice=$field('invoiceFilter');
 if(term&&!([x.store,x.detail,x.invoiceNo,x.category,x.memo].some(v=>String(v||'').normalize('NFKC').toLowerCase().includes(term))))return false;
 if(min!==''&&Number(x.amount)<Number(min))return false;
 if(max!==''&&Number(x.amount)>Number(max))return false;
 if(from&&String(x.date||'')<from)return false;
 if(to&&String(x.date||'')>to)return false;
 if(state==='checked'&&!x.reviewed)return false;
 if(state==='pending'&&x.reviewed)return false;
 if(invoice==='verified'&&!x.invoiceVerified)return false;
 if(invoice==='pending'&&(!x.invoiceNo||x.invoiceVerified))return false;
 return true;
}
function renderAdvancedDashboard(rows){
 const panel=$('advancedDashboard');panel.replaceChildren();
 const year=$('month').value.slice(0,4),inYear=all.filter(x=>String(x.date||'').startsWith(year));
 const total=inYear.reduce((a,x)=>a+businessAmount(x.amount,x.businessRate??100),0);
 const unreviewed=rows.filter(x=>!x.reviewed).length;
 const invoicePending=rows.filter(x=>x.invoiceNo&&!x.invoiceVerified).length;
 panel.append(createEl('h3','確定申告の準備・確認状況'));
 panel.append(createEl('div',`選択年（${year}年）の経費合計：${money(total)} / ${inYear.length}件`,'dashStat'));
 panel.append(createEl('div',`表示中の領収書：未確認 ${unreviewed}件・T番号の未照合 ${invoicePending}件`,'dashStat'));
 const monthRows=new Array(12).fill(0);
 for(const x of inYear){const month=Number(String(x.date||'').slice(5,7));if(month>=1&&month<=12)monthRows[month-1]+=businessAmount(x.amount,x.businessRate??100)}
 const max=Math.max(...monthRows,1);
 panel.append(createEl('h3','月ごとの経費（選択年・全科目）'));
 for(let i=0;i<12;i++){
   const container=document.createElement('div');container.style.marginBottom='7px';
   container.append(createEl('div',`${i+1}月：${money(monthRows[i])}`,'minor'));
   const bar=createEl('div',null,'bar');const fill=document.createElement('span');fill.style.width=Math.round(monthRows[i]*100/max)+'%';bar.append(fill);container.append(bar);panel.append(container);
 }
 panel.append(createEl('p','※ 税務申告の可否・法定保存要件を保証するものではありません。分類・家事按分・消費税額は原本と確認してください。','hint'));
}
function updateBackupReminder(){
 const node=$('backupReminder');if(!node)return;
 let last;try{last=JSON.parse(localStorage.getItem(BACKUP_KEY)||'null')}catch{last=null}
 const days=last&&last.time?Math.floor((Date.now()-last.time)/86400000):null;
 const additional=last&&Number.isInteger(last.count)?all.length-last.count:null;
 if(!last){node.textContent='⚠️ この端末のバックアップ記録はありません。最初に「バックアップを作成」を押して、iCloud Driveなどに保存してね。';return}
 if(days>=7||additional>=20){node.textContent=`⚠️ 前回の書き出し操作から${days}日、登録数が${additional}件増えています。バックアップを取ってね。`;return}
 node.textContent=`✅ 前回のバックアップ書き出し操作：${new Date(last.time).toLocaleString('ja-JP')}（保存先のファイルも確認してね）`;
}
$('checkInvoice').onclick=()=>{
 const v=normalizeInvoiceInput($field('invoiceNo'));
 if(!/^T\d{13}$/.test(v)){notice('先にT番号（T＋数字13桁）を入力してね。公式サイトの入力欄にはTを除く数字13桁を入力します。');return}
 $('invoiceNo').value=v;
 try{if(navigator.clipboard?.writeText)navigator.clipboard.writeText(v.slice(1)).catch(()=>{})}catch{}
 window.open('https://www.invoice-kohyo.nta.go.jp/','_blank','noopener,noreferrer');
 notice('国税庁で数字13桁を検索し、取引日時点の登録状況と事業者名を確認してね。照合後にチェックを入れます。');
};
for(const id of ['searchText','minAmount','maxAmount','fromDate','toDate','reviewFilter','invoiceFilter']){
 $(id).addEventListener(/Filter$/.test(id)?'change':'input',()=>render());
}
$('clearSearch').onclick=()=>{for(const id of ['searchText','minAmount','maxAmount','fromDate','toDate'])$(id).value='';$('reviewFilter').value='';$('invoiceFilter').value='';render()};

// Batch candidates remain in memory until the page is closed. A candidate never auto-saves.
function renderBatchQueue(){
 const node=$('batchQueue');node.replaceChildren();
 for(let i=0;i<pendingBatch.length;i++){
  const item=pendingBatch[i],row=createEl('div',null,'batchCard');
  const photo=document.createElement('img');photo.src=item.preview;photo.alt='領収書の写真';row.append(photo);
  const details=document.createElement('div');details.style.flex='1';details.style.minWidth='0';
  const fields=item.parsed?.fields;
  details.append(createEl('strong',`${i+1}枚目：${item.file.name.slice(0,35)}`));
  details.append(createEl('div',item.status==='done'?'保存済み':item.status==='error'?'読み取り失敗・手入力可':`${fields?.date?.value||'日付不明'} / ${fields?.amount?.value!=null?money(fields.amount.value):'金額不明'} / ${confidenceSummary(fields)}`,'status'));
  row.append(details);
  const btn=createEl('button',item.status==='done'?'保存済み':'内容を確認','secondary');btn.type='button';btn.disabled=item.status==='done';
  btn.onclick=()=>openBatchCandidate(i);row.append(btn);node.append(row);
 }
}
function markBatchDone(i){if(pendingBatch[i]){pendingBatch[i].status='done';renderBatchQueue()}}
function openBatchCandidate(index){
 const candidate=pendingBatch[index];if(!candidate||candidate.status==='done')return;
 if(editId&& !confirm('編集中の内容を破棄して、別の領収書を開きますか？'))return;
 resetForm();batchActiveIndex=index;selectedFile=candidate.file;
 selectedUrl=URL.createObjectURL(selectedFile);setPreview(selectedUrl);
 const fields=candidate.parsed?.fields||{};
 for(const key of ['date','amount','store','invoiceNo','taxAmount'])$(key).value=fields[key]?.value??'';
 for(const key of ['payment','taxRate'])$(key).value=fields[key]?.value??(key==='payment'?'未設定':'');
 $('category').value=suggestVendorCategory(fields.store?.value)||fields.category?.value||'未分類';
 $('receiptType').value=guessReceiptType(candidate.parsed?.raw||'');
 lastOcrData=fields;renderOcrEvidence(fields);$('ocrText').textContent=candidate.parsed?.raw||'文字認識に失敗しました。もう一度この写真を「写真から自動入力」で読み取ってね。';
 updateBusinessEstimate();notice(`${index+1}枚目の候補を開いたよ。必要なら画像を切り抜いて再読み取りしてね。正しいか確認した後で保存してね。`);
 document.querySelector('section.panel').scrollIntoView({behavior:'smooth',block:'start'});
}
$('batchCancel').onclick=()=>{batchCancelled=true;$('batchProgress').textContent='停止を受け付けました。現在解析している1枚の処理が終わったら停止します。'};
$('batchScan').onclick=async()=>{
 if(batchRunning)return;
 const files=Array.from($('batchFiles').files||[]).filter(f=>f.type.startsWith('image/')).slice(0,10);
 if(!files.length){$('batchProgress').textContent='先に領収書の画像を選んでね。';return}
 batchRunning=true;batchCancelled=false;$('batchScan').disabled=true;let worker=null;
 try{
  if(!window.Tesseract)await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
  worker=await Tesseract.createWorker('jpn+eng',1);
  await worker.setParameters({preserve_interword_spaces:'1',tessedit_pageseg_mode:'11'});
  for(let i=0;i<files.length;i++){
   if(batchCancelled)break;
   const file=files[i];$('batchProgress').textContent=`${files.length}枚中 ${i+1}枚目を解析中。終了した候補から確認できるよ。`;
   const preview=URL.createObjectURL(file);let parsed=null,status='pending',pages=[];
   try{
    const img=await decodeImage(file);pages=canvasPagesForOcr(img,0);
    const raw=[];
    for(const page of pages){if(batchCancelled)break;raw.push((await worker.recognize(page)).data.text)}
    parsed=parseReceipt(raw.join('\n'));
    if(!batchCancelled&&(!parsed.fields.amount||!parsed.fields.date||!parsed.fields.store)){
     await worker.setParameters({tessedit_pageseg_mode:'6'});
     const header=headerCanvasForOcr(img,0);try{
      const extra=parseReceipt((await worker.recognize(header)).data.text);
      const merged=mergeFields(parsed,extra);for(const k of Object.keys(merged))if(merged[k])parsed.fields[k]=merged[k];
      parsed.raw+='\n[上部拡大]\n'+extra.raw;
     }finally{header.width=0;header.height=0;await worker.setParameters({tessedit_pageseg_mode:'11'})}
    }
   }catch(e){status='error';parsed={fields:{},raw:'エラー：'+(e?.message||e)}}
   finally{for(const page of pages){page.width=0;page.height=0}}
   pendingBatch.push({file,preview,parsed,status});renderBatchQueue();
  }
  $('batchProgress').textContent=`候補 ${pendingBatch.length}枚。各「内容を確認」から1枚ずつ保存してください。`;
 }catch(e){$('batchProgress').textContent='一括認識に失敗しました：'+(e?.message||e)+'。1枚ずつの読み取りも試してね。';}
 finally{if(worker)try{await worker.terminate()}catch{}batchRunning=false;$('batchScan').disabled=false;}
};

// Changing a previously verified T-number invalidates the manual confirmation.
let invoiceBeforeEdit='';
$('invoiceNo').addEventListener('focus',()=>{invoiceBeforeEdit=normalizeInvoiceInput($field('invoiceNo'))});
$('invoiceNo').addEventListener('input',()=>{if(normalizeInvoiceInput($field('invoiceNo'))!==invoiceBeforeEdit)$('invoiceVerified').checked=false});
