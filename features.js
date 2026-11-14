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

// v12: batch proposals are transient. Nothing is written until the user checks
// the photo, corrects its fields, and explicitly approves that candidate.
let batchSaving=false;
function batchDraftFromParsed(parsed){
 const f=parsed?.fields||{},raw=parsed?.raw||'';
 return {
  date:String(f.date?.value??''),store:String(f.store?.value??''),
  amount:f.amount?.value==null?'':String(f.amount.value),
  taxAmount:f.taxAmount?.value==null?'':String(f.taxAmount.value),
  invoiceNo:normalizeInvoiceInput(f.invoiceNo?.value??''),
  taxRate:String(f.taxRate?.value??''),payment:String(f.payment?.value??'未設定'),
  category:suggestVendorCategory(f.store?.value)||String(f.category?.value??'未分類'),
  receiptType:guessReceiptType(raw),
  detail:/(?:コピー代|コピ一代|コピー料金|複写代)/.test(raw)?'コピー代':'',
  businessRate:'100',memo:''
 };
}
function candidateDraft(item){return item.draft||(item.draft=batchDraftFromParsed(item.parsed))}
function candidateProblems(d){
 const problems=[];
 const date=String(d.date||'');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date))problems.push('日付');
 else{const [y,m,day]=date.split('-').map(Number);if(!validDate(y,m,day))problems.push('日付')}
 const amount=Number(d.amount);
 if(d.amount===''||!Number.isSafeInteger(amount)||amount<=0)problems.push('金額');
 if(!String(d.store||'').trim())problems.push('店名');
 const rate=Number(d.businessRate);
 if(d.businessRate===''||!Number.isFinite(rate)||rate<0||rate>100)problems.push('事業使用割合');
 if(d.taxAmount!==''){
  const tax=Number(d.taxAmount);
  if(!Number.isSafeInteger(tax)||tax<0||tax>amount)problems.push('消費税額');
 }
 const number=normalizeInvoiceInput(d.invoiceNo);
 if(number&&!/^T\d{13}$/.test(number))problems.push('T番号');
 return problems;
}
function updateBatchButtons(){
 const unchecked=pendingBatch.filter(item=>item.status!=='done');
 const selected=unchecked.filter(item=>item.approved).length;
 const done=pendingBatch.length-unchecked.length;
 const label=$('batchSelected');
 if(label)label.textContent=`確認済み ${selected}件／未保存 ${unchecked.length}件／保存済み ${done}件`;
 const save=$('batchSaveAll');
 if(save){save.textContent=`💾 確認済みをまとめて保存（${selected}件）`;save.disabled=!db||!selected||batchRunning||batchSaving}
 const clear=$('batchClearAll');if(clear)clear.disabled=!unchecked.length||batchRunning||batchSaving;
}
function fieldInput(item,key,title,type='text',options=null){
 const label=createEl('label',null,'batchField');
 const caption=createEl('span',title);label.append(caption);
 const input=options?document.createElement('select'):document.createElement('input');
 if(options){for(const option of options){const value=typeof option==='string'?option:option[0],name=typeof option==='string'?option:option[1];input.add(new Option(name,value))}}
 else{input.type=type;if(type==='number'){input.step='1';input.min='0'}if(key==='invoiceNo')input.autocapitalize='characters'}
 input.value=String(candidateDraft(item)[key]??'');input.disabled=item.status==='done'||batchSaving;
 input.setAttribute('aria-label',title);
 input.addEventListener(options?'change':'input',()=>{
  item.draft[key]=input.value;
  item.approved=false;item.warning='内容が変更されました。原本を再確認してチェックしてください。';
  const check=item._check;if(check)check.checked=false;
  if(item._status)item._status.textContent=item.warning;
  updateBatchButtons();
 });
 label.append(input);return label;
}
function renderBatchQueue(){
 const node=$('batchQueue');node.replaceChildren();
 for(let i=0;i<pendingBatch.length;i++){
  const item=pendingBatch[i],draft=candidateDraft(item);
  const row=createEl('div',null,'batchCandidate');
  const head=createEl('div',null,'batchHead');
  const photo=document.createElement('img');photo.src=item.preview;photo.alt='領収書の写真';
  photo.title='タップで写真を表示';photo.onclick=()=>window.open(item.preview,'_blank','noopener');head.append(photo);
  const detail=createEl('div',null,'batchHeadText');
  detail.append(createEl('strong',`${i+1}枚目：${item.file.name.slice(0,35)}`));
  const summary=createEl('div',null,'status');
  summary.textContent=item.status==='done'?'✅ 保存済み':`${draft.date||'日付不明'} / ${draft.amount!==''?money(draft.amount):'金額不明'} / ${draft.store||'店名不明'}`;
  detail.append(summary);head.append(detail);
  const deleteBtn=createEl('button','削除','danger');deleteBtn.type='button';deleteBtn.disabled=batchRunning||batchSaving;
  deleteBtn.onclick=()=>{
   if(item.status==='done'){alert('保存済みの領収書は「保存した領収書」から削除してね。');return}
   if(!confirm(`${i+1}枚目の読み取り候補を破棄しますか？（保存済みデータは削除されません）`))return;
   if(batchActiveIndex===i)resetForm();else if(batchActiveIndex!=null&&batchActiveIndex>i)batchActiveIndex--;
   URL.revokeObjectURL(item.preview);pendingBatch.splice(i,1);renderBatchQueue();
  };
  deleteBtn.disabled=deleteBtn.disabled||item.status==='done';head.append(deleteBtn);row.append(head);
  if(item.status==='done'){node.append(row);continue}
  const edit=document.createElement('details');edit.className='batchEdit';
  const sum=createEl('summary','✏️ 内容を修正・原本と照合');edit.append(sum);
  const grid=createEl('div',null,'batchInputs');
  const payOpts=['未設定','現金','クレジットカード','デビットカード','電子マネー','QR決済','銀行振込','その他'];
  const cats=currentCategories();if(draft.category&&!cats.includes(draft.category))cats.push(draft.category);
  for(const el of [
   fieldInput(item,'date','利用日','date'),fieldInput(item,'amount','支払総額（円）','number'),
   fieldInput(item,'store','店名・支払先'),fieldInput(item,'taxAmount','消費税額（円）','number'),
   fieldInput(item,'invoiceNo','T番号（なければ空欄）'),fieldInput(item,'category','経費科目','text',cats),
   fieldInput(item,'payment','支払方法','text',payOpts),
   fieldInput(item,'taxRate','税率','text',[['','未設定'],['10','10%'],['8','8%'],['0','対象外'],['mixed','混在']]),
   fieldInput(item,'detail','購入内容・用途'),fieldInput(item,'businessRate','事業使用割合（%）','number'),
   fieldInput(item,'memo','メモ')])grid.append(el);
  edit.append(grid);
  const checkWrap=createEl('label',null,'batchApprove');
  const check=document.createElement('input');check.type='checkbox';check.checked=!!item.approved;item._check=check;
  const status=createEl('div',item.warning||'自動読取の内容を写真と照らしてからチェックしてね。','batchWarning');item._status=status;
  check.onchange=()=>{
   if(check.checked){const errs=candidateProblems(draft);
    if(errs.length){check.checked=false;item.approved=false;item.warning=`保存前に修正が必要：${errs.join('・')}`;status.textContent=item.warning;updateBatchButtons();return}
   }
   item.approved=check.checked;item.warning=check.checked?'✅ 原本との照合済み。まとめて保存できます。':'確認を解除しました。';status.textContent=item.warning;
   if(check.checked)draft.invoiceNo=normalizeInvoiceInput(draft.invoiceNo);
   updateBatchButtons();
  };
  checkWrap.append(check,createEl('span','写真の原本と照合した（まとめて保存対象にする）'));
  edit.append(checkWrap,status);
  const detailBtn=createEl('button','通常の入力画面で詳しく編集','secondary');detailBtn.type='button';
  detailBtn.onclick=()=>openBatchCandidate(i);edit.append(detailBtn);
  row.append(edit);node.append(row);
 }
 updateBatchButtons();
}
function markBatchDone(i){if(pendingBatch[i]){pendingBatch[i].status='done';pendingBatch[i].approved=false;renderBatchQueue()}}
function openBatchCandidate(index){
 const candidate=pendingBatch[index];if(!candidate||candidate.status==='done')return;
 if(editId&&!confirm('編集中の内容を破棄して、別の領収書を開きますか？'))return;
 resetForm();batchActiveIndex=index;selectedFile=candidate.file;
 selectedUrl=URL.createObjectURL(selectedFile);setPreview(selectedUrl);
 const draft=candidateDraft(candidate);
 for(const key of ['date','amount','store','invoiceNo','taxAmount','detail','businessRate','memo'])$(key).value=draft[key]??'';
 for(const key of ['payment','taxRate'])$(key).value=draft[key]??(key==='payment'?'未設定':'');
 $('category').value=draft.category||'未分類';$('receiptType').value=draft.receiptType||'その他';
 lastOcrData=candidate.parsed?.fields||{};renderOcrEvidence(lastOcrData);
 $('ocrText').textContent=candidate.parsed?.raw||'認識できませんでした。再撮影または手入力で対応してね。';
 updateBusinessEstimate();notice(`${index+1}枚目の候補を開いたよ。正しいか確認して保存してね。`);
 document.querySelector('section.panel').scrollIntoView({behavior:'smooth',block:'start'});
}
$('batchCancel').onclick=()=>{batchCancelled=true;$('batchProgress').textContent='停止を受け付けました。現在解析している1枚の処理が終わったら停止します。'};
$('batchClearAll').onclick=()=>{
 if(batchRunning||batchSaving)return;
 const count=pendingBatch.filter(x=>x.status!=='done').length;if(!count)return;
 if(!confirm(`未保存の候補 ${count}件を破棄しますか？（すでに保存した領収書は残ります）`))return;
 if(batchActiveIndex!=null)resetForm();
 for(let i=pendingBatch.length-1;i>=0;i--)if(pendingBatch[i].status!=='done'){
  URL.revokeObjectURL(pendingBatch[i].preview);pendingBatch.splice(i,1);
 }
 renderBatchQueue();$('batchProgress').textContent='未保存の候補を破棄しました。';
};
$('batchSaveAll').onclick=async()=>{
 if(batchSaving||batchRunning)return;
 const chosen=pendingBatch.filter(x=>x.approved&&x.status!=='done');
 if(!chosen.length){$('batchProgress').textContent='先に候補を開いて内容を修正し、「原本と照合した」にチェックしてね。';return}
 if(!db){$('batchProgress').textContent='端末の保存データベースが利用できません。';return}
 if(!confirm(`原本と確認した ${chosen.length}件をまとめて保存しますか？（不備や重複の候補は保存しません）`))return;
 batchSaving=true;updateBatchButtons();let saved=0,skipped=0,failed=0;let finalError='';
 // Refresh first: include all already-saved receipts in duplicate checks.
 try{all=await getAll();}catch(e){$('batchProgress').textContent='保存済みデータを取得できません：'+e.message;batchSaving=false;updateBatchButtons();return}
 for(const item of chosen){
  const d=candidateDraft(item),errors=candidateProblems(d);
  if(errors.length){item.approved=false;item.warning='保存しなかった項目：'+errors.join('・');skipped++;continue}
  const date=d.date,amount=Number(d.amount),store=d.store.trim(),invoiceNo=normalizeInvoiceInput(d.invoiceNo);
  $('batchProgress').textContent=`保存中：${saved+skipped+failed+1} / ${chosen.length}件…`;
  try{
   const imageHash=await digestPhoto(item.file);
   const dup=all.find(x=>(imageHash&&x.imageHash===imageHash)||(
    x.date===date&&Number(x.amount)===amount&&vendorKey(x.store)===vendorKey(store)));
   if(dup){item.approved=false;item.warning='重複の可能性があるため保存をスキップ。必要なら個別に確認してね。';skipped++;continue}
   const now=new Date().toISOString();
   const receipt={id:crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2),
    date,amount,store,detail:d.detail.trim(),category:d.category||'未分類',payment:d.payment||'未設定',
    taxRate:d.taxRate||'',taxAmount:d.taxAmount===''?null:Number(d.taxAmount),businessRate:Number(d.businessRate),invoiceNo,memo:d.memo.trim(),
    photo:await compactPhoto(item.file),imageHash,createdAt:now,updatedAt:now,
    receiptType:d.receiptType||'その他',reviewed:true,invoiceVerified:false,invoiceVerifiedAt:null,
    ocrConfidence:confidenceSummary(item.parsed?.fields),history:[]};
   await saveItem(receipt);all.push(receipt);item.status='done';item.approved=false;item.warning='✅ 保存済み';saved++;
  }catch(e){failed++;finalError=String(e?.message||e);item.warning='保存失敗：'+finalError;
   // A full iPhone storage quota should not be hammered by more large photos.
   break;
  }
 }
 batchSaving=false;
 try{if(saved){await refresh();updateBackupReminder()}}catch(e){finalError+='／一覧更新失敗：'+e.message}
 renderBatchQueue();
 $('batchProgress').textContent=`一括保存結果：保存 ${saved}件、未保存（入力不備・重複）${skipped}件、失敗 ${failed}件。${finalError?'エラー：'+finalError+'。':''}未保存の候補は修正して再実行できるよ。`;
};
$('batchScan').onclick=async()=>{
 if(batchRunning||batchSaving)return;
 const files=Array.from($('batchFiles').files||[]).filter(f=>f.type.startsWith('image/')).slice(0,10);
 if(!files.length){$('batchProgress').textContent='先に領収書の画像を選んでね。';return}
 batchRunning=true;batchCancelled=false;$('batchScan').disabled=true;updateBatchButtons();let worker=null;
 try{
  if(!window.Tesseract)await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
  worker=await Tesseract.createWorker('jpn+eng',1);
  await worker.setParameters({preserve_interword_spaces:'1',tessedit_pageseg_mode:'11'});
  for(let i=0;i<files.length;i++){
   if(batchCancelled)break;
   const file=files[i];$('batchProgress').textContent=`${files.length}枚中 ${i+1}枚目を解析中。終了した候補から確認できるよ。`;
   const preview=URL.createObjectURL(file);let parsed=null,status='pending',pages=[];
   try{
    const img=await decodeImage(file);const source=$('autoTrim').checked?autoTrimReceiptSource(img):img;pages=canvasPagesForOcr(source,0);
    const raw=[];
    for(const page of pages){if(batchCancelled)break;raw.push((await worker.recognize(page)).data.text)}
    parsed=parseReceipt(raw.join('\n'));
    if(!batchCancelled&&(!parsed.fields.invoiceNo||!parsed.fields.date||!parsed.fields.store)){
     await worker.setParameters({tessedit_pageseg_mode:'6'});
     const upper=focusedCanvasForOcr(source,0,0,.46);try{
      const extra=parseReceipt((await worker.recognize(upper)).data.text);
      for(const k of ['store','invoiceNo'])if(extra.fields[k]&&(!parsed.fields[k]||extra.fields[k].score>parsed.fields[k].score+25))parsed.fields[k]=extra.fields[k];
      if(!parsed.fields.date&&extra.fields.date)parsed.fields.date=extra.fields.date;
      parsed.raw+='\n[上部拡大]\n'+extra.raw;
     }finally{upper.width=0;upper.height=0}
     if(!parsed.fields.date&&!batchCancelled){
      const lower=focusedCanvasForOcr(source,0,.43,.95);try{
       const extra=parseReceipt((await worker.recognize(lower)).data.text);
       if(extra.fields.date)parsed.fields.date=extra.fields.date;
       parsed.raw+='\n[下部の日付再解析]\n'+extra.raw;
      }finally{lower.width=0;lower.height=0}
     }
     await worker.setParameters({tessedit_pageseg_mode:'11'});
    }
   }catch(e){status='error';parsed={fields:{},raw:'エラー：'+(e?.message||e)}}
   finally{for(const page of pages){page.width=0;page.height=0}}
   pendingBatch.push({file,preview,parsed,status,approved:false,draft:batchDraftFromParsed(parsed),warning:''});renderBatchQueue();
  }
  $('batchProgress').textContent=`候補 ${pendingBatch.filter(x=>x.status!=='done').length}枚。「内容を修正・原本と照合」→チェック→「まとめて保存」の順に進めてね。`;
 }catch(e){$('batchProgress').textContent='一括認識に失敗しました：'+(e?.message||e)+'。1枚ずつの読み取りも試してね。';}
 finally{if(worker)try{await worker.terminate()}catch{}batchRunning=false;$('batchScan').disabled=false;updateBatchButtons();}
};
// Changing a previously verified T-number invalidates the manual confirmation.
let invoiceBeforeEdit='';
$('invoiceNo').addEventListener('focus',()=>{invoiceBeforeEdit=normalizeInvoiceInput($field('invoiceNo'))});
$('invoiceNo').addEventListener('input',()=>{if(normalizeInvoiceInput($field('invoiceNo'))!==invoiceBeforeEdit)$('invoiceVerified').checked=false});
