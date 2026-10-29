// Native browser PDF rendering with site-owned page navigation.
import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.mjs';
const $=id=>document.getElementById(id);
const PAGE_OWNER=location.hostname.endsWith('.github.io')?location.hostname.slice(0,-'.github.io'.length):'smartbooks1';
const PAGE_REPOSITORY=location.hostname.endsWith('.github.io')?(location.pathname.split('/').filter(Boolean)[0]||PAGE_OWNER+'.github.io'):'AI2027-Reader-Template';
const ROOT=PAGE_OWNER+'/'+PAGE_REPOSITORY;
const displayName=path=>decodeURIComponent(path.split('/').pop()).replace(/\.pdf$/i,'');
const link=path=>path.split('/').map(encodeURIComponent).join('/');
let books=[],readerDefaults={fit:'auto'},currentPage=1,totalPages=0,currentBookIndex=-1,currentBookUrl='',pageInfoTask=null,pdfDocument=null,openToken=0,zoomLevel=100,fitMode='page',twoPage=false,spreadRenderToken=0,spreadRenderTasks=[];
const BOOKMARK_KEY='reader:'+ROOT+':manual-bookmark:v1';
// Canvas spreads need supersampling to retain the sharp text of the native PDF viewer.
const MIN_SPREAD_RENDER_RATIO=2;
const MAX_SPREAD_RENDER_RATIO=3;
const MAX_SPREAD_PAGE_PIXELS=12000000;
let coverImagePromise=null;
async function drawBlankCover(canvas,width,height,ratio,mirrored=false){
 if(!coverImagePromise){
  // Re-fetch on each visit; reuse the decoded image only within this reader session.
  coverImagePromise=(async()=>{
   const artwork=document.querySelector('[data-reader-artwork]');if(!artwork)return null;
   const response=await fetch(artwork.src,{cache:'no-store'});
   if(!response.ok)throw Error('Cover image request failed ('+response.status+')');
   const objectUrl=URL.createObjectURL(await response.blob());
   try{const image=new Image();image.src=objectUrl;await image.decode();return image}
   finally{URL.revokeObjectURL(objectUrl)}
  })().catch(()=>{coverImagePromise=null;return null});
 }
 const image=await coverImagePromise;if(!image)return;
 // Match the CSS mobile breakpoint: 30 mm wide on mobile, 40 mm on PC (96 CSS pixels per inch).
 const imageWidthMm=window.matchMedia('(max-width:760px),(max-width:1000px) and (pointer:coarse)').matches?30:40;
 const imageWidth=imageWidthMm*96/25.4,imageHeight=imageWidth*image.naturalHeight/image.naturalWidth;
 const context=canvas.getContext('2d');context.save();context.scale(ratio,ratio);
 if(mirrored){context.translate(width,0);context.scale(-1,1)}
 context.drawImage(image,(width-imageWidth)/2,(height-imageHeight)/2,imageWidth,imageHeight);context.restore();
}
const info=(text,error=false)=>{$('message').textContent=text;$('message').className='message'+(error?' error':'');$('message').hidden=false};
async function discover(){
 const resp=await fetch('https://api.github.com/repos/'+ROOT+'/git/trees/main?recursive=1',{headers:{Accept:'application/vnd.github+json'},cache:'no-store'});
 if(!resp.ok)throw Error('GitHub 파일 목록 조회 실패 ('+resp.status+')');
 const obj=await resp.json();
 if(obj.truncated)throw Error('저장소 파일 목록이 너무 커 자동 검색하지 못했습니다.');
 return obj.tree.filter(f=>f.type==='blob'&&/\.pdf$/i.test(f.path)).map(f=>({file:f.path,visible:true})).sort((a,b)=>a.file.localeCompare(b.file,'ko',{numeric:true}));
}
function configuredBooks(config,discovered){
 if(!config||typeof config!=='object'||Array.isArray(config))throw Error('books.json의 최상위 값은 { } 형태여야 합니다.');
 if(config.books!==undefined&&!Array.isArray(config.books))throw Error('books 항목은 [ ] 목록이어야 합니다.');
 if(config.titleRules!==undefined&&!Array.isArray(config.titleRules))throw Error('titleRules 항목은 [ ] 목록이어야 합니다.');
 if(config.siteTitle!==undefined&&(typeof config.siteTitle!=='string'||!config.siteTitle.trim()))throw Error('siteTitle에는 비어 있지 않은 책 제목을 입력해 주세요.');
 if(config.autoDiscover!==undefined&&typeof config.autoDiscover!=='boolean')throw Error('autoDiscover는 true 또는 false로 지정해 주세요.');
 const defaults=config.readerDefaults===undefined?{}:config.readerDefaults;
 if(!defaults||typeof defaults!=='object'||Array.isArray(defaults))throw Error('readerDefaults는 { } 형태여야 합니다.');
 if(defaults.fit!==undefined&&!['auto','width','page'].includes(defaults.fit))throw Error('readerDefaults.fit은 auto, width, page 중 하나여야 합니다.');
 if(defaults.twoPage!==undefined&&typeof defaults.twoPage!=='boolean')throw Error('readerDefaults.twoPage는 true 또는 false여야 합니다.');
 const rules=config.titleRules||[];
 for(let i=0;i<rules.length;i++){const rule=rules[i];if(!rule||typeof rule.contains!=='string'||!rule.contains.trim()||typeof rule.title!=='string'||!rule.title.trim())throw Error('titleRules '+(i+1)+'번째 항목의 contains와 title을 확인해 주세요.')}
 const declared=config.books||[],seen=new Set(),ordered=[];
 for(let i=0;i<declared.length;i++){
  const b=declared[i],prefix='books '+(i+1)+'번째 항목';
  if(!b||typeof b!=='object'||Array.isArray(b))throw Error(prefix+'은 { } 형태여야 합니다.');
  if(typeof b.file!=='string'||!b.file.trim()||!(/\.pdf$/i.test(b.file)))throw Error(prefix+'의 file에 PDF 경로(.pdf)를 입력해 주세요.');
  if(b.file.startsWith('/')||b.file.includes('\\')||b.file.split('/').some(p=>p==='.'||p==='..'||!p))throw Error(prefix+'의 file 경로를 확인해 주세요.');
  if(seen.has(b.file.toLocaleLowerCase()))throw Error(prefix+'의 PDF 경로가 중복되었습니다: '+b.file);
  if(b.visible!==undefined&&typeof b.visible!=='boolean')throw Error(prefix+'의 visible은 true 또는 false로 지정해 주세요.');
  if(b.title!==undefined&&(typeof b.title!=='string'||!b.title.trim()))throw Error(prefix+'의 title을 확인해 주세요.');
  seen.add(b.file.toLocaleLowerCase());if(b.visible!==false)ordered.push(b);
 }
 const auto=config.autoDiscover!==false;
 if(auto){for(const item of discovered){if(!seen.has(item.file.toLocaleLowerCase()))ordered.push(item)}}
 return ordered.map(b=>{
  const rule=rules.find(x=>b.file.includes(x.contains));
  return {...b,title:b.title||rule?.title||displayName(b.file)};
 });
}
async function loadBooks(){
 info('도서 목록을 불러오는 중입니다…');
 try{
  const response=await fetch('./config/books.json',{cache:'no-store'});if(!response.ok)throw Error('config/books.json을 찾을 수 없습니다 ('+response.status+').');
  let config;try{config=await response.json()}catch{throw Error('books.json 문법 오류: 쉼표, 따옴표, 괄호를 확인해 주세요.')}
  // Validate settings before making network requests.
  configuredBooks(config,[]);
  const discovered=config.autoDiscover!==false?await discover():[];
  books=configuredBooks(config,discovered);
  // Verify manually listed PDFs using GitHub Pages paths, also when auto discovery is disabled.
  const listed=books.filter(b=>(config.books||[]).some(x=>x.file===b.file));
  const check=await Promise.all(listed.map(async b=>{try{const res=await fetch(link(b.file),{method:'HEAD',cache:'no-store'});return res.ok?null:b.file+' (HTTP '+res.status+')'}catch{return b.file+' (연결 확인 실패)'}}));
  const missing=check.filter(Boolean);
  if(missing.length)throw Error('지정한 PDF 파일을 찾지 못했습니다: '+missing.join(', ')+'. books.json의 file 경로와 실제 업로드 파일명을 확인해 주세요.');
  readerDefaults={fit:config.readerDefaults?.fit||'auto',twoPage:config.readerDefaults?.twoPage===true};
  fitMode=readerDefaults.fit==='width'?'width':'page';
  twoPage=readerDefaults.twoPage;
  if(smallScreen()){
   twoPage=false;
   if(mobilePortrait()){fitMode='page';twoPage=false}
   else fitMode='width';
  }

  const siteTitle=typeof config.siteTitle==='string'&&config.siteTitle.trim()?config.siteTitle:'전자책 자료실';
  $('siteTitle').textContent=siteTitle;document.title=siteTitle;
  if(!books.length){$('chapters').replaceChildren();info('표시할 PDF가 없습니다. config/books.json의 books, visible, autoDiscover 설정을 확인해 주세요.');return}
  const nav=$('chapters'),mobileList=$('mobileTocList');nav.replaceChildren();mobileList.replaceChildren();$('welcomeResources').replaceChildren();$('mobileTocCount').textContent=books.length+'개';$('mobileTocBadge').textContent=String(books.length);
  books.forEach((b,i)=>{
   const btn=document.createElement('button');btn.className='chapter';btn.textContent=b.title;btn.onclick=()=>openBook(i);nav.appendChild(btn);
   const resource=document.createElement('button'),resourceTitle=document.createElement('span'),arrow=document.createElement('span');resource.type='button';resource.className='welcome-resource';resourceTitle.textContent=b.title;arrow.textContent='\u2192';arrow.setAttribute('aria-hidden','true');resource.append(resourceTitle,arrow);resource.onclick=()=>openBook(i);$('welcomeResources').appendChild(resource);
   const option=document.createElement('button'),label=document.createElement('span');option.type='button';option.className='mobile-toc-option';option.setAttribute('role','option');option.setAttribute('aria-selected','false');label.className='mobile-toc-title';label.textContent=b.title;option.append(label);option.onclick=()=>{setMobileTocOpen(false);openBook(i)};mobileList.appendChild(option);
  });
  $('message').hidden=true;
 }catch(e){info('도서 목록을 불러오지 못했습니다: '+e.message,true)}
}

function updatePageControls(){
 $('currentPage').value=String(currentPage);$('currentPage').max=String(Math.max(1,totalPages));$('currentPage').disabled=!totalPages;
 $('totalPages').textContent=totalPages?String(totalPages):'-';
 const atFirst=currentPage<=1,atLast=!totalPages||currentPage>=lastPageStart();
 $('firstPage').disabled=atFirst;$('prevPage').disabled=atFirst;$('edgePrev').disabled=atFirst;
 $('nextPage').disabled=atLast;$('lastPage').disabled=atLast;$('edgeNext').disabled=atLast;
 $('mobileFirstPage').disabled=atFirst;$('mobileLastPage').disabled=atLast;
 $('readerZoomLabel').textContent=zoomLevel+'%';$('zoomOut').disabled=zoomLevel<=50;$('zoomIn').disabled=zoomLevel>=200;
 $('mobileZoomLabel').textContent=zoomLevel+'%';$('mobileZoomOut').disabled=zoomLevel<=50;$('mobileZoomIn').disabled=zoomLevel>=200;
 $('fitWidth').setAttribute('aria-pressed',String(fitMode==='width'));$('fitPage').setAttribute('aria-pressed',String(fitMode==='page'));
 $('mobileFitWidth').setAttribute('aria-pressed',String(fitMode==='width'));$('mobileFitPage').setAttribute('aria-pressed',String(fitMode==='page'));
 $('singlePageMode').setAttribute('aria-pressed',String(!twoPage));$('twoPageMode').setAttribute('aria-pressed',String(twoPage));
 $('mobileSinglePageMode').setAttribute('aria-pressed',String(!twoPage));$('mobileTwoPageMode').setAttribute('aria-pressed',String(twoPage));
 updateBookmarkButtons();
 $('downloadOriginal').disabled=!currentBookUrl||!totalPages||downloadInProgress;
}
function readBookmark(){
 try{const value=JSON.parse(localStorage.getItem(BOOKMARK_KEY));return value&&typeof value.file==='string'&&Number.isInteger(value.page)&&value.page>0?value:null}catch{return null}
}
function bookmarkTarget(){
 const saved=readBookmark();if(!saved)return null;
 const index=books.findIndex(book=>book.file===saved.file);return index<0?null:{...saved,index,title:books[index].title};
}
function updateBookmarkButtons(){
 const target=bookmarkTarget(),exists=!!target,ready=!!(pdfDocument&&totalPages&&currentBookIndex>=0);
 $('bookmarkSave').disabled=!ready;$('bookmarkGo').hidden=!exists;$('bookmarkDelete').hidden=!exists;
 const here=!!(target&&target.index===currentBookIndex&&target.page===currentPage),saveLabel=here?'책갈피 저장됨':'책갈피';
 $('bookmarkSave').setAttribute('aria-pressed',String(here));$('bookmarkSave').setAttribute('aria-label',here?'현재 페이지에 책갈피가 설정됨':'현재 페이지에 책갈피 설정');$('bookmarkSave').title=saveLabel;$('bookmarkSave').querySelector('span').textContent=saveLabel;
 if(target){$('bookmarkGo').title=target.title+' '+target.page+'쪽으로 이동';$('bookmarkGo').setAttribute('aria-label',$('bookmarkGo').title)}
}
let downloadInProgress=false;
async function downloadOriginal(){
 if(downloadInProgress||!currentBookUrl||!totalPages)return;
 const url=currentBookUrl,filename=decodeURIComponent(new URL(url).pathname.split('/').pop())||'original.pdf';
 const button=$('downloadOriginal');
 downloadInProgress=true;button.disabled=true;button.setAttribute('aria-busy','true');
 let writable=null;
 try{
  if(typeof window.showSaveFilePicker==='function'&&window.isSecureContext){
   // Open the picker before awaiting any data so the click's user activation is retained.
   let handle;
   try{handle=await window.showSaveFilePicker({suggestedName:filename,types:[{description:'PDF 문서',accept:{'application/pdf':['.pdf']}}]})}
   catch(error){
    if(error.name==='AbortError')return;
    if(error.name!=='SecurityError'&&error.name!=='NotAllowedError')throw error;
   }
   if(handle){
    const response=await fetch(url);
    if(!response.ok)throw Error('파일 요청 실패 ('+response.status+')');
    const blob=await response.blob();
    writable=await handle.createWritable();await writable.write(blob);await writable.close();writable=null;
    return;
   }
  }
  const anchor=document.createElement('a');anchor.href=url;anchor.download=filename;
  document.body.appendChild(anchor);anchor.click();anchor.remove();
 }catch(error){
  if(writable){try{await writable.abort()}catch{}}
  if(error.name!=='AbortError')info('원본 PDF를 내려받지 못했습니다: '+error.message,true);
 }finally{
  downloadInProgress=false;button.removeAttribute('aria-busy');button.disabled=!currentBookUrl||!totalPages;
 }
}
function saveBookmark(){
 if(!pdfDocument||currentBookIndex<0||!totalPages)return;
 try{localStorage.setItem(BOOKMARK_KEY,JSON.stringify({file:books[currentBookIndex].file,page:currentPage}))}catch{}
 updateBookmarkButtons();if(smallScreen())setMobileToolsOpen(false);
}
function deleteBookmark(){
 try{localStorage.removeItem(BOOKMARK_KEY)}catch{}
 updateBookmarkButtons();if(smallScreen())setMobileToolsOpen(false);
}
function goToBookmark(){
 const target=bookmarkTarget();if(!target)return;
 if(smallScreen())setMobileToolsOpen(false);
 if(target.index===currentBookIndex)goToPage(target.page);else openBook(target.index,{page:target.page});
}
function lastPageStart(){
 if(!twoPage||totalPages<=1)return Math.max(1,totalPages);
 return totalPages%2===0?totalPages:totalPages-1;
}
function normalizePage(pageNumber){
 const bounded=Math.max(1,Math.min(totalPages||1,pageNumber));
 return twoPage&&bounded>1&&bounded%2!==0?bounded-1:bounded;
}
function visiblePages(){
 if(!twoPage)return [currentPage];
 if(currentPage===1)return [null,1];
 return [currentPage,currentPage+1<=totalPages?currentPage+1:null];
}
let cancelPageTurn=null;
function cancelSpreadRendering(){
 cancelPageTurn?.();
 spreadRenderToken++;for(const task of spreadRenderTasks){try{task.cancel()}catch{}}spreadRenderTasks=[];
}
function spreadRenderRatio(width,height){
 const screenRatio=Math.max(MIN_SPREAD_RENDER_RATIO,Math.min(window.devicePixelRatio||1,MAX_SPREAD_RENDER_RATIO));
 return Math.min(screenRatio,Math.sqrt(MAX_SPREAD_PAGE_PIXELS/(width*height)));
}
let pageTurnBusy=false;
function renderNativePages(direction=0){
 cancelSpreadRendering();const token=spreadRenderToken,pages=$('nativePages');
 const animateTurn=direction&&!smallScreen()&&!window.matchMedia('(prefers-reduced-motion:reduce)').matches;
 const previous=animateTurn?pages.querySelector('.spread-stage:not([hidden])'):null;
 pageTurnBusy=!!previous;
 if(previous)pages.replaceChildren(previous);else pages.replaceChildren();
 pages.classList.toggle('two-page',twoPage);
 pages.classList.toggle('page-fitted',fitMode==='page'&&zoomLevel===100);
 pages.classList.toggle('swipe-enabled',smallScreen()&&fitMode!==null&&zoomLevel===100);
 if(pdfDocument)renderPageView(pages,token,previous?direction:0);
}
async function renderPageView(container,token,direction=0){
 const documentRef=pdfDocument,slots=visiblePages();
 try{
  await new Promise(resolve=>requestAnimationFrame(resolve));
  const loaded=await Promise.all(slots.map(pageNumber=>pageNumber===null?null:documentRef.getPage(pageNumber)));
   if(token!==spreadRenderToken||documentRef!==pdfDocument)return;
  const real=loaded.filter(Boolean),base=real.map(page=>page.getViewport({scale:1}));
  const maxWidth=Math.max(...base.map(view=>view.width)),maxHeight=Math.max(...base.map(view=>view.height));
   const padding=fitMode==='page'?10:Math.min(28,Math.max(12,container.clientWidth*.02)),gap=0,slotCount=twoPage?2:1;
   const widthScale=Math.max(.1,(container.clientWidth-padding*2-gap*(slotCount-1))/(maxWidth*slotCount));
  const heightScale=Math.max(.1,(container.clientHeight-padding*2)/maxHeight);
  const fitScale=fitMode==='width'?widthScale:Math.min(widthScale,heightScale);
  const scale=fitScale*(zoomLevel/100);
  const reference=real[0].getViewport({scale}),referenceWidth=Math.max(1,Math.round(reference.width)),referenceHeight=Math.max(1,Math.round(reference.height));
  const stage=document.createElement('div');stage.className='spread-stage';stage.style.setProperty('--spread-padding',padding+'px');
  const renderItems=[],blankRenders=[];
  loaded.forEach((page,index)=>{
   const sideClass=twoPage?(index===0?'spread-left':'spread-right'):'spread-single';
   if(!page){
    const blank=document.createElement('canvas'),ratio=spreadRenderRatio(referenceWidth,referenceHeight);
    blank.className='spread-blank '+sideClass;blank.setAttribute('aria-label','빈 페이지');
    blank.width=Math.ceil(referenceWidth*ratio);blank.height=Math.ceil(referenceHeight*ratio);
    blank.style.width=referenceWidth+'px';blank.style.height=referenceHeight+'px';
    const context=blank.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,blank.width,blank.height);
    if((index===0&&slots[1]===1)||(index===1&&slots[0]===totalPages)){
     blank.setAttribute('aria-label','표지 이미지');
     blankRenders.push(drawBlankCover(blank,referenceWidth,referenceHeight,ratio,index===0));
    }
    stage.appendChild(blank);return;
   }
   const display=page.getViewport({scale}),displayWidth=Math.max(1,Math.round(display.width)),displayHeight=Math.max(1,Math.round(display.height));
   const outputScale=spreadRenderRatio(displayWidth,displayHeight);
   const canvas=document.createElement('canvas');canvas.className='spread-page '+sideClass;canvas.width=Math.ceil(displayWidth*outputScale);canvas.height=Math.ceil(displayHeight*outputScale);canvas.style.width=displayWidth+'px';canvas.style.height=displayHeight+'px';canvas.setAttribute('aria-label',slots[index]+'쪽');stage.appendChild(canvas);renderItems.push({page,canvas,display,outputScale});
  });
  // Keep the finished spread visible while the next canvases render off screen.
  stage.hidden=!!direction;
  if(direction){stage.classList.add('spread-pending');stage.style.visibility='hidden'}
  container.appendChild(stage);
  spreadRenderTasks=renderItems.map(item=>item.page.render({canvasContext:item.canvas.getContext('2d',{alpha:false}),viewport:item.display,transform:[item.outputScale,0,0,item.outputScale,0,0],background:'#fff'}));
  await Promise.all([...spreadRenderTasks.map(task=>task.promise),...blankRenders]);
  if(token!==spreadRenderToken||documentRef!==pdfDocument)return;
  spreadRenderTasks=[];
  if(direction){
   const previous=container.querySelector('.spread-stage:not([hidden])');
   stage.hidden=false;
   await animateSpreadTurn(container,previous,stage,direction);
   if(token===spreadRenderToken){stage.style.visibility='';stage.classList.remove('spread-pending');container.replaceChildren(stage)}
  }
 }catch(error){if(error?.name!=='RenderingCancelledException'&&token===spreadRenderToken)info('두 쪽 보기를 표시하지 못했습니다: '+error.message,true)}
 finally{if(token===spreadRenderToken)pageTurnBusy=false}
}
async function animateSpreadTurn(container,previous,stage,direction){
 if(!previous||!window.St?.PageFlip)return;
 const spread=twoPage,oldPages=[...previous.children],newPages=[...stage.children];
 // Portrait flipPrev slides its back face. Mirror the same curl used by flipNext instead.
 const mirrored=!spread&&direction<0,turnDirection=mirrored?1:direction;
 const first=oldPages[0],rect=first.getBoundingClientRect(),surface=container.getBoundingClientRect();
 const host=document.createElement('div');host.className='book-turn-layer';host.setAttribute('aria-hidden','true');
 // Do not show a second static copy before the actual paper movement starts.
 host.style.visibility='hidden';
 host.style.left=(rect.left-surface.left+container.scrollLeft)+'px';host.style.top=(rect.top-surface.top+container.scrollTop)+'px';
 host.style.width=(rect.width*(spread?2:1))+'px';host.style.height=rect.height+'px';
 if(mirrored)host.style.transform='scaleX(-1) translateZ(0)';
 const images=[];
 const ordered=turnDirection>0?[...oldPages,...newPages]:[...newPages,...oldPages];
 const leaves=ordered.map(source=>{
  const leaf=document.createElement('div');leaf.className='book-turn-leaf';leaf.dataset.density='soft';
  if(source instanceof HTMLCanvasElement){
   // The engine clones portrait leaves; images retain their pixels when cloned, canvases do not.
   const image=document.createElement('img');image.alt='';image.src=source.toDataURL('image/png');
   if(mirrored)image.style.transform='scaleX(-1)';
   images.push(image);leaf.appendChild(image);
  }
  host.appendChild(leaf);return leaf;
 });
 await Promise.all(images.map(image=>image.decode()));
 if(!previous.isConnected||!stage.isConnected)return;
 container.appendChild(host);
 let flip,timer,finish,started=false;
 try{
  await new Promise((resolve,reject)=>{
   let done=false;
   finish=()=>{if(done)return;done=true;clearTimeout(timer);resolve()};
   cancelPageTurn=finish;
   timer=setTimeout(finish,2200);
   try{
    flip=new window.St.PageFlip(host,{
     width:rect.width,height:rect.height,size:'fixed',autoSize:false,
     usePortrait:!spread,startPage:turnDirection>0?0:(spread?2:1),showCover:false,
     drawShadow:true,maxShadowOpacity:.35,flippingTime:650,
     // Input is handled by our reader; corner checks would block portrait flipPrev().
     useMouseEvents:false,showPageCorners:false,disableFlipByClick:false,
     mobileScrollSupport:false
    });
    flip.on('changeState',event=>{if(event.data==='flipping')started=true;else if(started&&event.data==='read')finish()});
    flip.on('init',()=>{
     if(done)return;
     stage.style.visibility='hidden';
     // Keep the original spread underneath until the overlay has painted.
     requestAnimationFrame(()=>requestAnimationFrame(()=>{
      if(done)return;
      if(turnDirection>0)flip.flipNext('bottom');else flip.flipPrev('bottom');
      host.style.visibility='';
     }));
    });
    flip.loadFromHTML(leaves);
   }catch(error){clearTimeout(timer);reject(error)}
  });
 }finally{
  if(cancelPageTurn===finish)cancelPageTurn=null;
  clearTimeout(timer);flip?.destroy();host.remove();
  previous.style.visibility='';stage.style.visibility='';
 }
}
function goToPage(pageNumber){
 if(!totalPages)return;
 const next=normalizePage(pageNumber);
 if(next===currentPage){updatePageControls();return}
 const direction=next>currentPage?1:-1;
 currentPage=next;updatePageControls();renderNativePages(direction);
}
function submitPageInput(){
 const input=$('currentPage'),value=input.value.trim(),requested=Number(value);
 if(!value||!Number.isInteger(requested)){updatePageControls();return}
 goToPage(requested);
}
function previousPage(){return twoPage?(currentPage<=2?1:currentPage-2):currentPage-1}
function nextPage(){return twoPage?(currentPage===1?2:currentPage+2):currentPage+1}
function setZoom(next){
 if(!currentBookUrl)return;
 const value=Math.max(50,Math.min(200,next));if(value===zoomLevel&&fitMode===null)return;
 zoomLevel=value;fitMode=null;updatePageControls();renderNativePages();
}
function setFitMode(mode){
 if(!currentBookUrl||fitMode===mode)return;
 fitMode=mode;zoomLevel=100;updatePageControls();renderNativePages();
}
function setTwoPage(enabled){
 if(!currentBookUrl)return;
 if(enabled&&mobilePortrait())return;
 if(twoPage===enabled)return;twoPage=enabled;currentPage=normalizePage(currentPage);
 updatePageControls();renderNativePages();
}
async function openBook(index,options={}){
 const token=++openToken;
 cancelSpreadRendering();
 if(pageInfoTask){pageInfoTask.destroy().catch(()=>{});pageInfoTask=null}
 if(pdfDocument){pdfDocument.destroy().catch(()=>{});pdfDocument=null}
 const book=books[index];
 const url=new URL(link(book.file),location.href);
 if(url.origin!==location.origin){info('같은 사이트의 PDF만 열 수 있습니다.',true);return}
 document.querySelectorAll('.chapter').forEach((button,i)=>{button.classList.toggle('active',i===index);button.setAttribute('aria-current',i===index?'true':'false')});
 document.querySelectorAll('.mobile-toc-option').forEach((button,i)=>{const active=i===index;button.classList.toggle('active',active);button.setAttribute('aria-selected',String(active))});
 setMobileTocOpen(false);
 document.querySelector('.main').classList.remove('is-home');$('welcome').hidden=true;$('viewer').classList.remove('is-welcome');
 $('sidebar').classList.remove('open');syncMenu();
 currentBookIndex=index;currentBookUrl=url.href;currentPage=1;totalPages=0;zoomLevel=100;updatePageControls();
 // The native toolbar is replaced by the simpler site-owned page bar.
 renderNativePages();
 info('페이지 정보를 불러오는 중입니다…');
 try{
  const loading=pdfjsLib.getDocument({url:url.href});pageInfoTask=loading;
  const documentRef=await loading.promise;
  if(token!==openToken){await documentRef.destroy();return}
  pdfDocument=documentRef;totalPages=documentRef.numPages;pageInfoTask=null;
  if(Number.isInteger(options.page))currentPage=normalizePage(Math.max(1,Math.min(totalPages,options.page)));
  updatePageControls();renderNativePages();$('message').hidden=true;
 }catch(error){
  if(token===openToken){pageInfoTask=null;info('페이지 수를 확인하지 못했습니다: '+error.message,true)}
 }
}
$('firstPage').onclick=()=>goToPage(1);
$('prevPage').onclick=()=>goToPage(previousPage());
$('nextPage').onclick=()=>goToPage(nextPage());
$('lastPage').onclick=()=>goToPage(lastPageStart());
$('edgePrev').onclick=()=>goToPage(previousPage());
$('edgeNext').onclick=()=>goToPage(nextPage());
$('mobileFirstPage').onclick=()=>{goToPage(1);setMobileToolsOpen(false)};
$('mobileLastPage').onclick=()=>{goToPage(lastPageStart());setMobileToolsOpen(false)};
$('currentPage').addEventListener('change',submitPageInput);
$('currentPage').addEventListener('focus',event=>event.currentTarget.select());
$('currentPage').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();event.stopPropagation();submitPageInput();event.currentTarget.blur()}else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();updatePageControls();event.currentTarget.blur()}});
$('zoomOut').onclick=()=>setZoom(zoomLevel-10);
$('zoomIn').onclick=()=>setZoom(zoomLevel+10);
$('fitWidth').onclick=()=>{setFitMode('width');if(smallScreen())setMobileToolsOpen(false)};
$('fitPage').onclick=()=>{setFitMode('page');if(smallScreen())setMobileToolsOpen(false)};
$('singlePageMode').onclick=()=>{setTwoPage(false);if(smallScreen())setMobileToolsOpen(false)};
$('twoPageMode').onclick=()=>{setTwoPage(true);if(smallScreen())setMobileToolsOpen(false)};
$('mobileZoomOut').onclick=()=>setZoom(zoomLevel-10);
$('mobileZoomIn').onclick=()=>setZoom(zoomLevel+10);
$('mobileFitWidth').onclick=()=>setFitMode('width');
$('mobileFitPage').onclick=()=>setFitMode('page');
$('mobileSinglePageMode').onclick=()=>setTwoPage(false);
$('mobileTwoPageMode').onclick=()=>setTwoPage(true);
$('bookmarkSave').onclick=saveBookmark;
$('downloadOriginal').onclick=downloadOriginal;
$('bookmarkGo').onclick=goToBookmark;
$('bookmarkDelete').onclick=deleteBookmark;
const smallScreen=()=>window.matchMedia('(max-width:760px), (max-width:1000px) and (pointer:coarse)').matches;
const mobilePortrait=()=>smallScreen()&&window.matchMedia('(orientation:portrait)').matches;
function syncMobileViewportHeight(){if(smallScreen())document.documentElement.style.setProperty('--reader-viewport-height',window.innerHeight+'px');else document.documentElement.style.removeProperty('--reader-viewport-height')}
function syncMenu(){
 const expanded=smallScreen()?$('sidebar').classList.contains('open'):!document.querySelector('.layout').classList.contains('sidebar-collapsed');
 $('menu').textContent=expanded?'☰ 목차 접기':'☰ 목차 열기';$('menu').setAttribute('aria-expanded',String(expanded));
}
let resizeTimer=null;
function scheduleSpreadRender(){clearTimeout(resizeTimer);if(pdfDocument)resizeTimer=setTimeout(renderNativePages,120)}
$('menu').onclick=()=>{if(smallScreen())$('sidebar').classList.toggle('open');else document.querySelector('.layout').classList.toggle('sidebar-collapsed');syncMenu();scheduleSpreadRender()};
function setMobileToolsOpen(open){$('readerPagebar').classList.toggle('more-open',open);$('mobileMore').setAttribute('aria-expanded',String(open))}
function setMobileTocOpen(open){const toc=document.querySelector('.mobile-toc');toc.classList.remove('attention');$('mobileTocMenu').hidden=!open;$('mobileTocButton').setAttribute('aria-expanded',String(open));toc.classList.toggle('open',open)}
$('mobileTocButton').onclick=event=>{event.stopPropagation();const open=$('mobileTocMenu').hidden;setMobileToolsOpen(false);setMobileTocOpen(open)};
$('mobileMore').onclick=event=>{event.stopPropagation();setMobileTocOpen(false);setMobileToolsOpen(!$('readerPagebar').classList.contains('more-open'))};
document.addEventListener('pointerdown',event=>{if(!smallScreen())return;if(!$('readerPagebar').contains(event.target))setMobileToolsOpen(false);if(!document.querySelector('.mobile-toc').contains(event.target))setMobileTocOpen(false)});
function focusReading(enabled){const button=$('focusMode'),label=enabled?'집중 해제':'집중';document.querySelector('.layout').classList.toggle('focus-reading',enabled);button.setAttribute('aria-pressed',String(enabled));button.setAttribute('aria-label',enabled?'집중 모드 종료':'집중 모드 시작');button.title=label;button.querySelector('span').textContent=label;scheduleSpreadRender()}
$('focusMode').onclick=()=>{focusReading(!document.querySelector('.layout').classList.contains('focus-reading'));if(smallScreen())setMobileToolsOpen(false)};
document.addEventListener('keydown',event=>{
 if(event.key==='Escape'&&!$('mobileTocMenu').hidden){setMobileTocOpen(false);$('mobileTocButton').focus();return}
 if(event.key==='Escape'&&$('readerPagebar').classList.contains('more-open')){setMobileToolsOpen(false);return}
 if(event.key==='Escape'){focusReading(false);return}
 if(event.target instanceof HTMLInputElement)return;
 if(event.key==='ArrowLeft')goToPage(previousPage());
 if(event.key==='ArrowRight')goToPage(nextPage());
});
const pageSurface=$('nativePages');
let swipeStart=null,pinchState=null,mouseStart=null;
pageSurface.addEventListener('pointerdown',event=>{
 mouseStart=null;
 if(smallScreen()||event.pointerType!=='mouse'||event.button!==0||zoomLevel!==100||pageTurnBusy)return;
 const page=event.target.closest('.spread-page,.spread-blank');
 if(page)mouseStart={page,x:event.clientX,y:event.clientY,id:event.pointerId};
});
pageSurface.addEventListener('pointerup',event=>{
 const start=mouseStart;mouseStart=null;
 if(!start||start.id!==event.pointerId||smallScreen()||pageTurnBusy||zoomLevel!==100||event.button!==0)return;
 if(Math.hypot(event.clientX-start.x,event.clientY-start.y)>6||!start.page.contains(event.target))return;
 const rect=start.page.getBoundingClientRect();
 const backwards=twoPage?start.page.classList.contains('spread-left'):(event.clientX-rect.left)/rect.width<.5;
 goToPage(backwards?previousPage():nextPage());
});
pageSurface.addEventListener('pointercancel',()=>{mouseStart=null});
const touchDistance=touches=>Math.hypot(touches[0].clientX-touches[1].clientX,touches[0].clientY-touches[1].clientY);
pageSurface.addEventListener('touchstart',event=>{
 if(!smallScreen())return;
 if(event.touches.length===2){
  event.preventDefault();swipeStart=null;
  const stage=pageSurface.querySelector('.spread-stage'),rect=stage?.getBoundingClientRect();
  const centerX=(event.touches[0].clientX+event.touches[1].clientX)/2,centerY=(event.touches[0].clientY+event.touches[1].clientY)/2;
  pinchState={distance:touchDistance(event.touches),startZoom:zoomLevel,targetZoom:zoomLevel,fit:fitMode,stage};
  if(stage&&rect){stage.style.transformOrigin=((centerX-rect.left)/rect.width*100)+'% '+((centerY-rect.top)/rect.height*100)+'%'}
 }else if(event.touches.length===1&&pageSurface.classList.contains('swipe-enabled')){
  const touch=event.touches[0];swipeStart={x:touch.clientX,y:touch.clientY,time:performance.now()};
 }
},{passive:false});
pageSurface.addEventListener('touchmove',event=>{
 if(!smallScreen())return;
 if(pinchState&&event.touches.length===2){
  event.preventDefault();const ratio=touchDistance(event.touches)/Math.max(1,pinchState.distance);
  pinchState.targetZoom=Math.max(50,Math.min(200,pinchState.startZoom*ratio));
  if(pinchState.stage)pinchState.stage.style.transform='scale('+(pinchState.targetZoom/pinchState.startZoom)+')';
  const pinchLabel=Math.round(pinchState.targetZoom)+'%';$('readerZoomLabel').textContent=pinchLabel;$('mobileZoomLabel').textContent=pinchLabel;return;
 }
 if(swipeStart&&event.touches.length===1){const touch=event.touches[0],dx=touch.clientX-swipeStart.x,dy=touch.clientY-swipeStart.y;if(Math.abs(dx)>Math.abs(dy)&&Math.abs(dx)>8)event.preventDefault()}
},{passive:false});
pageSurface.addEventListener('touchend',event=>{
 if(!smallScreen())return;
 if(pinchState&&event.touches.length<2){
  const state=pinchState;pinchState=null;swipeStart=null;if(state.stage){state.stage.style.transform='';state.stage.style.transformOrigin=''}
  zoomLevel=Math.max(50,Math.min(200,Math.round(state.targetZoom/5)*5));fitMode=state.fit;updatePageControls();renderNativePages();return;
 }
 if(!event.touches.length&&swipeStart){
  const touch=event.changedTouches[0],dx=touch.clientX-swipeStart.x,dy=touch.clientY-swipeStart.y,elapsed=performance.now()-swipeStart.time,threshold=Math.max(42,pageSurface.clientWidth*.1);swipeStart=null;
  if(elapsed<900&&Math.abs(dx)>=threshold&&Math.abs(dx)>Math.abs(dy)*1.2){setMobileToolsOpen(false);goToPage(dx<0?nextPage():previousPage())}
 }
},{passive:true});
pageSurface.addEventListener('touchcancel',()=>{if(pinchState?.stage){pinchState.stage.style.transform='';pinchState.stage.style.transformOrigin=''}pinchState=null;swipeStart=null;updatePageControls()},{passive:true});
window.addEventListener('orientationchange',()=>setTimeout(()=>{
 syncMobileViewportHeight();setMobileToolsOpen(false);setMobileTocOpen(false);
 if(mobilePortrait()){twoPage=false;fitMode='page';zoomLevel=100}
 else if(smallScreen()){fitMode='width';zoomLevel=100}
 updatePageControls();renderNativePages();
},120));
document.addEventListener('contextmenu',event=>event.preventDefault());
window.addEventListener('resize',()=>{syncMobileViewportHeight();syncMenu();scheduleSpreadRender()});
syncMobileViewportHeight();syncMenu();loadBooks();
