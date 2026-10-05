/* Juniper's browser is a view of the durable workflow, never the queue runner. */
const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
const TIME_ZONE = 'America/Phoenix';
const WAITLIST_KEY = 'juniper-waitlist-v2';
const OPENINGS_KEY = 'juniper-opening-ids-v1';
const e = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const dateFormatter = new Intl.DateTimeFormat('en-US', {timeZone:TIME_ZONE, month:'short', day:'numeric'});
const timeFormatter = new Intl.DateTimeFormat('en-US', {timeZone:TIME_ZONE, hour:'numeric', minute:'2-digit'});
const fullDateFormatter = new Intl.DateTimeFormat('en-US', {timeZone:TIME_ZONE, weekday:'short', month:'short', day:'numeric'});
const localFormatter = new Intl.DateTimeFormat('sv-SE', {timeZone:TIME_ZONE, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false});
const safeDate = value => value && !Number.isNaN(new Date(value).getTime()) ? new Date(value) : null;
const fmtDate = value => safeDate(value) ? dateFormatter.format(new Date(value)) : 'Date pending';
const fmtTime = value => safeDate(value) ? timeFormatter.format(new Date(value)) : 'Time pending';
const fmtFullDate = value => safeDate(value) ? fullDateFormatter.format(new Date(value)) : 'Date pending';
const localInput = value => safeDate(value) ? localFormatter.format(new Date(value)).replace(' ', 'T') : '';
const fromPhoenix = value => new Date(`${value}:00-07:00`).toISOString();
const humanTimeline = message => String(message || '').replaceAll('—', ':').replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, value => `${fmtFullDate(value)} at ${fmtTime(value)} Phoenix`);
const initials = name => String(name || '?').split(' ').filter(Boolean).slice(0,2).map(part=>part[0]).join('').toUpperCase();
function storageGet(key, fallback) { try { const value = JSON.parse(localStorage.getItem(key)); return value ?? fallback; } catch { return fallback; } }
function storageSet(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { toast('Browser storage is unavailable. Keep this tab open to retain local waitlist edits.'); } }
function nextDay() { const day = new Date(Date.now()+86400000); return localInput(day).slice(0,10); }
function seededClients() {
  const day=nextDay(); const from=fromPhoenix(`${day}T09:00`); const until=fromPhoenix(`${day}T18:00`);
  return [
    {id:'demo-maya',name:'Maya Chen',mobile:'+1 602 555 0101',service:'Cut & finish',preferredStylist:'Lena',availableFrom:from,availableUntil:until,joinedAt:new Date(Date.now()-7*86400000).toISOString()},
    {id:'demo-jordan',name:'Jordan Ellis',mobile:'+1 602 555 0102',service:'Cut & finish',preferredStylist:null,availableFrom:from,availableUntil:until,joinedAt:new Date(Date.now()-5*86400000).toISOString()},
    {id:'demo-sofia',name:'Sofia Martinez',mobile:'+1 602 555 0103',service:'Cut & finish',preferredStylist:'Lena',availableFrom:from,availableUntil:until,joinedAt:new Date(Date.now()-3*86400000).toISOString()},
    {id:'demo-avery',name:'Avery Brooks',mobile:'+1 602 555 0104',service:'Color refresh',preferredStylist:'Carla',availableFrom:from,availableUntil:until,joinedAt:new Date(Date.now()-6*86400000).toISOString()},
    {id:'demo-nina',name:'Nina Patel',mobile:'+1 602 555 0105',service:'Blowout',preferredStylist:null,availableFrom:from,availableUntil:until,joinedAt:new Date(Date.now()-2*86400000).toISOString()},
    {id:'demo-olivia',name:'Olivia Reed',mobile:'+1 602 555 0106',service:'Cut & finish',preferredStylist:'Carla',availableFrom:from,availableUntil:until,joinedAt:new Date(Date.now()-4*86400000).toISOString()},
    {id:'demo-alex',name:'Alex Kim',mobile:'+1 602 555 0107',service:'Cut & finish',preferredStylist:null,availableFrom:from,availableUntil:until,joinedAt:new Date(Date.now()-8*86400000).toISOString(),optedOut:true}
  ];
}
let toastTimer;
let waitlist = storageGet(WAITLIST_KEY,null);
if (!Array.isArray(waitlist)) { waitlist=seededClients(); storageSet(WAITLIST_KEY,waitlist); }
let openings = [];
let openingIds = storageGet(OPENINGS_KEY,[]);
if (!Array.isArray(openingIds)) openingIds=[];
let refreshing=false, lastSignature='', connected=false;
const selectedOffers = new Map();
const responseResults = new Map();
const detailStates = new Map();
const busyOpenings = new Set();

function toast(message) { const box=$('#toast'); box.textContent=message; box.hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>box.hidden=true,6500); }
function setError(id,message) {const box=$(id);box.textContent=message || '';box.hidden=!message;}
async function api(path, options={}) {
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),12000);
  try {
    const response=await fetch(path,{...options,signal:controller.signal,headers:{'Content-Type':'application/json',...(options.headers||{})}});
    let body; try { body=await response.json(); } catch { throw new Error('The front desk server did not return a valid response.'); }
    if(!response.ok) throw new Error(body.error || body.message || `Request failed (${response.status}).`);
    return body;
  } catch(error) { if(error.name==='AbortError') throw new Error('The request is taking longer than expected. Please check the server and try again.'); throw error; }
  finally {clearTimeout(timer);}
}
const post=(path,body={})=>api(path,{method:'POST',body:JSON.stringify(body)});
async function applyOptOutToOpenings(candidateId) {
  const affected=openings.filter(state=>['offering','needs_attention','waiting_for_hours'].includes(state.phase) && state.candidates?.some(client=>client.id===candidateId && !client.optedOut));
  const outcomes=await Promise.allSettled(affected.map(state=>post(`/api/openings/${encodeURIComponent(state.workflowId)}/optout`,{candidateId})));
  const failed=[];
  outcomes.forEach((outcome,index)=>{
    const id=affected[index].workflowId;
    if(outcome.status==='rejected') {
      failed.push(id);
      responseResults.set(id,{ok:false,message:`Opt-out is saved for future openings, but could not be confirmed for this opening: ${outcome.reason.message}. Retry STOP to withdraw any pending offer.`});
    } else {
      responseResults.set(id,{ok:true,message:'Text opt-out saved. Any pending offer is withdrawn; future openings will skip this client.'});
    }
  });
  return {failed,updated:affected.length-failed.length};
}

function showView(view) {
  $$('.view').forEach(el=>el.hidden=el.id!==`view-${view}`);
  $$('.nav-item').forEach(el=>{el.classList.toggle('active',el.dataset.view===view);el.setAttribute('aria-current',el.dataset.view===view?'page':'false');});
  $('#breadcrumb-page').textContent=({openings:'Openings',waitlist:'Waitlist',guide:'Guide'})[view];
  if(view==='waitlist') renderWaitlist();
}
$$('[data-view]').forEach(button=>button.addEventListener('click',()=>showView(button.dataset.view)));
$('#opening-date').value=nextDay();
$('#opening-date').min=localInput(new Date()).slice(0,10);
$('#today-label').textContent=`${new Intl.DateTimeFormat('en-US',{timeZone:TIME_ZONE,weekday:'long',month:'long',day:'numeric'}).format(new Date()).toUpperCase()} · PHOENIX`;
function slotFromForm() {
  return {service:$('#opening-service').value,stylist:$('#opening-stylist').value,startsAt:fromPhoenix(`${$('#opening-date').value}T${$('#opening-time').value}`),durationMinutes:Number($('#opening-duration').value)};
}
function eligibleForSlot(candidate,slot) {
  const start=new Date(slot.startsAt).getTime(); const end=start+slot.durationMinutes*60000;
  return !candidate.optedOut && candidate.service===slot.service && (!candidate.preferredStylist || candidate.preferredStylist===slot.stylist) && new Date(candidate.availableFrom).getTime()<=start && new Date(candidate.availableUntil).getTime()>=end;
}
function updateMatchPreview() {
  let count=0; try {const slot=slotFromForm();count=waitlist.filter(client=>eligibleForSlot(client,slot)).length;} catch{}
  $('#match-preview').innerHTML=`<strong>${count} matching client${count===1?'':'s'}</strong>${count?'':'<span>Adjust the opening or add a client.</span>'}`;
}
$('#opening-form').addEventListener('input',updateMatchPreview);
$('#opening-form').addEventListener('submit',async event=>{
  event.preventDefault();setError('#opening-error','');const button=$('#create-opening-button');
  try {
    const slot=slotFromForm();if(new Date(slot.startsAt).getTime()<=Date.now()) throw new Error('Choose an appointment time in the future (Phoenix time).');
    button.disabled=true;button.textContent='Starting the offer queue…';
    const demoMode=$('#opening-window').value==='20';
    const result=await post('/api/openings',{slot,waitlist,demoMode,offerWindowSeconds:demoMode?20:900});
    const id=result.workflowId || result.openingId;
    if(!id) throw new Error('The server did not return an opening ID.');
    openingIds=[...new Set([id,...openingIds])];storageSet(OPENINGS_KEY,openingIds);
    toast(demoMode?'Demo opening created. Simulated salon hours are open; each offer lasts 20 seconds.':'Opening created. Outreach follows Juniper’s Phoenix business hours.');
    await refresh(true);
  } catch(error) {setError('#opening-error',error.message);}
  finally {button.disabled=false;button.textContent='Start offers';}
});
function phaseLabel(state) {
  return ({offering:'Offer in progress',needs_attention:'Needs attention',filled:'Filled',unfilled:'Unfilled',cancelled:'Cancelled',waiting_for_hours:'Waiting for hours'})[state.phase] || 'Starting';
}
function phaseClass(state) {return state.phase==='offering'||state.phase==='waiting_for_hours'?'waiting':state.phase==='needs_attention'?'attention':state.phase;}
function renderStats() {
  const active=openings.filter(state=>['offering','needs_attention','waiting_for_hours'].includes(state.phase)).length;
  $('#stat-active').textContent=active;$('#nav-active').textContent=active;
  $('#stat-filled').textContent=openings.filter(state=>state.phase==='filled').length;
  $('#stat-waitlist').textContent=waitlist.length;$('#nav-waitlist').textContent=waitlist.length;
  $('#opening-count').textContent=openings.length;
}
function findClient(state,offer) {return state.candidates?.find(client=>client.id===offer?.candidateId) || {name:offer?.candidateName||'Client',mobile:'',id:offer?.candidateId};}
function openingCard(state) {
  const id=state.workflowId || state.openingId;const slot=state.slot || {};const offers=state.offers || [];const current=state.currentOffer;const candidates=state.candidates || [];
  const eligible=candidates.filter(candidate=>candidate.eligible);const contacted=new Set(offers.map(offer=>offer.candidateId));const remaining=eligible.filter(candidate=>!contacted.has(candidate.id)).length;
  const selectedId=selectedOffers.get(id);let chosen=offers.find(offer=>offer.id===selectedId) || offers.find(offer=>offer.id===current?.id) || offers[offers.length-1];
  if(chosen && !selectedId) selectedOffers.set(id,chosen.id);
  let offerHtml='';
  if(state.phase==='filled') {
    const client=state.acceptedCandidate || (current?findClient(state,current):{});
    offerHtml=`<div class="outcome-block"><h4 class="outcome-title">Accepted: update Square</h4><p><strong>${e(client.name || 'Your client')}</strong> claimed this opening. Add ${e(slot.service)} with ${e(slot.stylist)} on ${e(fmtFullDate(slot.startsAt))} at ${e(fmtTime(slot.startsAt))} to Square manually.</p></div>`;
  } else if(state.phase==='cancelled') {
    offerHtml='<div class="outcome-block neutral"><h4 class="outcome-title">Opening cancelled</h4><p>The pending offer is withdrawn. Outreach has stopped.</p></div>';
  } else if(state.phase==='unfilled') {
    offerHtml='<div class="outcome-block neutral"><h4 class="outcome-title">Unfilled</h4><p>No eligible client accepted. Outreach has stopped.</p></div>';
  } else if(state.phase==='waiting_for_hours') {
    offerHtml=`<div class="outcome-block neutral"><h4 class="outcome-title">Waiting for business hours</h4><p>New outreach waits for Tue–Sat, 9 AM–6 PM in Phoenix.${state.nextActionAt?` Next check: <strong>${e(fmtFullDate(state.nextActionAt))}, ${e(fmtTime(state.nextActionAt))}</strong>.`:''} Outreach stops when the appointment starts.</p></div>`;
  } else if(state.phase==='needs_attention') {
    const client=findClient(state,current);
    offerHtml=`<div class="outcome-block attention"><h4 class="outcome-title">Delivery failed</h4><p>The text to <strong>${e(client.name)}</strong> failed. Retry or move to the next client.</p><div class="outcome-actions"><button class="button small primary" data-delivery="retry" data-offer="${e(current?.id)}" ${busyOpenings.has(id)?'disabled':''}>Retry text</button><button class="button small secondary" data-delivery="skip" data-offer="${e(current?.id)}" ${busyOpenings.has(id)?'disabled':''}>Skip client</button></div></div>`;
  } else if(current) {
    const client=findClient(state,current);
    offerHtml=`<div class="offer-block"><p class="offer-label">${current.status==='sending'?'PREPARING OFFER':'CURRENT OFFER'}</p><div class="offer-main"><div class="offer-client"><strong>${e(client.name)}</strong><small>${e(client.mobile)} · ${current.status==='sending'?'Preparing the text':'Waiting for a reply'}</small></div><div class="countdown-box"><span class="countdown" data-expires="${e(current.expiresAt||'')}" data-sent="${e(current.sentAt||'')}">—:—</span><small>remaining</small></div></div><div class="timer-track"><div class="timer-fill" data-progress="${e(current.expiresAt||'')}" data-start="${e(current.sentAt||'')}"></div></div><div class="queue-summary"><span>Offer ${offers.length} of ${eligible.length} eligible clients</span><span>${remaining} next in line</span></div></div>`;
  } else {
    offerHtml='<div class="outcome-block neutral"><h4 class="outcome-title">Preparing opening</h4><p>Matching the waitlist.</p></div>';
  }
  const result=responseResults.get(id);
  const selectedClient=chosen?findClient(state,chosen):null;
  const expiry=chosen?.expiresAt?`${fmtTime(chosen.expiresAt)} Phoenix`:'the stated deadline';
  const sms=chosen?.message || (chosen?`Hi ${selectedClient.name.split(' ')[0]}, a ${slot.service} opening with ${slot.stylist} is available ${fmtFullDate(slot.startsAt)} at ${fmtTime(slot.startsAt)} Phoenix. Reply YES by ${expiry} to claim it, or NO to pass.`:'');
  const simulator=chosen?`<details class="simulator" data-detail="simulator" ${detailStates.get(`${id}-simulator`)?'open':''}><summary class="simulator-summary">Preview offer & test a reply <span>Simulated</span></summary><div class="simulator-content"><label for="offer-${e(id)}">Client offer (includes past offers)</label><select id="offer-${e(id)}" data-offer-select>${offers.map(offer=>`<option value="${e(offer.id)}" ${offer.id===chosen.id?'selected':''}>${e(findClient(state,offer).name)}: ${e(offer.status.replaceAll('_',' '))}</option>`).join('')}</select><div class="sms-preview">${e(sms)}<small>Simulated SMS · ${chosen.sentAt?e(fmtTime(chosen.sentAt)):'not delivered'}${chosen.expiresAt?` · expires ${e(fmtTime(chosen.expiresAt))}${state.demoMode?' (20-second demo)':''}`:''}</small></div><div class="simulator-actions"><button class="button primary" data-respond="accept" data-offer="${e(chosen.id)}" data-candidate="${e(chosen.candidateId)}" ${busyOpenings.has(id)||chosen.status==='sending'||chosen.status==='delivery_failed'?'disabled':''}>Reply YES · accept</button><button class="button secondary" data-respond="decline" data-offer="${e(chosen.id)}" data-candidate="${e(chosen.candidateId)}" ${busyOpenings.has(id)||chosen.status==='sending'||chosen.status==='delivery_failed'?'disabled':''}>Reply NO · decline</button></div><button class="text-button optout-button" data-optout="${e(chosen.candidateId)}" ${busyOpenings.has(id)?'disabled':''}>Reply STOP · opt out of texts</button>${result?`<p class="response-result ${result.ok?'':'error'}" role="status">${e(result.message)}</p>`:''}</div></details>`:'';
  const timeline=(state.timeline||[]).slice().reverse();
  const active=['offering','needs_attention','waiting_for_hours'].includes(state.phase);
  return `<article class="opening-card ${e(state.phase)}" data-opening="${e(id)}"><div class="opening-top"><div><h3>${e(slot.service || 'New opening')}</h3><div class="opening-meta">${e(fmtFullDate(slot.startsAt))} <span>·</span> ${e(fmtTime(slot.startsAt))} Phoenix<br>${e(slot.stylist)} <span>·</span> ${e(slot.durationMinutes)} min${state.demoMode?' <span>·</span> Demo: open salon':''}</div></div><span class="status-pill ${e(phaseClass(state))}">${e(phaseLabel(state))}</span></div>${offerHtml}${simulator}${!chosen&&result?`<p class="action-feedback response-result ${result.ok?'':'error'}" role="status">${e(result.message)}</p>`:''}<div class="card-details"><details data-detail="timeline" ${detailStates.get(`${id}-timeline`)?'open':''}><summary>Opening timeline <span>${timeline.length} events</span></summary><ol class="timeline">${timeline.length?timeline.map(event=>`<li><time>${e(fmtDate(event.at))} · ${e(fmtTime(event.at))} Phoenix</time>${e(humanTimeline(event.message))}</li>`).join(''):'<li>Opening is being prepared.</li>'}</ol></details><details data-detail="eligibility" ${detailStates.get(`${id}-eligibility`)?'open':''}><summary>Matching clients <span>${eligible.length} eligible / ${candidates.length} total</span></summary><ul class="candidate-list">${candidates.map(candidate=>`<li><span>${e(candidate.name)}</span><span class="${candidate.eligible?'eligible':''}">${candidate.eligible?'Eligible':e((candidate.reason || 'Not a match').replaceAll('—', ':'))}</span></li>`).join('')}</ul></details></div><div class="card-bottom"><small title="${e(id)}" aria-label="Opening ${e(id)}. Saved durably.">Opening ${e(id.slice(-8))} · Saved durably</small>${active?'<button class="text-button" data-cancel>Cancel this opening</button>':'<small>Queue closed</small>'}</div></article>`;
}
function renderOpenings(force=false) {
  renderStats(); const signature=JSON.stringify(openings);
  if(!force && signature===lastSignature) {updateCountdowns();return;}
  lastSignature=signature;
  $('#openings-list').innerHTML=openings.length?openings.map(openingCard).join(''):`<div class="empty-state"><h3>No openings yet</h3><p>Add a service, stylist and time to begin.</p></div>`;
  $$('#openings-list details').forEach(details=>details.addEventListener('toggle',()=>{const id=details.closest('[data-opening]').dataset.opening;detailStates.set(`${id}-${details.dataset.detail}`,details.open);}));
  updateCountdowns();
}
function updateCountdowns() {
  $$('[data-expires]').forEach(element=>{const expires=new Date(element.dataset.expires).getTime();const seconds=Number.isFinite(expires)?Math.max(0,Math.ceil((expires-Date.now())/1000)):null;element.textContent=seconds===null?'Pending':seconds===0?'0:00':`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;element.setAttribute('aria-label',seconds===null?'Preparing offer; reply window starts after delivery':seconds===0?'Reply deadline reached; awaiting workflow update':`${Math.floor(seconds/60)} minutes ${seconds%60} seconds remaining`);});
  $$('[data-progress]').forEach(element=>{const end=new Date(element.dataset.progress).getTime();const start=new Date(element.dataset.start).getTime();const percentage=Math.max(0,Math.min(100,100*(end-Date.now())/(end-start)));element.style.width=`${Number.isFinite(percentage)?percentage:100}%`;});
}
async function refresh(force=false) {
  if(refreshing)return;refreshing=true;
  try {
    const result=await api('/api/openings');
    let rows=Array.isArray(result)?result:result.openings;
    if(!Array.isArray(rows))throw new Error('Unable to read opening list.');
    const fresh=rows.filter(Boolean);
    const missingIds=openingIds.filter(id=>!fresh.some(state=>state.workflowId===id));
    if(missingIds.length && force) {
      const missing=await Promise.allSettled(missingIds.slice(0,5).map(id=>api(`/api/openings/${encodeURIComponent(id)}`)));
      missing.forEach(result=>{if(result.status==='fulfilled')fresh.push(result.value);});
    }
    if(result.unavailableCount) {
      openings.forEach(previous=>{if(!fresh.some(state=>state.workflowId===previous.workflowId))fresh.push(previous);});
    }
    openings=fresh.sort((a,b)=>new Date(b.createdAt||b.slot?.startsAt)-new Date(a.createdAt||a.slot?.startsAt));
    openingIds=[...new Set(openings.map(state=>state.workflowId||state.openingId).concat(openingIds))];storageSet(OPENINGS_KEY,openingIds);
    connected=true;$('#connection-banner').hidden=!result.unavailableCount;
    if(result.unavailableCount) $('#connection-banner').textContent='Some workflows are temporarily unavailable. Showing their last known state; the original deadlines still apply.';
    $('#sync-label').textContent=result.unavailableCount?'Partial connection':'Live updates';renderOpenings(force);
  } catch(error) {
    connected=false;$('#connection-banner').textContent=`Front desk connection interrupted. ${error.message} Existing workflows keep their original deadlines.`;$('#connection-banner').hidden=false;$('#sync-label').textContent='Reconnecting';
  } finally {refreshing=false;}
}
$('#openings-list').addEventListener('change',event=>{
  if(event.target.matches('[data-offer-select]')) {selectedOffers.set(event.target.closest('[data-opening]').dataset.opening,event.target.value);renderOpenings(true);}
});
$('#openings-list').addEventListener('click',async event=>{
  const button=event.target.closest('button');if(!button)return;const card=button.closest('[data-opening]');if(!card)return;
  const id=card.dataset.opening;if(busyOpenings.has(id))return;
  const base=`/api/openings/${encodeURIComponent(id)}`;
  if(button.hasAttribute('data-cancel') && !confirm('Cancel this opening and withdraw any outstanding offer?'))return;
  busyOpenings.add(id);button.disabled=true;
  try {
    if(button.dataset.respond) {
      const result=await post(`${base}/respond`,{offerId:button.dataset.offer,candidateId:button.dataset.candidate,decision:button.dataset.respond,requestId:crypto.randomUUID()});
      responseResults.set(id,{ok:result.ok,message:result.message || (result.ok?'Reply received.':'That opening is no longer available for this offer.')});
    } else if(button.dataset.delivery) {
      const result=await post(`${base}/delivery-action`,{offerId:button.dataset.offer,action:button.dataset.delivery});toast(result.message || (button.dataset.delivery==='retry'?'Delivery retry requested.':'Client skipped; continuing the queue.'));
    } else if(button.hasAttribute('data-cancel')) {
      const result=await post(`${base}/cancel`,{reason:'Cancelled by Juniper staff'});toast(result.message || 'Opening cancelled Outstanding offer withdrawn.');
    } else if(button.dataset.optout) {
      waitlist=waitlist.map(client=>client.id===button.dataset.optout?{...client,optedOut:true}:client);storageSet(WAITLIST_KEY,waitlist);updateMatchPreview();
      const result=await applyOptOutToOpenings(button.dataset.optout);
      if(!result.failed.includes(id)) responseResults.set(id,{ok:true,message:'Text opt-out saved to the local waitlist and confirmed for every reachable active opening. Future openings will skip this client.'});
      if(result.failed.length) toast(`Opt-out saved, but ${result.failed.length} active opening${result.failed.length===1?' needs':'s need'} another attempt. See the opening’s reply status.`);
    }
    await refresh(true);
  } catch(error) {const message=button.dataset.optout?`Opt-out saved for future openings. Could not confirm this opening's update: ${error.message}`:error.message;responseResults.set(id,{ok:false,message});toast(message);}
  finally {busyOpenings.delete(id);renderOpenings(true);}
});
function renderWaitlist() {
  const clients=waitlist.slice().sort((a,b)=>new Date(a.joinedAt)-new Date(b.joinedAt));
  $('#waitlist-count').textContent=clients.length;renderStats();
  $('#waitlist-table').innerHTML=clients.length?`<div class="table-scroll"><table class="waitlist-table"><thead><tr><th>Client</th><th>Preference</th><th>Availability · Phoenix</th><th>Joined</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${clients.map(client=>`<tr><td><div class="table-client"><div><strong>${e(client.name)}</strong><small>${e(client.mobile)}</small>${client.optedOut?'<small class="failure-note">Opted out · no texts</small>':''}${client.simulateFailure?'<small class="failure-note">Demo: first text fails</small>':''}</div></div></td><td>${e(client.service)}<small>${e(client.preferredStylist || 'Any stylist')}</small></td><td>${e(fmtDate(client.availableFrom))}, ${e(fmtTime(client.availableFrom))}<small>until ${e(fmtDate(client.availableUntil))}, ${e(fmtTime(client.availableUntil))}</small></td><td>${e(fmtDate(client.joinedAt))}<small>${e(fmtTime(client.joinedAt))}</small></td><td><div class="row-actions"><button data-edit-client="${e(client.id)}">Edit</button><button data-delete-client="${e(client.id)}" aria-label="Remove ${e(client.name)}">Remove</button></div></td></tr>`).join('')}</tbody></table></div>`:'<p class="waitlist-empty">Your waitlist is ready for its first client.<br>Add someone to get started.</p>';
}
function openClientDialog(id) {
  const client=waitlist.find(client=>client.id===id);const day=nextDay();
  $('#client-dialog-title').textContent=client?'Edit client details':'Add client';
  $('#client-id').value=client?.id||'';$('#client-name').value=client?.name||'';$('#client-mobile').value=client?.mobile||'';
  $('#client-service').value=client?.service||'Cut & finish';$('#client-stylist').value=client?.preferredStylist||'';
  $('#client-from').value=client?localInput(client.availableFrom):`${day}T09:00`;
  $('#client-until').value=client?localInput(client.availableUntil):`${day}T18:00`;
  $('#client-joined').value=localInput(client?.joinedAt||new Date());$('#client-failure').checked=!!client?.simulateFailure;$('#client-optedout').checked=!!client?.optedOut;
  setError('#client-error','');$('#client-dialog').showModal();
}
$('#add-client-button').addEventListener('click',()=>openClientDialog());
$('#close-client-dialog').addEventListener('click',()=>$('#client-dialog').close());
$('#cancel-client-dialog').addEventListener('click',()=>$('#client-dialog').close());
$('#waitlist-table').addEventListener('click',event=>{
  const edit=event.target.closest('[data-edit-client]');if(edit)openClientDialog(edit.dataset.editClient);
  const remove=event.target.closest('[data-delete-client]');if(remove){const client=waitlist.find(client=>client.id===remove.dataset.deleteClient);if(confirm(`Remove ${client.name} from the waitlist? Running openings keep their original client list.`)){waitlist=waitlist.filter(client=>client.id!==remove.dataset.deleteClient);storageSet(WAITLIST_KEY,waitlist);renderWaitlist();updateMatchPreview();toast('Client removed from the waitlist for future openings.');}}
});
$('#client-form').addEventListener('submit',async event=>{
  event.preventDefault();setError('#client-error','');
  try {
    const name=$('#client-name').value.trim();const mobile=$('#client-mobile').value.trim();if(!name)throw new Error('Enter the client’s name.');if(mobile.replace(/\D/g,'').length<7)throw new Error('Enter a valid mobile number.');
    const client={id:$('#client-id').value||crypto.randomUUID(),name,mobile,service:$('#client-service').value,preferredStylist:$('#client-stylist').value||null,availableFrom:fromPhoenix($('#client-from').value),availableUntil:fromPhoenix($('#client-until').value),joinedAt:fromPhoenix($('#client-joined').value),simulateFailure:$('#client-failure').checked,optedOut:$('#client-optedout').checked};
    if(new Date(client.availableUntil)<=new Date(client.availableFrom))throw new Error('Availability must end after it starts.');
    const index=waitlist.findIndex(existing=>existing.id===client.id);if(index>=0)waitlist[index]=client;else waitlist.push(client);
    storageSet(WAITLIST_KEY,waitlist);renderWaitlist();updateMatchPreview();$('#client-dialog').close();
    if(client.optedOut) {
      const result=await applyOptOutToOpenings(client.id);
      toast(result.failed.length?`Client saved. Opt-out needs another attempt for ${result.failed.length} active opening${result.failed.length===1?'':'s'}; see the opening’s reply status.`:'Client saved. Text opt-out applies immediately to active openings and future outreach.');
      await refresh(true);
    } else {toast('Waitlist saved. Changes apply to new openings.');}

  } catch(error) {setError('#client-error',error.message);}
});
updateMatchPreview();renderStats();renderOpenings(true);refresh();
setInterval(()=>refresh(),1500);setInterval(updateCountdowns,250);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh(true);});
