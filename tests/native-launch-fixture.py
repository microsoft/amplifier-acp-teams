"""Failure evidence and exact child/log cleanup; no app, tenant or model."""
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

spec=importlib.util.spec_from_file_location('launch',Path(__file__).with_name('native-launch.py'))
launch=importlib.util.module_from_spec(spec)
spec.loader.exec_module(launch)


class FailureEvidence(unittest.TestCase):
 def test_exit_preserves_product_error_and_inventory_without_secret_bytes(self):
  with tempfile.TemporaryDirectory(prefix='Teams failure evidence ')as directory:
   root=Path(directory);bundle=root/'download';bundle.mkdir();home=root/'saved'
   (bundle/'native-bundle.json').write_text(json.dumps({'files':{'app/entry.js':'x','runtime/node.exe':'y'}}))
   stage=root/'.teams-setup-fixture';(stage/'app').mkdir(parents=True);(stage/'app/entry.js').write_text('fixture')
   (stage/'adapter.json').write_text('{"credential":"must-not-be-printed"}')
   (root/'server.log').write_text('Cannot commit private state: Access is denied. (os error 5)\nhttp://127.0.0.1:1/#setup=private-test-token\n')
   log=open(root/'server.log','ab')
   process=subprocess.Popen([sys.executable,'-c','raise SystemExit(7)'],stdin=subprocess.DEVNULL,stdout=log,stderr=log)
   process.wait(timeout=10)
   with self.assertRaises(AssertionError)as raised:launch.wait_started(process,log,root,home,bundle)
   text=str(raised.exception)
   self.assertIn('Native process exited (7)',text)
   self.assertIn('Cannot commit private state: Access is denied. (os error 5)',text)
   self.assertIn('runtime/node.exe',text)
   self.assertIn('"present_expected_files": 1',text)
   self.assertNotIn('must-not-be-printed',text)
   self.assertNotIn('private-test-token',text)
   self.assertTrue(log.closed)
   self.assertEqual(process.returncode,7)
   (root/'server.log').unlink()

 def test_timeout_waits_for_exact_child_and_closes_log(self):
  with tempfile.TemporaryDirectory(prefix='Teams timed-out fixture ')as directory:
   root=Path(directory);bundle=root/'download';bundle.mkdir();home=root/'saved'
   (bundle/'native-bundle.json').write_text('{"files":{}}')
   log=open(root/'server.log','ab')
   process=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'],stdin=subprocess.DEVNULL,stdout=log,stderr=log)
   with self.assertRaisesRegex(AssertionError,'did not become ready after 0 seconds'):
    launch.wait_started(process,log,root,home,bundle,seconds=0)
   self.assertIsNotNone(process.poll())
   self.assertTrue(log.closed)
   (root/'server.log').unlink()


if __name__=='__main__':unittest.main()
