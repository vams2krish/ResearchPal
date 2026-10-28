"""Isolated browser/API/media smoke. No cloud credentials or paid requests.
Run: .venv/Scripts/python.exe scripts/smoke_workspace.py
"""
import io
import json
import os
from pathlib import Path
import socket
import sys
import subprocess
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright
from PIL import Image

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
SCENES=[{'title':'A clearer way to read','narration':'ResearchPal keeps the complete extracted source available. Read the document, inspect the evidence, and build an explanation you can verify.','visual_prompt':'A calm reading desk and an open research document','source':'Demo document, part 1'}]
class Fixture(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_GET(self):
        payload={'data':[{'id':'fixture-text','name':'Contract-test text model'}]}
        self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps(payload).encode())
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))))
        prompt=str(body.get('messages',[]))
        answer={'facts':['The complete source remains available. Part 1.']} if 'Extract up to' in prompt else {'scenes':SCENES}
        self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps({'choices':[{'message':{'content':json.dumps(answer)}}]}).encode())

def port():
    with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]

def run():
    include_audio='--include-audio' in sys.argv
    result={'mode':'isolated test data; fixture text provider; audio tests '+('enabled explicitly' if include_audio else 'skipped'),'checks':[],'browser_errors':[]}
    cloud=ThreadingHTTPServer(('127.0.0.1',0),Fixture)
    threading.Thread(target=cloud.serve_forever,daemon=True).start()
    images=ROOT/'docs/images';images.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='researchpal-e2e-') as tmp:
        tmp=Path(tmp);server_port=port();base=f'http://127.0.0.1:{server_port}'
        log=open(tmp/'server.log','w',encoding='utf-8')
        process=subprocess.Popen([str(ROOT/'.venv/Scripts/python.exe'),'-m','uvicorn','server:app','--host','127.0.0.1','--port',str(server_port)],cwd=ROOT,env={**os.environ,'OCE_DATA_DIR':str(tmp/'data')},stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
            for _ in range(100):
                try:
                    opener.open(base+'/api/status',timeout=2);break
                except Exception:time.sleep(.25)
            else:raise RuntimeError('Backend did not start')
            with sync_playwright() as p:
                browser=p.chromium.launch(channel='msedge',headless=True,args=['--no-proxy-server'])
                page=browser.new_page(viewport={'width':1440,'height':1000},device_scale_factor=1)
                page.on('pageerror',lambda error:result['browser_errors'].append(str(error)))
                settings=page.request.get(base+'/api/connections').json()
                settings['providers']['compatible'].update(base_url=f'http://127.0.0.1:{cloud.server_port}/v1',api_key='fixture-only-not-a-real-key')
                settings['routes']['text']={'provider':'compatible','model':'fixture-text'}
                settings['routes']['speech']={'provider':'system','model':''}
                response=page.request.put(base+'/api/connections',data=settings)
                assert response.ok,response.text()
                assert 'fixture-only-not-a-real-key' not in response.text()
                result['checks'].append('Connection save preserves secret without exposing it; custom provider route applied')
                doc='''# A clearer way to read

ResearchPal connects reading, questioning and remembering in one workspace. This demonstration document contains synthetic material for interface verification.

## The problem

Dense papers separate a reader from the evidence through unfamiliar terms, lengthy methods and fragmented notes.

## A source-first workflow

1. Import a document without automatically paying for analysis.
2. Read the full source in Markdown, including the final paragraph.
3. Choose models separately for text, images, video, speech and OCR.
4. Review an editable storyboard before generating a narrated video.

## Evidence stays visible

| Reading task | Workspace tool |
| --- | --- |
| Understand the source | Full document reader |
| Evaluate a finding | Study notes and original PDF |
| Remember a concept | Spaced review |
| Explain an idea | Narrated MP4 |

The equation $E = mc^2$ demonstrates mathematical rendering.

## Limitations

Generated explanations require source verification. OCR quality depends on the document and the selected service. The following repeated paragraph tests long-document coverage.

'''+('A complete reader retains source evidence and lets the user return to the original context. '*50)+'\n\n## Final source evidence\n\nEND-TO-END-TAIL-MARKER\n\n<script>window.sourceWasExecuted=true</script>'
                page.goto(base+'/#/library',wait_until='domcontentloaded')
                page.locator('#file-input').set_input_files({'name':'A clearer way to read.md','mimeType':'text/markdown','buffer':doc.encode()})
                page.locator('.paper-card .open-btn').first.wait_for(timeout=15000)
                import pymupdf, zipfile
                pdf=pymupdf.open()
                for number in range(3):
                    pdf.new_page().insert_text((72,72),f'Document extraction verification page {number+1}. Native PDF evidence is preserved. PDF-TAIL-{number+1}')
                pdf_bytes=pdf.tobytes();pdf.close()
                word=io.BytesIO()
                with zipfile.ZipFile(word,'w') as archive:
                    archive.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Reading with context</w:t></w:r></w:p><w:p><w:r><w:t>DOCX-TAIL-EVIDENCE</w:t></w:r></w:p></w:body></w:document>')
                page.locator('#file-input').set_input_files([
                    {'name':'A source document.pdf','mimeType':'application/pdf','buffer':pdf_bytes},
                    {'name':'Reading with context.docx','mimeType':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','buffer':word.getvalue()}])
                page.wait_for_function("document.querySelectorAll('.paper-card').length === 3",timeout=30000)
                imported=page.request.get(base+'/api/papers').json()
                for paper in imported:
                    if paper['filename'].endswith('.pdf'):
                        extracted=page.request.get(base+'/api/papers/'+paper['id']+'/source').json()
                        assert 'PDF-TAIL-3' in extracted['markdown']
                        assert extracted['extraction']['pages']==3
                    elif paper['filename'].endswith('.docx'):
                        extracted=page.request.get(base+'/api/papers/'+paper['id']+'/source').json()
                        assert '# Reading with context' in extracted['markdown']
                        assert 'DOCX-TAIL-EVIDENCE' in extracted['markdown']
                result['checks'].append('Real 3-page PDF and DOCX upload/extraction with last-page/paragraph evidence preserved')
                page.wait_for_timeout(3700)
                page.screenshot(path=str(images/'researchpal-library.png'))
                page.locator('.paper-card').filter(has_text='A clearer way to read').locator('.open-btn').click()
                page.locator('#full-document table').wait_for(timeout=15000)
                assert page.locator('#full-document').inner_text().find('END-TO-END-TAIL-MARKER')>=0
                assert not page.evaluate('window.sourceWasExecuted === true')
                assert page.locator('#full-document .katex').count()>0
                assert page.locator('.reader-layout').is_hidden()
                page.screenshot(path=str(images/'researchpal-reader.png'))
                page.locator('#show-markdown').click()
                assert page.locator('#markdown-source').inner_text()==doc
                page.locator('#show-document').click()
                paper_id=page.url.split('/paper/')[1]
                assert page.request.get(base+f'/api/papers/{paper_id}/source.md').text()==doc
                result['checks'].append('Browser upload → database → full Markdown/tables/math → original-source download; tail preserved; HTML script sanitized')
                page.locator('[data-mode="study"]').click()
                assert page.locator('.reader-layout').is_visible()
                page.locator('[data-mode="read"]').click()
                result['checks'].append('Read/Study/Listen navigation and source/raw Markdown switching')
                if include_audio:
                    # Real offline SAPI narration and persisted audio playlist.
                    job=page.request.post(base+f'/api/papers/{paper_id}/narration').json()
                    for _ in range(180):
                        state=page.request.get(base+'/api/jobs/'+job['id']).json()
                        if state['status'] not in ('running','queued'):break
                        time.sleep(.5)
                    assert state['status']=='completed',state
                    assert len(state['result']['segments'])>=2
                    for segment in state['result']['segments']:
                        response=page.request.get(base+segment['audio_url']);assert response.ok and len(response.body())>100
                    assert state['result']['segments'][-1]['text'].endswith('window.sourceWasExecuted=true</script>') or 'END-TO-END-TAIL-MARKER' in state['result']['segments'][-1]['text']
                    result['checks'].append(f"Real offline narration: {state['result']['parts']} playable MP3 parts, source tail retained")
                else:
                    result['checks'].append('Audio/narration generation and playback skipped by user request')
                # Settings UI, discover against HTTP fixture and save once.
                page.goto(base+'/#/settings')
                page.locator('#save-connections').wait_for()
                page.locator('#route-text').select_option('compatible')
                page.locator('[data-discover="text"]').click()
                page.locator('#models-text option').first.wait_for(state='attached')
                page.locator('[data-provider="compatible"]').click()
                page.locator('#test-connection').click()
                page.locator('#connection-status').filter(has_text='Connected').wait_for()
                page.locator('#save-connections').click()
                page.locator('#save-status').filter(has_text='Saved').wait_for()
                page.locator('[data-provider="ollama"]').click()
                page.wait_for_timeout(3700)
                page.screenshot(path=str(images/'researchpal-settings.png'))
                result['checks'].append('Settings discovery and save through browser using custom service URL')
                # Full Studio flow: fixture text generation, real export.
                page.goto(base+f'/#/studio?paper={paper_id}')
                page.locator('#generate-storyboard').wait_for()
                page.locator('#generate-storyboard').click()
                page.locator('[data-use]').first.wait_for(timeout=30000)
                page.locator('[data-use]').first.click()
                page.locator('[data-key="narration"]').first.fill(SCENES[0]['narration'])
                if include_audio:
                    page.locator('#render-video').click()
                    page.locator('.job-card video').first.wait_for(timeout=120000)
                    video_url=page.locator('.job-card video').first.get_attribute('src')
                    exported=page.request.get(base+video_url)
                    assert exported.ok and len(exported.body())>1000
                    (tmp/'export.mp4').write_bytes(exported.body())
                    from core.media import ffmpeg
                    info=subprocess.run([ffmpeg(),'-i',str(tmp/'export.mp4')],capture_output=True,text=True)
                    assert 'Video: h264' in info.stderr and 'Audio: aac' in info.stderr,info.stderr
                    page.screenshot(path=str(images/'researchpal-studio.png'))
                    result['checks'].append('Studio: source → HTTP fixture storyboard → edit → real Windows narration → FFmpeg H.264/AAC MP4 → playable/downloadable media')
                else:
                    page.screenshot(path=str(images/'researchpal-studio.png'))
                    result['checks'].append('Studio source → HTTP fixture storyboard → editable narration/visual fields; rendering with audio skipped')
                mobile=browser.new_page(viewport={'width':390,'height':844},device_scale_factor=1,is_mobile=True,has_touch=True)
                mobile.on('pageerror',lambda error:result['browser_errors'].append(str(error)))
                mobile.goto(base+f'/#/paper/{paper_id}')
                mobile.locator('#full-document table').wait_for()
                assert mobile.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'Mobile document overflows'
                mobile.screenshot(path=str(images/'researchpal-mobile.png'))
                mobile.locator('.mobile-dock [data-route="settings"]').click()
                mobile.locator('#save-connections').wait_for()
                assert mobile.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'Mobile settings overflows'
                result['checks'].append('390px mobile document, bottom navigation and settings; no horizontal page overflow')
                assert not result['browser_errors'], result['browser_errors']
                browser.close()
        finally:
            process.terminate()
            try:process.wait(timeout=10)
            except subprocess.TimeoutExpired:process.kill()
            log.close()
            cloud.shutdown()
    result['status']='passed'
    target=ROOT/'docs/verification.json';target.write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(result,indent=2))

if __name__=='__main__':run()
