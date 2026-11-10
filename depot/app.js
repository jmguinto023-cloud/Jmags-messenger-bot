'use strict';
// JMAGS AI Video Training Depot. This browser app cannot send Messenger messages.
// Supabase RLS is the authority for all private media references and saved labels.
(() => {
  const $ = id => document.getElementById(id);
  const SESSION_KEY = 'jmags_depot_session_v1';
  const PAGE_SIZE = 20;
  const FIELDS = ['brand','model','screen_size_inches','visible_symptoms','suspected_fault',
    'confirmed_fault','repair_action','repairable','repair_outcome','reviewer_notes','consent_status'];
  const SELECT_FIELDS = ['source_video_id','received_at','source_url','archive_status',
    'brand','model','screen_size_inches','visible_symptoms','suspected_fault','confirmed_fault',
    'repair_action','repairable','repair_outcome','label_status','reviewer_notes',
    'consent_status','updated_at'].join(',');
  let cfg, session, current, page = 0, totalOnFilter = 0, requestEpoch = 0;
  let isSaving = false;
  const formatDate = date => date ? new Date(date).toLocaleString('en-PH',
    {timeZone:'Asia/Manila',year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : 'Unknown date';
  const setText = (id, text) => { $(id).textContent = text; };
  const formatError = e => (e && e.message) || 'An unexpected error occurred';

  function saveSession() {
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION_KEY);
  }
  async function authFetch(path, options = {}) {
    const response = await fetch(cfg.supabaseUrl + path, {
      ...options, headers: {
        apikey: cfg.publishableKey,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.msg || data.error_description || data.message ||
        data.error || 'Request failed (' + response.status + ')');
    }
    return response;
  }
  async function refreshToken() {
    if (!session || !session.refresh_token) throw new Error('Please sign in again.');
    const response = await authFetch('/auth/v1/token?grant_type=refresh_token',{
      method:'POST',body:JSON.stringify({refresh_token:session.refresh_token})
    });
    const data = await response.json();
    if (!data.access_token) throw new Error('Session refresh failed.');
    session = {
      access_token:data.access_token, refresh_token:data.refresh_token,
      expires_at:Date.now() + (data.expires_in || 3600) * 1000,
    };
    saveSession();
  }
  async function accessToken() {
    if (!session) throw new Error('Please sign in to view the depot.');
    if (session.expires_at && session.expires_at - Date.now() < 90000) await refreshToken();
    return session.access_token;
  }
  async function database(path, options = {}, shouldRetry = true) {
    const token = await accessToken();
    const headers = {
      apikey: cfg.publishableKey,
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...options.headers,
    };
    const response = await fetch(cfg.supabaseUrl + '/rest/v1/' + path, {...options,headers});
    if (response.status === 401 && shouldRetry) {
      await refreshToken();
      return database(path,options,false);
    }
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || error.details || 'Database request failed (' + response.status + ')');
    }
    return response;
  }
  function showDashboard(visible) {
    $('login').classList.toggle('hidden',visible);
    $('dashboard').classList.toggle('hidden',!visible);
    $('logout').classList.toggle('hidden',!visible);
  }
  async function checkMembership() {
    const res = await database('jmags_video_depot_members?select=member_role&limit=1');
    const members = await res.json();
    if (!members.length) throw new Error('This account is not approved for JMAGS Video Training Depot.');
  }
  async function login(event) {
    event.preventDefault();
    setText('login-error','');
    const email = $('email').value.trim();
    const password = $('password').value;
    const button = $('login-form').querySelector('button');
    button.disabled = true;
    try {
      const res = await authFetch('/auth/v1/token?grant_type=password',{
        method:'POST',body:JSON.stringify({email,password})
      });
      const auth = await res.json();
      if (!auth.access_token) throw new Error('Login did not return an active session.');
      session = {
        access_token:auth.access_token,refresh_token:auth.refresh_token,
        expires_at:Date.now() + (auth.expires_in || 3600) * 1000,
      };
      saveSession();
      await checkMembership();
      $('password').value = '';
      showDashboard(true);
      await reloadAll();
    } catch (error) {
      session = null;
      saveSession();
      setText('login-error',formatError(error));
    } finally { button.disabled = false; }
  }
  async function logout() {
    if (session) {
      try {
        await authFetch('/auth/v1/logout',{
          method:'POST',headers:{Authorization:'Bearer ' + await accessToken()}
        });
      } catch {}
    }
    session = null; current = null; saveSession();
    $('case-form').classList.add('hidden');
    $('empty-case').classList.remove('hidden');
    showDashboard(false);
  }
  async function countCases(status) {
    const params = new URLSearchParams({select:'source_video_id',limit:'1'});
    if (status !== 'all') params.set('label_status','eq.' + status);
    const res = await database('jmags_video_training_cases?' + params.toString(),{
      headers:{Prefer:'count=exact'},
    });
    const range = res.headers.get('content-range') || '*/0';
    const count = Number(range.split('/').pop());
    return Number.isFinite(count) ? count : 0;
  }
  async function loadStats() {
    const statuses=['all','unlabeled','draft','verified'];
    const values=await Promise.all(statuses.map(countCases));
    for (let i=0;i<statuses.length;i++) setText('count-' + statuses[i],
      values[i].toLocaleString('en-PH'));
  }
  function simpleSearch(value) {
    return value.replace(/[^a-zA-Z0-9 ._-]/g,'').trim().slice(0,70);
  }
  async function loadQueue() {
    const epoch = ++requestEpoch;
    setText('queue-note','Loading private video records…');
    const filter = $('filter').value;
    const params = new URLSearchParams({
      select:SELECT_FIELDS,order:'received_at.desc',
      limit:String(PAGE_SIZE),offset:String(page*PAGE_SIZE)
    });
    if (filter !== 'all') params.set('label_status','eq.' + filter);
    const term = simpleSearch($('search').value);
    if (term) {
      const pattern = '*'+term.replace(/ /g,'*')+'*';
      params.set('or','(brand.ilike.'+pattern+',model.ilike.'+pattern+',confirmed_fault.ilike.'+pattern+',visible_symptoms.ilike.'+pattern+')');
    }
    const response = await database('jmags_video_training_cases?' + params.toString(),
      {headers:{Prefer:'count=exact'}});
    const cases = await response.json();
    if (epoch !== requestEpoch) return;
    const range = response.headers.get('content-range') || '*/0';
    const num = Number(range.split('/').pop());
    totalOnFilter = Number.isFinite(num) ? num : cases.length;
    const list = $('queue-list');
    list.replaceChildren();
    for (const item of cases) {
      const button = document.createElement('button');
      button.type='button';
      button.className='video-card' + (current?.source_video_id === item.source_video_id ? ' active' : '');
      const title = document.createElement('div');
      title.className='card-head';
      const name = document.createElement('strong');
      name.textContent = [item.brand,item.model].filter(Boolean).join(' ') || 'Unlabeled Messenger video';
      const pill = document.createElement('span');
      pill.className='pill ' + item.label_status;
      pill.textContent = item.label_status === 'verified' ? 'VERIFIED' :
        item.label_status === 'draft' ? 'DRAFT' : 'TO LABEL';
      title.append(name,pill);
      const date=document.createElement('small');
      date.textContent = formatDate(item.received_at);
      const summary=document.createElement('div');
      summary.className='card-sub';
      summary.textContent = item.confirmed_fault || item.visible_symptoms ||
        'Ready for technician labeling · Video ref ' + item.source_video_id.slice(-8);
      button.append(title,date,summary);
      button.addEventListener('click',()=>openCase(item));
      list.append(button);
    }
    if (!cases.length) {
      const empty=document.createElement('p');
      empty.className='empty-queue';
      empty.textContent=term ? 'No matches. Try another search.' :
        'No videos in this category yet. New Messenger video metadata will appear automatically.';
      list.append(empty);
    }
    const pageTotal=Math.max(1,Math.ceil(totalOnFilter/PAGE_SIZE));
    setText('queue-count',totalOnFilter.toLocaleString('en-PH')+' records');
    setText('page-label','Page '+(page+1)+' / '+pageTotal);
    setText('queue-note','Private records · '+ (cases.length ? 'Select a case to teach the AI.' : 'No matching records.'));
    $('previous').disabled = page <= 0;
    $('next').disabled = (page+1)*PAGE_SIZE >= totalOnFilter;
  }
  async function reloadAll() {
    await Promise.all([loadStats(),loadQueue()]);
  }
  function toEdit(value) { return value === null || value === undefined ? '' : String(value); }
  function isAllowedSource(url) {
    try {
      const u=new URL(url);
      return u.protocol==='https:' && /^video(?:-[a-z0-9-]+)?\.xx\.fbcdn\.net$/.test(u.hostname);
    } catch {return false;}
  }
  async function openCase(item) {
    current = item;
    setText('case-title',[item.brand,item.model].filter(Boolean).join(' ') || 'Video · ' + item.source_video_id.slice(-8));
    setText('case-date','Received '+formatDate(item.received_at)+' · Status: '+item.label_status);
    $('empty-case').classList.add('hidden');
    $('case-form').classList.remove('hidden');
    for (const name of FIELDS) {
      if (name === 'repairable') $(name).value = item.repairable === null ? '' : String(item.repairable);
      else $(name).value = toEdit(item[name]);
    }
    const open=$('open-video');
    if (isAllowedSource(item.source_url)) {
      open.href=item.source_url;
      open.textContent='Open original video ↗';
      open.removeAttribute('aria-disabled');
    } else {
      open.removeAttribute('href');
      open.textContent='Original video unavailable';
      open.setAttribute('aria-disabled','true');
    }
    setText('source-warning','Stored link may have expired. The depot has metadata, not a permanent video file.');
    setText('save-message','');
    await loadHistory(item.source_video_id);
    // Keep the case accessible on small screens.
    if (window.matchMedia('(max-width:900px)').matches) $('editor').scrollIntoView({behavior:'smooth',block:'start'});
  }
  async function loadHistory(id) {
    setText('history','Loading label history…');
    try {
      const params = new URLSearchParams({
        select:'changed_at,old_data,new_data',
        source_video_id:'eq.' + id,
        order:'changed_at.desc',limit:'6'
      });
      const res = await database('jmags_video_training_history?' + params.toString());
      const entries = await res.json();
      const box=$('history');
      box.replaceChildren();
      if (!entries.length) {box.textContent='No previous training labels. Save a draft or verified diagnosis to begin.';return;}
      for (const entry of entries) {
        const p=document.createElement('div');
        p.className='history-entry';
        const fault=entry.new_data?.confirmed_fault || '(no confirmed fault yet)';
        p.textContent=formatDate(entry.changed_at)+' · '+entry.new_data?.label_status+' · '+fault;
        box.append(p);
      }
    } catch(e) {setText('history','Could not load history: '+formatError(e));}
  }
  function draftPayload(verified) {
    const payload={};
    for(const name of FIELDS) {
      if(name==='screen_size_inches') payload[name] = $(name).value ? Number($(name).value) : null;
      else if(name==='repairable') payload[name] = $(name).value === '' ? null : $(name).value === 'true';
      else payload[name]=$(name).value.trim();
    }
    payload.label_status=verified?'verified':'draft';
    if(verified && (!payload.confirmed_fault || payload.confirmed_fault.length < 2 || payload.repairable === null)) {
      throw new Error('To verify this case, enter the confirmed fault and select whether it is repairable.');
    }
    return payload;
  }
  async function save(verified) {
    if(!current || isSaving)return;
    let payload;
    try {payload=draftPayload(verified);}
    catch(e){setText('save-message',formatError(e));return;}
    isSaving=true;
    $('save-draft').disabled=true;
    $('save-verified').disabled=true;
    setText('save-message','Saving your teaching to JMAGS Supabase…');
    try {
      const p=new URLSearchParams({source_video_id:'eq.'+current.source_video_id,select:SELECT_FIELDS});
      const response=await database('jmags_video_training_cases?'+p.toString(),{
        method:'PATCH',
        headers:{Prefer:'return=representation'},
        body:JSON.stringify(payload),
      });
      const updated=await response.json();
      if(updated.length !== 1) throw new Error('No case was updated. Access may have changed.');
      current=updated[0];
      setText('save-message',verified ? '✓ Verified diagnosis saved to long-term JMAGS knowledge.' :
        '✓ Draft saved. You can finish it later.');
      await Promise.all([loadStats(),loadQueue(),loadHistory(current.source_video_id)]);
    } catch(e) {
      setText('save-message','Save failed: '+formatError(e));
    } finally {
      isSaving=false;
      $('save-draft').disabled=false;
      $('save-verified').disabled=false;
    }
  }
  function listen() {
    $('login-form').addEventListener('submit',login);
    $('logout').addEventListener('click',logout);
    $('refresh').addEventListener('click',()=>reloadAll().catch(e=>setText('queue-note','Refresh failed: '+formatError(e))));
    $('filter').addEventListener('change',()=>{page=0;loadQueue().catch(e=>setText('queue-note',formatError(e)));});
    let debounce;
    $('search').addEventListener('input',()=>{
      clearTimeout(debounce);
      debounce=setTimeout(()=>{page=0;loadQueue().catch(e=>setText('queue-note',formatError(e)));},350);
    });
    $('previous').addEventListener('click',()=>{if(page>0){page--;loadQueue().catch(e=>setText('queue-note',formatError(e)));}});
    $('next').addEventListener('click',()=>{if((page+1)*PAGE_SIZE<totalOnFilter){page++;loadQueue().catch(e=>setText('queue-note',formatError(e)));}});
    $('close-case').addEventListener('click',()=>{
      current=null;
      $('case-form').classList.add('hidden');
      $('empty-case').classList.remove('hidden');
    });
    $('save-draft').addEventListener('click',()=>save(false));
    $('save-verified').addEventListener('click',()=>save(true));
    window.setInterval(()=>{
      if(!document.hidden && session && !$('dashboard').classList.contains('hidden')) {
        reloadAll().catch(()=>{});
      }
    },60000);
  }
  async function start() {
    listen();
    try {
      const res=await fetch('/config.json',{cache:'no-store'});
      if(!res.ok) throw new Error('Site connection is not configured.');
      cfg=await res.json();
      if(!cfg.supabaseUrl || !cfg.publishableKey) throw new Error('Supabase project connection missing.');
      try {session=JSON.parse(sessionStorage.getItem(SESSION_KEY)||'null');}catch{session=null;}
      if(session) {
        try {
          const bearer=await accessToken();
          const res=await authFetch('/auth/v1/user',{headers:{Authorization:'Bearer '+bearer}});
          if(!res.ok) throw new Error('Session invalid');
          await checkMembership();
          showDashboard(true);
          await reloadAll();
          return;
        } catch {
          session=null;saveSession();
        }
      }
      showDashboard(false);
    } catch(e) {
      showDashboard(false);
      setText('login-error','Cannot connect to JMAGS Depot: '+formatError(e));
    }
  }
  document.addEventListener('DOMContentLoaded',start);
})();