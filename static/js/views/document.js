import { api } from '../api.js';
import { escapeHtml as e, toast } from '../ui.js';
import { renderMarkdown } from '../markdown.js';

export async function renderDocument(container, id) {
  const data=await api.source(id);
  if(!container.isConnected)return ()=>{};
  let index=0,stopped=true, currentAudio=null, disposed=false;
  const sourceParts=data.spoken_parts;
  container.innerHTML=`
    <div class="document-grid">
      <aside class="document-outline"><div class="eyebrow">IN THIS DOCUMENT</div><nav id="document-outline"></nav><a class="text-sm" href="/api/papers/${id}/source.md" download>Download Markdown ↓</a></aside>
      <div class="document-main">
        <div class="document-controls"><div class="segmented"><button id="show-document" class="active">Reading view</button><button id="show-markdown">Markdown source</button></div><span class="faint">${data.extraction.pages?`${data.extraction.pages} pages · `:''}${data.markdown.length.toLocaleString()} characters${data.extraction.ocr_pages?.length?` · ${data.extraction.ocr_pages.length} OCR pages`:''}</span></div>
        <section class="listening-bar" id="listening-bar"><div><span class="eyebrow">FULL DOCUMENT NARRATION</span><p class="muted text-sm">Reads the extracted source, including every part. Figures and layout are not a spoken transcription.</p></div>
          <div class="listen-controls"><button id="read-aloud" class="primary">▶ Read aloud</button><button id="pause-reading">Pause</button><button id="stop-reading">Stop</button><label class="sr-only" for="device-voice">Device voice</label><select id="device-voice"></select><label class="sr-only" for="speech-rate">Reading speed</label><select id="speech-rate"><option value="0.8">0.8×</option><option value="1" selected>1×</option><option value="1.2">1.2×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></div>
          <div class="flex gap-1 items-center"><label class="text-sm" for="narration-part">Part</label><select id="narration-part">${sourceParts.map((_,i)=>`<option value="${i}">${i+1} / ${sourceParts.length}</option>`).join('')}</select><span class="faint" id="narration-status" role="status">Ready</span></div>
          <details class="mt-1"><summary class="text-sm">Export neural narration</summary><p class="muted text-sm">Uses the speech provider in Settings. Cloud models may charge for every part. A complete audio playlist is saved, with no document-length cutoff.</p><p class="text-sm" id="speech-provider"></p><button id="export-narration">Generate full narration</button><div id="narration-export" class="mt-1" aria-live="polite"></div></details>
        </section>
        <article id="full-document" class="markdown-document"></article><pre id="markdown-source" class="source-code" hidden></pre>
      </div>
    </div>`;
  const q=s=>container.querySelector(s);
  renderMarkdown(q('#full-document'),data.display_markdown || data.markdown);
  q('#markdown-source').textContent=data.markdown;
  const headings=[...q('#full-document').querySelectorAll('h1,h2,h3')];
  q('#document-outline').innerHTML=headings.map((heading,i)=>{heading.id=`source-heading-${i}`;return `<button data-heading="${i}" class="outline-link level-${heading.tagName}">${e(heading.textContent)}</button>`;}).join('') || '<p class="faint">The original source has no detected headings.</p>';
  container.querySelectorAll('[data-heading]').forEach(button=>button.onclick=()=>headings[+button.dataset.heading].scrollIntoView({behavior:'smooth',block:'start'}));
  const setRaw=raw=>{q('#full-document').hidden=raw;q('#markdown-source').hidden=!raw;q('#show-document').classList.toggle('active',!raw);q('#show-markdown').classList.toggle('active',raw);};
  q('#show-document').onclick=()=>setRaw(false);q('#show-markdown').onclick=()=>setRaw(true);
  function voiceOptions(){
    const voices=window.speechSynthesis?.getVoices() || [];
    q('#device-voice').innerHTML=voices.map((voice,i)=>`<option value="${i}">${e(voice.name)} (${e(voice.lang)})</option>`).join('') || '<option>Default device voice</option>';
  }
  voiceOptions();window.speechSynthesis?.addEventListener('voiceschanged',voiceOptions);
  function stop(){stopped=true;window.speechSynthesis?.cancel();q('#narration-status').textContent='Stopped';q('#read-aloud').textContent='▶ Read aloud';q('#pause-reading').textContent='Pause';}
  function readPart(){
    if(disposed||stopped)return;
    if(index>=sourceParts.length){stop();index=0;q('#narration-status').textContent='Finished the full document';return;}
    const utterance=new SpeechSynthesisUtterance(sourceParts[index]);
    const voices=window.speechSynthesis.getVoices();utterance.voice=voices[+q('#device-voice').value]||null;
    utterance.rate=+q('#speech-rate').value;
    q('#narration-part').value=String(index);q('#narration-status').textContent=`Reading part ${index+1} of ${sourceParts.length}`;
    utterance.onend=()=>{if(!stopped){index++;readPart();}};
    utterance.onerror=event=>{if(!stopped){stop();toast(`Device narration stopped (${event.error}). Choose another voice or use neural narration.`,'error');}};
    window.speechSynthesis.speak(utterance);
  }
  q('#read-aloud').onclick=()=>{
    if(!('speechSynthesis' in window)){toast('This browser does not support device speech. Export neural narration instead.','error');return;}
    stop();index=+q('#narration-part').value;stopped=false;q('#read-aloud').textContent='Reading…';readPart();
  };
  q('#stop-reading').onclick=stop;
  q('#pause-reading').onclick=()=>{if(window.speechSynthesis?.paused){window.speechSynthesis.resume();q('#pause-reading').textContent='Pause';}else{window.speechSynthesis?.pause();q('#pause-reading').textContent='Resume';}};
  let timer;
  async function watch(jobId){
    if(disposed)return;
    try{
      const job=await api.job(jobId);
      q('#narration-export').textContent=`${job.message} · ${job.progress}%`;
      if(job.status==='completed'){
        const segments=job.result.segments;
        q('#narration-export').innerHTML=`<audio controls id="source-audio" style="width:100%"></audio><p class="text-sm">${segments.length} audio parts · <a href="${job.result.audio_url}" download>Download complete MP3</a> · <a href="${job.result.playlist_url}" download>Playlist</a></p><select id="audio-part">${segments.map((segment,i)=>`<option value="${i}">Part ${i+1}</option>`).join('')}</select><a id="download-audio" download>Download this part</a>`;
        const player=q('#source-audio'),select=q('#audio-part');currentAudio=player;
        const setPart=()=>{player.src=segments[+select.value].audio_url;q('#download-audio').href=player.src;};setPart();
        select.onchange=setPart;
        player.onended=()=>{if(+select.value<segments.length-1){select.value=String(+select.value+1);setPart();player.play().catch(()=>{});}};
        q('#export-narration').disabled=false;
      }else if(['failed','interrupted'].includes(job.status)){q('#export-narration').disabled=false;}
      else timer=setTimeout(()=>watch(jobId),2000);
    }catch(error){q('#narration-export').textContent=error.message;q('#export-narration').disabled=false;}
  }
  const connections=await api.connections();
  if(disposed||!container.isConnected)return ()=>{};
  const speech=connections.routes.speech;
  q('#speech-provider').textContent=`Selected: ${speech.provider} ${speech.model || '(default voice)'}`;
  q('#export-narration').onclick=async()=>{q('#export-narration').disabled=true;try{const job=await api.narrate(id);watch(job.id);}catch(error){toast(error.message,'error');q('#export-narration').disabled=false;}};
  return ()=>{disposed=true;clearTimeout(timer);stopped=true;window.speechSynthesis?.cancel();window.speechSynthesis?.removeEventListener('voiceschanged',voiceOptions);currentAudio?.pause();};
}
