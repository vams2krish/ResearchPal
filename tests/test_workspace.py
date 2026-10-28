import io
import json
import tempfile
import time
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch, Mock, MagicMock

from core import config, documents, llm, providers, vectorstore, model_storage, media


class ProviderAndDocumentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.patch = patch.object(config, 'DATA_DIR', self.root)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def test_connection_secrets_are_redacted_and_blank_keeps_key(self):
        settings = providers.defaults()
        settings['providers']['openrouter']['api_key'] = 'test-secret-never-returned'
        public = providers.save(settings)
        self.assertNotIn('test-secret-never-returned', json.dumps(public))
        self.assertTrue(public['providers']['openrouter']['has_api_key'])
        providers.save(public)
        self.assertEqual(providers.load()['providers']['openrouter']['api_key'], 'test-secret-never-returned')
        public['providers']['openrouter']['clear_api_key'] = True
        providers.save(public)
        self.assertFalse(providers.public_settings()['providers']['openrouter']['has_api_key'])

    def test_manual_host_is_used_for_chat_and_embedding(self):
        settings = providers.defaults()
        settings['providers']['ollama']['base_url'] = 'http://127.0.0.1:12345'
        settings['routes']['text'] = {'provider': 'ollama', 'model': 'custom-local'}
        providers.save(settings)
        with patch('ollama.Client') as client:
            client.return_value.chat.return_value = {'message': {'content': 'hello'}}
            self.assertEqual(providers.chat('question'), 'hello')
            self.assertEqual(client.call_args.kwargs['host'], 'http://127.0.0.1:12345')
            providers.embedding('query')
            self.assertEqual(client.call_args.kwargs['host'], 'http://127.0.0.1:12345')

    def test_valid_json_newlines_are_not_corrupted(self):
        with patch.object(llm, 'generate', return_value='{"explanation":"Line one\\nLine two"}'):
            self.assertEqual(llm.generate_json('')['explanation'], 'Line one\nLine two')

    def test_storage_discovery_finds_renamed_nested_directory(self):
        target = self.root/'arbitrary folder'/'weights'/'models'
        (target/'blobs').mkdir(parents=True)
        manifests=target/'manifests'/'registry.ollama.ai'/'library'/'moved-model'
        manifests.mkdir(parents=True)
        (manifests/'latest').write_text('{}')
        found=model_storage.discover(root=str(self.root),seconds=2)
        item=next(item for item in found['folders'] if item['path']==str(target.resolve()))
        self.assertEqual(item['models'], ['moved-model:latest'])

    def test_unlimited_ocr_sends_every_page_and_checks_coverage(self):
        page=Mock()
        page.get_pixmap.return_value.tobytes.return_value=b'fake-png-for-contract'
        doc=MagicMock()
        doc.__len__.return_value=2
        doc.__iter__.return_value=iter([page,page])
        response=Mock()
        response.iter_lines.return_value=[
            'data: '+json.dumps({'choices':[{'delta':{'content':'<PAGE>First page <PAGE>Last page'}}]}),
            'data: [DONE]']
        with patch.object(providers,'selected',return_value=({'kind':'unlimited_ocr','base_url':'http://127.0.0.1:10000/v1'},'Unlimited-OCR-2')), patch.object(providers,'request',return_value=response) as request:
            text=documents.unlimited_ocr(doc)
        body=request.call_args.kwargs['json']
        self.assertEqual(len(body['messages'][0]['content']),3)
        self.assertEqual(body['max_tokens'],16000)
        self.assertIn('<!-- Page 2 -->',text)
        self.assertIn('Last page',text)

    def test_openrouter_media_endpoint_contracts(self):
        import base64
        image_response=Mock()
        image_response.json.return_value={'data':[{'b64_json':base64.b64encode(b'fixture-image').decode()}]}
        with patch.object(providers,'selected',return_value=({'kind':'openrouter'},'image-model')), patch.object(providers,'request',return_value=image_response) as request:
            target=media.image('visual',self.root/'image.png')
        self.assertEqual(request.call_args.args[2],'/images')
        self.assertEqual(target.read_bytes(),b'fixture-image')
        submit,poll,content=Mock(),Mock(),Mock()
        submit.json.return_value={'id':'video-job'}
        poll.json.return_value={'status':'completed'}
        content.content=b'fixture-video'
        with patch.object(providers,'selected',return_value=({'kind':'openrouter'},'video-model')), patch.object(providers,'request',side_effect=[submit,poll,content]) as request, patch('core.jobs.update'):
            target=media.cloud_video('motion',self.root/'clip.mp4','local-job')
        self.assertEqual(request.call_args.args[2],'/videos/video-job/content')
        self.assertEqual(target.read_bytes(),b'fixture-video')

    def test_invalid_capability_is_rejected(self):
        settings = providers.defaults()
        settings['routes']['text']['provider'] = 'automatic1111'
        with self.assertRaises(ValueError): providers.save(settings)

    def test_docx_headings_and_final_paragraph_survive(self):
        target = self.root / 'document.docx'
        with zipfile.ZipFile(target, 'w') as archive:
            archive.writestr('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Methods</w:t></w:r></w:p><w:p><w:r><w:t>Last paragraph evidence.</w:t></w:r></w:p></w:body></w:document>')
        text, info = documents.extract(target)
        self.assertIn('# Methods', text)
        self.assertTrue(text.endswith('Last paragraph evidence.'))

    def test_narration_preserves_tail_without_visual_paths(self):
        raw = '# Topic\n\n![Figure](private/file.png)\n\n' + 'text ' * 3000 + 'FINAL WORDS'
        spoken = documents.spoken_text(raw)
        self.assertNotIn('private/file.png', spoken)
        self.assertTrue(''.join(vectorstore.chunk_text(spoken, size=1400, overlap=0)).endswith('FINAL WORDS'))


class WorkspaceAPITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        cls.patches = [patch.object(config, 'DATA_DIR', cls.root), patch.object(config, 'DB_PATH', cls.root/'app.db'), patch.object(config, 'PAPERS_DIR', cls.root/'papers'), patch.object(config, 'ENV_PATH', cls.root/'.env')]
        for p in cls.patches: p.start()
        (cls.root/'papers').mkdir()
        from fastapi.testclient import TestClient
        import server
        cls.client = TestClient(server.app)

    @classmethod
    def tearDownClass(cls):
        cls.client.close()
        for p in reversed(cls.patches): p.stop()
        cls.temp.cleanup()

    def test_import_read_export_without_generation(self):
        text = '# A full document\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n' + 'Context. ' * 2000 + 'TAIL-EVIDENCE'
        with patch.object(llm, 'generate', side_effect=AssertionError('Import must not call a text model')):
            response = self.client.post('/api/papers', files={'files': ('full-context.md', text.encode(), 'text/markdown')})
        self.assertEqual(response.status_code, 200, response.text)
        paper_id = response.json()['created'][0]['id']
        source = self.client.get(f'/api/papers/{paper_id}/source').json()
        self.assertTrue(source['markdown'].endswith('TAIL-EVIDENCE'))
        self.assertTrue(source['spoken_parts'][-1].endswith('TAIL-EVIDENCE'))
        paper = self.client.get(f'/api/papers/{paper_id}').json()
        self.assertEqual(paper['paper']['status'], 'imported')
        self.assertIsNone(paper['pdf_url'])
        self.assertEqual(self.client.get(f'/api/papers/{paper_id}/source.md').text, text)

    def test_model_discovery_on_user_url(self):
        with patch.object(providers, 'request') as request:
            request.return_value.json.return_value = {'models': [{'name': 'my-moved-model'}]}
            response = self.client.post('/api/connections/ollama/discover', json={'base_url':'http://127.0.0.1:14444'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['models'][0]['id'], 'my-moved-model')
        self.assertEqual(request.call_args.args[0]['base_url'], 'http://127.0.0.1:14444')

    def test_malformed_render_is_rejected_before_job(self):
        self.assertEqual(self.client.post('/api/studio/render',json={'scenes':[]}).status_code,400)
        self.assertEqual(self.client.post('/api/studio/render',json={'scenes':[{'title':'x'}]}).status_code,400)

    def test_storyboard_job_persists_result(self):
        with patch.object(llm,'generate_json',side_effect=[{'facts':['Source is specific.']},{'scenes':[{'title':'Problem','narration':'The source describes a problem.','visual_prompt':'A simple diagram','source':'Part 1'}]}]):
            response=self.client.post('/api/studio/storyboard',json={'text':'A factual source.'})
            job_id=response.json()['id']
            for _ in range(100):
                job=self.client.get('/api/jobs/'+job_id).json()
                if job['status'] not in ('running','queued'): break
                time.sleep(.01)
        self.assertEqual(job['status'],'completed',job)
        self.assertEqual(job['result']['source_parts'],1)

    def test_unknown_document_returns_404(self):
        self.assertEqual(self.client.get('/api/papers/missing/source').status_code,404)


if __name__ == '__main__': unittest.main()
