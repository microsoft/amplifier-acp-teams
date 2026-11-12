"""Failure evidence and exact child/log cleanup; no app, tenant or model."""
import importlib.util
import base64
import json
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path
import xml.etree.ElementTree as ET

spec=importlib.util.spec_from_file_location('launch',Path(__file__).with_name('native-launch.py'))
launch=importlib.util.module_from_spec(spec)
spec.loader.exec_module(launch)


class FailureEvidence(unittest.TestCase):
 def test_existing_startup_is_not_touched_by_fixture(self):
  config=json.dumps({'id':'940a518b-6f5e-429b-a159-42fde1f3ed67'}).encode()
  with mock.patch.object(launch,'observe_startup',return_value='existing'),mock.patch.object(launch,'request')as api:
   with self.assertRaisesRegex(AssertionError,'must not replace'):
    launch.exercise_startup('http://127.0.0.1:1',{},Path('/unused'),Path('/unused'),config,b'password',[])
   api.assert_not_called()

 def test_exported_account_name_requires_current_resolved_trigger_sid(self):
  with tempfile.TemporaryDirectory(prefix='Teams task identity ')as directory:
   home=Path(directory);executable=home/'adapter';executable.write_text('fixture')
   ns='http://schemas.microsoft.com/windows/2004/02/mit/task'
   def element(parent,name,text=None):
    node=ET.SubElement(parent,'{'+ns+'}'+name);node.text=text;return node
   task=ET.Element('{'+ns+'}Task');trigger=element(element(task,'Triggers'),'LogonTrigger')
   owner=element(trigger,'UserId','MACHINE\\Renée 雪');element(trigger,'Enabled','true')
   principal=element(element(task,'Principals'),'Principal');element(principal,'UserId','MACHINE\\Renée 雪');element(principal,'LogonType','InteractiveToken')
   action=element(element(task,'Actions'),'Exec');element(action,'Command',str(executable));element(action,'Arguments',f'--home "{home}" serve')
   value={'sid':'S-1-5-21-1234','principal_sid':'S-1-5-21-1234','trigger_sid':'S-1-5-21-1234'}
   def rendered():return {**value,'xml':base64.b64encode(ET.tostring(task)).decode()}
   self.assertTrue(launch.validate_windows_startup(rendered(),executable,home))
   for wrong in ['S-1-5-18',None]:
    value['trigger_sid']=wrong
    with self.assertRaises(AssertionError):launch.validate_windows_startup(rendered(),executable,home)
   value['trigger_sid']=value['sid'];value['principal_sid']='S-1-5-18'
   with self.assertRaises(AssertionError):launch.validate_windows_startup(rendered(),executable,home)
   value['principal_sid']=value['sid'];trigger.remove(owner)
   with self.assertRaises(AssertionError):launch.validate_windows_startup(rendered(),executable,home)
   # Missing owner is allowed only for cleanup of the exactly owned old shape.
   self.assertTrue(launch.validate_windows_startup(rendered(),executable,home,False))

 def test_startup_api_failure_is_preserved_and_only_owned_plist_is_removed(self):
  with tempfile.TemporaryDirectory(prefix='Teams startup cleanup ')as directory:
   root=Path(directory);home=root/'app';home.mkdir()
   label='acp-teams-adapter-940a518b-6f5e-429b-a159-42fde1f3ed67'
   folder=root/'Library/LaunchAgents';folder.mkdir(parents=True)
   own=folder/(label+'.plist');own.write_text('owned fixture')
   other=folder/'unrelated.plist';other.write_text('preserve')
   config=json.dumps({'id':label.removeprefix('acp-teams-adapter-')}).encode()
   with mock.patch.object(launch,'observe_startup',side_effect=[None,'owned-hash',None]),mock.patch.object(launch,'request',return_value=(500,{}, {'error':'original registration failure'})),mock.patch.object(Path,'home',return_value=root):
    # This fixture uses the file cleanup path only, without an OS registration.
    with mock.patch.object(launch.os,'name','posix'):
     with self.assertRaisesRegex(AssertionError,'original registration failure'):
      launch.exercise_startup('http://127.0.0.1:1',{},root,home,config,b'password',[])
   self.assertFalse(own.exists());self.assertEqual(other.read_text(),'preserve')

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
