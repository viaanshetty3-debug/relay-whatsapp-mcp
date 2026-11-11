"""Optional local engine checks: .media-venv/bin/python -B test/test_media_worker.py"""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from pypdf import PdfWriter
from pypdf.generic import NameObject,DictionaryObject,DecodedStreamObject

ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('media_worker',ROOT/'scripts/media-worker.py')
worker=importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

class MediaWorkerTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.work=Path(self.temp.name)
    def request(self,path,mime,mode,**kwargs):
        return dict(input=str(path),output=str(self.work),mimeType=mime,filename=path.name,mode=mode,startSeconds=0,**kwargs)
    def test_video_frames(self):
        video=self.work/'video.mp4'
        subprocess.run([worker.FFMPEG,'-v','error','-f','lavfi','-i','color=c=red:s=320x240:d=2','-c:v','libx264','-pix_fmt','yuv420p',str(video)],check=True)
        result=worker.process(self.request(video,'video/mp4','frames',maxFrames=3))
        self.assertEqual(len(result['frames']),3)
        self.assertTrue(result['warnings'])
    def test_pdf_text(self):
        writer=PdfWriter();page=writer.add_blank_page(width=300,height=150)
        font=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')})
        page[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):font})})
        stream=DecodedStreamObject();stream.set_data(b'BT /F1 20 Tf 20 80 Td (Media PDF extraction check) Tj ET');page[NameObject('/Contents')]=stream
        pdf=self.work/'source.pdf';writer.write(pdf)
        result=worker.process(self.request(pdf,'application/pdf','extract'))
        self.assertIn('Media PDF extraction check',result['text'])
    def test_scanned_page_rendering_and_ocr_dispatch(self):
        writer=PdfWriter();writer.add_blank_page(width=300,height=150);pdf=self.work/'scanned.pdf';writer.write(pdf)
        original=worker.describe
        try:
            worker.describe=lambda images,prompt:('OCR fixture text','test-model')
            result=worker.process(self.request(pdf,'application/pdf','extract'))
        finally:worker.describe=original
        self.assertEqual(result['text'],'OCR fixture text');self.assertTrue((self.work/'page-0.jpg').exists())

if __name__=='__main__':unittest.main()
