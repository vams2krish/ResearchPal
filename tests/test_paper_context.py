import unittest
from unittest.mock import patch
from core import pipeline, vectorstore


class PaperContextTests(unittest.TestCase):
    def test_unstructured_source_preserved(self):
        text = 'A complete paper without markdown headings.'
        blocks = pipeline.split_into_blocks(text)
        grouped = pipeline.group_by_section(blocks, [])
        self.assertIn(text, grouped['Appendix']['raw_text'])

    def test_heading_only_parent_and_subsection(self):
        blocks = pipeline.split_into_blocks('# Methods\n## Training\nTraining evidence\n# Results\nMeasured 42%.')
        with patch.object(pipeline, '_generate_dict', return_value={}):
            categories = pipeline.classify_blocks(blocks)
        self.assertEqual(categories, ['Methods', 'Methods', 'Results'])
        grouped = pipeline.group_by_section(blocks, categories)
        self.assertIn('## Training', grouped['Methods']['raw_text'])
        self.assertIn('Training evidence', grouped['Methods']['raw_text'])

    def test_long_paragraph_chunks_cover_entire_source(self):
        text = 'x' * 15000 + 'TAIL EVIDENCE'
        chunks = vectorstore.chunk_text(text, size=6000, overlap=0)
        self.assertEqual(''.join(chunks), text)
        self.assertTrue(all(len(chunk) <= 6000 for chunk in chunks))

    def test_analysis_visits_tail_and_handles_bad_formula(self):
        text = 'x' * 14000 + 'TAIL EVIDENCE'
        prompts = []
        def generate(prompt):
            prompts.append(prompt)
            return {'explanation': 'Evidence', 'formulas': [None, {'equation_raw': '$x=1$'}]}
        with patch.object(pipeline, '_generate_dict', side_effect=generate):
            result = pipeline.analyze_sections({'Results': {'raw_text': text}})
        self.assertEqual(len(prompts), 3)
        self.assertIn('TAIL EVIDENCE', prompts[-1])
        self.assertEqual(len(result['Results']['formulas']), 1)

    def test_invalid_classification_keeps_content(self):
        grouped = pipeline.group_by_section([{'title': 'Funding', 'body': 'Support details'}], ['bogus'])
        self.assertIn('Support details', grouped['Appendix']['raw_text'])


if __name__ == '__main__':
    unittest.main()
