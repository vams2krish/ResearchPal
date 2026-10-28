import { escapeHtml } from "./ui.js";
import { renderInlineMath } from "./render.js";

export function renderMarkdown(container, raw) {
  if (!window.marked || !window.DOMPurify) {
    container.innerHTML = `<pre class="source-code">${escapeHtml(raw || '')}</pre>`;
    return;
  }
  const html=window.marked.parse(raw || '',{gfm:true,breaks:false});
  container.innerHTML=window.DOMPurify.sanitize(html,{USE_PROFILES:{html:true},FORBID_TAGS:['style','iframe','form'],FORBID_ATTR:['style']});
  container.querySelectorAll('a').forEach(link=>{link.target='_blank';link.rel='noopener noreferrer';});
  // Source PDFs can contain filesystem image references. Only application media or https assets are displayed.
  container.querySelectorAll('img').forEach(img=>{const src=img.getAttribute('src')||'';if(!src.startsWith('/media/papers/')&&!src.startsWith('https://'))img.removeAttribute('src');img.loading='lazy';});
  renderInlineMath(container);
}
