import { api } from "../api.js";
import { toast, escapeHtml as e } from "../ui.js";

const support = {ollama:["text","vision","embedding"],gemini:["text","vision"],openrouter:["text","vision","embedding","image","video","speech"],compatible:["text","vision","embedding","image","video","speech"],comfyui:["image","video"],automatic1111:["image"],baidu:["ocr"],unlimited_ocr:["ocr"]};
const labels = {text:"Writing & analysis",vision:"Vision / image questions",embedding:"Search embeddings",speech:"Narration voice",image:"Explainer images",video:"Explainer video",ocr:"Scanned documents"};

export async function renderSettings() {
  const root = document.getElementById("view-root");
  root.innerHTML = '<p class="muted">Loading your connections…</p>';
  let settings = await api.connections();
  const storage = await api.getSettings();
  let selected = "ollama";
  const catalogues = {};
  root.innerHTML = `
    <header class="workspace-header"><div><div class="eyebrow">WORKSPACE / PREFERENCES</div><h1>Make it yours.</h1><p class="muted">Connect your models once. Choose the right one for each task.</p></div><span class="version-label">ResearchPal 0.2</span></header>
    <div class="settings-layout">
      <section class="card"><div class="section-heading"><h2>1. Connections</h2><span class="faint">Local & cloud</span></div>
        <div class="connection-tabs" id="provider-tabs"></div><div id="provider-editor"></div>
      </section>
      <section class="card"><div class="section-heading"><h2>2. Choose your models</h2><span class="faint">Automatic discovery or manual IDs</span></div>
        <div id="capability-routes"></div>
        <p class="faint">Saving applies immediately to new jobs. Running jobs keep their current connection. Changing an embedding model requires reindexing your library.</p>
        <button id="reindex-btn" class="ghost-btn">Reindex library with selected embedding model</button><p id="reindex-status" role="status"></p>
      </section>
      <section class="card"><h2>Document reading</h2><label class="field-label" for="ocr-mode">OCR behavior</label>
        <select id="ocr-mode"><option value="auto">Automatic: OCR when pages need it</option><option value="always">Always OCR the full PDF</option><option value="off">Off: accept only extractable text (scans may be incomplete)</option></select>
        <p class="muted text-sm mt-1">Unlimited-OCR 2 uses a separately running SGLang server. No model folder is assumed. Full-document parsing uses the server’s memory and output budget; incomplete page coverage is reported as an error.</p>
        <a class="text-sm" href="https://github.com/baidu/Unlimited-OCR" target="_blank" rel="noreferrer">Unlimited-OCR setup ↗</a>
      </section>
      <section class="card"><h2>Storage</h2><label class="field-label" for="data-dir">Library folder</label><div class="flex gap-1"><input id="data-dir" value="${e(storage.data_dir)}" readonly><button id="pick-data" ${window.electronAPI ? "" : "disabled"}>Choose folder</button></div><p class="faint mt-1">Moving the library needs a restart and does not copy existing files. Back up the current folder first.</p></section>
    </div>
    <div class="settings-save"><span id="save-status" class="muted" role="status">Keys stay on this computer and are never returned to the page.</span><button id="save-connections" class="primary">Save settings</button></div>`;
  root.querySelector('#ocr-mode').value = settings.ocr_mode;
  function collectEditor() {
    const p = settings.providers[selected];
    root.querySelectorAll('#provider-editor [data-field]').forEach(input => {
      const key=input.dataset.field;
      if (input.type === 'password' && !input.value) return;
      p[key]=input.value;
    });
  }
  function renderRoutes() {
    root.querySelector('#capability-routes').innerHTML = Object.entries(labels).map(([task,label]) => {
      const route=settings.routes[task];
      const options=Object.entries(settings.providers).filter(([,p])=>support[p.kind].includes(task)).map(([id,p])=>`<option value="${e(id)}">${e(p.name)}</option>`).join('');
      return `<div class="model-route"><label class="field-label" for="route-${task}">${label}</label><div class="route-inputs"><select id="route-${task}" data-task="${task}"><option value="">Not configured</option>${task==='speech'?'<option value="browser">Device voice (read aloud)</option><option value="edge">Edge neural speech (online)</option><option value="system">Windows voice (offline export)</option>':''}${options}</select><input aria-label="${label} model ID" data-model="${task}" value="${e(route.model || '')}" list="models-${task}" placeholder="${task==='speech'?'Voice or speech model ID':'Model ID — type or discover'}"><button type="button" data-discover="${task}" class="sm">Discover</button></div><datalist id="models-${task}"></datalist>${task==='speech'?`<label class="field-label">Cloud voice name<input id="speech-voice" value="${e(route.voice || 'alloy')}" placeholder="e.g. alloy — depends on the selected model"></label>`:''}</div>`;
    }).join('');
    Object.keys(labels).forEach(task=> {
      const select=root.querySelector(`#route-${task}`);
      select.value=settings.routes[task].provider;
      select.onchange=()=>{settings.routes[task].provider=select.value;};
      root.querySelector(`[data-model="${task}"]`).oninput=event=>{settings.routes[task].model=event.target.value;};
      root.querySelector(`[data-discover="${task}"]`).onclick=async event=>{
        const id=select.value;
        if(!id || ['browser','edge','system'].includes(id)) {toast('Choose a model service to discover its models.');return;}
        collectEditor();
        const button=event.currentTarget; button.disabled=true;button.textContent='Checking…';
        try {
          const result=await api.discoverConnection(id,{capability:task,base_url:settings.providers[id].base_url,api_key:settings.providers[id].api_key||''});
          catalogues[id]=result.models;
          root.querySelector(`#models-${task}`).innerHTML=result.models.map(m=>`<option value="${e(m.id)}">${e(m.name || m.id)}</option>`).join('');
          const modelInput=root.querySelector(`[data-model="${task}"]`);
          if(!modelInput.value && result.models.length===1){modelInput.value=result.models[0].id;settings.routes[task].model=modelInput.value;}
          modelInput.focus();toast(`Connected. ${result.models.length} models found. Type in the model box to select.`,'success');
        } catch(error){toast(error.message,'error');}finally{button.disabled=false;button.textContent='Discover';}
      };
    });
    root.querySelector('#speech-voice').oninput=event=>settings.routes.speech.voice=event.target.value;
  }
  function renderEditor() {
    const p=settings.providers[selected];
    root.querySelector('#provider-tabs').innerHTML=Object.entries(settings.providers).map(([id,p])=>`<button class="connection-tab ${id===selected?'active':''}" data-provider="${e(id)}">${e(p.name)}</button>`).join('');
    root.querySelectorAll('[data-provider]').forEach(button=>button.onclick=()=>{collectEditor();selected=button.dataset.provider;renderEditor();});
    const input=(key,label,type='text',hint='')=>`<label class="field-label">${label}<input data-field="${key}" type="${type}" autocomplete="off" value="${type==='password'?'':e(p[key] || '')}" placeholder="${e(type==='password'&&p['has_'+key]?'Already saved — leave blank to keep':hint)}"></label>`;
    let html=`<h3>${e(p.name)}</h3>`;
    if(p.kind!=='gemini')html+=input('base_url','Service URL','url');
    if(['gemini','openrouter','compatible','baidu','unlimited_ocr'].includes(p.kind))html+=input('api_key',p.kind==='unlimited_ocr'?'Server API key (optional)':'API key','password');
    if(p.kind==='baidu')html+=input('secret_key','Secret key','password');
    if(p.kind==='ollama')html+=`<p class="muted text-sm">Models are discovered from the running Ollama service. Moving a model folder does not change its service URL. If Ollama already runs, update OLLAMA_MODELS in that service and restart Ollama.</p>${input('models_dir','Model folder for an app-launched Ollama service','text','Optional — discover or enter your folder')}<label class="field-label">Search folder or drive (optional)<input id="storage-search-root" placeholder="Leave blank to inspect configured drives"></label><button id="discover-folders">Find model folders automatically</button><div id="storage-results" class="mt-1 text-sm" role="status"></div><div class="flex gap-1">${window.electronAPI?'<button id="pick-models">Choose folder</button><button id="start-ollama">Start Ollama with this folder</button>':''}</div><p class="faint">The app never moves, deletes, or scans model weights. An already-running service is left in control.</p>`;
    if(p.kind==='comfyui')html+=`<p class="muted text-sm">Use a running ComfyUI instance and an API-format workflow. Its checkpoint folders remain managed by ComfyUI.</p><label class="field-label">API-format workflow JSON<input type="file" id="workflow-file" accept=".json,application/json"></label><p class="faint" id="workflow-status">${Object.keys(p.workflow||{}).length} nodes configured</p>${input('prompt_node','Positive prompt node ID')}${input('prompt_input','Prompt input name','text','text')}`;
    if(p.kind==='automatic1111')html+='<p class="muted text-sm">Start WebUI with --api. Discover lists checkpoints from that service, wherever its model folder lives.</p>';
    if(p.kind==='unlimited_ocr')html+=`<p class="muted text-sm">Connect to the upstream customized SGLang server (base URL ends in /v1). Select Unlimited-OCR-2 in the Scanned documents route. This is an optional GPU service, not bundled weights.</p>${input('custom_logit_processor','Serialized no-repeat processor (optional, from your SGLang environment)')}`;
    if(['openrouter','compatible'].includes(p.kind))html+='<p class="muted text-sm">Discover the current catalogue or enter an exact model ID. Image, video and speech support depends on the model and endpoint. Jobs run only after you click Generate.</p>';
    html+='<button id="test-connection" class="ghost-btn mt-1">Test connection & discover</button><p id="connection-status" role="status" class="text-sm mt-1"></p>';
    root.querySelector('#provider-editor').innerHTML=html;
    const test=root.querySelector('#test-connection');
    test.onclick=async()=>{
      collectEditor();test.disabled=true;
      try {const result=await api.discoverConnection(selected,{base_url:p.base_url,api_key:p.api_key||''});catalogues[selected]=result.models;root.querySelector('#connection-status').textContent=`Connected · ${result.models.length} models · ${result.capabilities.join(', ')}`;}
      catch(error){root.querySelector('#connection-status').textContent=error.message;}finally{test.disabled=false;}
    };
    root.querySelector('#workflow-file')?.addEventListener('change',async event=>{
      try{const workflow=JSON.parse(await event.target.files[0].text());if(!workflow||Array.isArray(workflow)||typeof workflow!=='object')throw new Error('Expected an API-format JSON object');p.workflow=workflow;root.querySelector('#workflow-status').textContent=`${Object.keys(workflow).length} nodes loaded — Save settings to apply`;}
      catch(error){toast(error.message,'error');}
    });
    root.querySelector('#discover-folders')?.addEventListener('click',async event=>{
      const button=event.currentTarget;button.disabled=true;button.textContent='Looking for manifests…';
      try{const result=await api.discoverStorage(root.querySelector('#storage-search-root').value.trim());
        const box=root.querySelector('#storage-results');
        box.innerHTML=`<p class="faint">${result.scanned_directories} folders checked${result.incomplete?' · search limit reached; narrow the search folder':''}. ${result.environment_folder_exists?'':'The current OLLAMA_MODELS folder is missing.'}</p>`;
        result.folders.forEach(folder=>{const item=document.createElement('button');item.className='storage-candidate';item.textContent=`${folder.path} · ${folder.models.length} models`;item.onclick=()=>{root.querySelector('[data-field="models_dir"]').value=folder.path;collectEditor();toast('Folder selected. Save settings, then start or reconnect Ollama.');};box.appendChild(item);});
        if(!result.folders.length)box.append('No manifests/blobs storage found. Choose a narrower search root or enter the path manually.');
      }catch(error){toast(error.message,'error');}finally{button.disabled=false;button.textContent='Find model folders automatically';}
    });
    root.querySelector('#pick-models')?.addEventListener('click',async()=>{const path=await window.electronAPI.pickFolder();if(path)root.querySelector('[data-field="models_dir"]').value=path;});
    root.querySelector('#start-ollama')?.addEventListener('click',async()=>{collectEditor();try{const result=await window.electronAPI.startOllama({host:p.base_url,modelsDir:p.models_dir});toast(result.message,result.ok?'success':'error');}catch(error){toast(error.message,'error');}});
  }
  renderRoutes(); renderEditor();
  root.querySelector('#pick-data').onclick=async()=>{const path=await window.electronAPI.pickFolder();if(path)root.querySelector('#data-dir').value=path;};
  root.querySelector('#save-connections').onclick=async event=>{
    collectEditor();settings.ocr_mode=root.querySelector('#ocr-mode').value;settings.allow_fallback=false;
    const button=event.currentTarget;button.disabled=true;
    try {
      settings=await api.saveConnections(settings);
      const path=root.querySelector('#data-dir').value;
      if(path!==storage.data_dir && window.electronAPI)await window.electronAPI.setDataDirectory(path);
      root.querySelector('#save-status').textContent=path!==storage.data_dir?'Saved. Restart the desktop app to open the selected library folder.':'Saved. Model routes apply to new jobs immediately.';
      renderEditor();toast('Settings saved','success');
    }catch(error){toast(error.message,'error');}finally{button.disabled=false;}
  };
  root.querySelector('#reindex-btn').onclick=async event=>{
    event.currentTarget.disabled=true;
    try{const job=await api.reindex();root.querySelector('#reindex-status').textContent='Reindexing started. See Studio → Jobs for progress.';}
    catch(error){toast(error.message,'error');}finally{event.currentTarget.disabled=false;}
  };
}
