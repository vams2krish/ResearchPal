import { api } from '../api.js';
import { escapeHtml as e, toast } from '../ui.js';

export async function renderStudio({_query={}}={}) {
  const root=document.getElementById('view-root');
  const [papers,connections]=await Promise.all([api.listPapers(),api.connections()]);
  let scenes=[],disposed=false,timer=null;
  const label=task=>{const route=connections.routes[task];return `${connections.providers[route.provider]?.name || route.provider || 'Not configured'}${route.model?' / '+route.model:''}`;};
  root.innerHTML=`<header class="workspace-header"><div><div class="eyebrow">CREATE / EXPLAIN / SHARE</div><h1>An idea, made clear.</h1><p class="muted">Turn a document into an editable storyboard and a narrated video.</p></div><span class="version-label">EXPLAINER STUDIO</span></header>
    <div class="studio-grid"><div>
      <section class="card"><div class="section-heading"><h2>1. Start with a source</h2><span class="faint">Your words or your library</span></div><label class="field-label" for="studio-paper">Document</label><select id="studio-paper"><option value="">Paste text instead</option>${papers.map(p=>`<option value="${p.id}">${e(p.title)}</option>`).join('')}</select><label class="field-label" for="studio-text">Source text</label><textarea id="studio-text" rows="7" placeholder="Paste the material you want to explain…"></textarea><p class="faint">Storyboards are summaries, not full-document narration. Every source part is read before the final storyboard is assembled.</p><p class="provider-label">Text model: ${e(label('text'))}</p><button id="generate-storyboard" class="primary">Generate storyboard</button><button id="add-scene" class="ghost-btn">+ Write a scene yourself</button></section>
      <section class="card mt-2"><div class="section-heading"><h2>2. Review the story</h2><span id="scene-count" class="faint">0 scenes</span></div><p class="muted text-sm">Edit the narration, visuals and source references before rendering. Check generated claims against the source.</p><div id="scene-editor"></div></section>
      <section class="card mt-2"><h2>3. Make the video</h2><label class="field-label" for="visual-mode">Visual style</label><select id="visual-mode"><option value="slides">Clean slides · rendered locally</option><option value="images">Generated illustrations · one image per scene</option><option value="video">Generated motion · one video job per scene</option></select><p class="provider-label">Speech: ${e(label('speech'))}</p><p class="provider-label" id="visual-provider">Slides are rendered on this computer.</p><p class="muted text-sm">MP4 export includes the complete narration for each scene. Image, motion and speech models can incur charges. This starts only when you click Generate; the app does not retry paid requests automatically.</p><button id="render-video" class="primary">Generate narrated MP4</button><p id="render-status" role="status" class="mt-1"></p></section>
    </div><aside class="studio-jobs"><div class="section-heading"><h2>Jobs & exports</h2><span class="faint">Saved on this computer</span></div><div id="studio-jobs"></div></aside></div>`;
  const q=s=>root.querySelector(s);
  if(_query.paper)q('#studio-paper').value=_query.paper;
  const sourceMode=()=>{q('#studio-text').disabled=!!q('#studio-paper').value;q('#studio-text').placeholder=q('#studio-paper').value?'The complete extracted document will be used.':'Paste the material you want to explain…';};sourceMode();q('#studio-paper').onchange=sourceMode;
  function collect(){
    root.querySelectorAll('[data-scene]').forEach(card=>{const scene=scenes[+card.dataset.scene];card.querySelectorAll('[data-key]').forEach(input=>scene[input.dataset.key]=input.value);});
  }
  function editor(){
    q('#scene-count').textContent=`${scenes.length} scenes`;
    q('#scene-editor').innerHTML=scenes.length?scenes.map((scene,i)=>`<details class="scene-card" data-scene="${i}" ${i===0?'open':''}><summary><span class="scene-number">${String(i+1).padStart(2,'0')}</span>${e(scene.title || 'Untitled scene')}</summary>${['title','narration','visual_prompt','source'].map(key=>`<label class="field-label">${({title:'Title',narration:'Narration',visual_prompt:'Visual description',source:'Source reference'})[key]}<textarea data-key="${key}" rows="${key==='narration'?4:2}">${e(scene[key]||'')}</textarea></label>`).join('')}<button data-remove="${i}" class="ghost-btn sm">Remove scene</button></details>`).join(''):'<div class="empty-state compact"><p>Your storyboard will appear here.<br>Generate one from a source, or write your own.</p></div>';
    root.querySelectorAll('[data-remove]').forEach(button=>button.onclick=()=>{collect();scenes.splice(+button.dataset.remove,1);editor();});
  }
  editor();q('#add-scene').onclick=()=>{collect();if(scenes.length===12){toast('Maximum 12 scenes per video');return;}scenes.push({title:'New scene',narration:'',visual_prompt:'',source:'Source document'});editor();};
  q('#visual-mode').onchange=()=>{const mode=q('#visual-mode').value;q('#visual-provider').textContent=mode==='slides'?'Slides are rendered on this computer.':`${mode==='images'?'Image':'Video'} model: ${label(mode==='images'?'image':'video')} · ${scenes.length} provider jobs`;};
  q('#generate-storyboard').onclick=async event=>{
    const button=event.currentTarget;button.disabled=true;
    try{await api.storyboard({paper_id:q('#studio-paper').value||null,text:q('#studio-text').value});toast('Storyboarding started. Follow it in Jobs.');await refreshJobs();}
    catch(error){toast(error.message,'error');}finally{button.disabled=false;}
  };
  q('#render-video').onclick=async event=>{
    collect();if(!scenes.length){toast('Add a storyboard first.','error');return;}
    const button=event.currentTarget;button.disabled=true;
    try{await api.renderExplainer({scenes,visuals:q('#visual-mode').value,paper_id:q('#studio-paper').value||null});q('#render-status').textContent='Rendering started. You can leave this page and return to the saved job.';await refreshJobs();}
    catch(error){toast(error.message,'error');}finally{button.disabled=false;}
  };
  async function refreshJobs(){
    const jobs=await api.jobs();
    if(disposed||!root.isConnected)return;
    q('#studio-jobs').innerHTML=jobs.slice(0,20).map(job=>`<div class="job-card"><div class="section-heading"><strong>${e(job.kind)}</strong><span class="badge-pill ${job.status==='completed'?'green':'gray'}">${e(job.status)}</span></div><p class="muted text-sm">${e(job.message)}</p><progress max="100" value="${job.progress}"></progress>${job.kind==='storyboard'&&job.status==='completed'?`<button class="sm" data-use="${job.id}">Open storyboard</button>`:''}${job.result?.video_url?`<video controls preload="metadata" src="${e(job.result.video_url)}"></video><a class="text-sm" href="${e(job.result.video_url)}" download>Download MP4 ↓</a>`:''}${job.result?.playlist_url?`<a class="text-sm" href="${e(job.result.playlist_url)}" download>Download narration playlist ↓</a>`:''}</div>`).join('') || '<p class="muted">No jobs yet. Create a storyboard to begin.</p>';
    root.querySelectorAll('[data-use]').forEach(button=>button.onclick=()=>{scenes=structuredClone(jobs.find(job=>job.id===button.dataset.use).result.scenes);editor();q('#scene-editor').scrollIntoView({behavior:'smooth'});});
  }
  async function poll(){try{await refreshJobs();}catch(error){if(!disposed)q('#studio-jobs').textContent=error.message;}if(!disposed)timer=setTimeout(poll,4000);}
  poll();
  return ()=>{disposed=true;clearTimeout(timer);};
}
