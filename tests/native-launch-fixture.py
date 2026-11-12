"""Failure evidence and exact child/log cleanup; no app, tenant or model."""
import importlib.util
import io
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


class UpdateFailureEvidence(unittest.TestCase):
 def setUp(self):
  spec=importlib.util.spec_from_file_location('native_update_fixture',Path(__file__).with_name('native-update-process.py'))
  self.update=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.update)

 def exercise(self,root,journal,opener):
  home=root/'home';home.mkdir();(home/'native-update.json').write_text(json.dumps(journal))
  (root/'server.log').write_text('Bearer private-token http://127.0.0.1:1/#setup=another-secret password-secret')
  process=mock.Mock(pid=123);process.poll.return_value=None
  failure=AssertionError('Original terminal timeout')
  with mock.patch.object(self.update.urllib.request,'build_opener',return_value=opener),mock.patch('sys.stdout',new_callable=io.StringIO):
   evidence=self.update.failure_evidence(root,home,root/'result.json','http://127.0.0.1:1','private-token',process,[],[('http://127.0.0.1:2','offer-secret')],['private-token','password-secret','offer-secret'],failure)
  self.assertEqual(str(failure),'Original terminal timeout')
  self.assertEqual(json.loads((root/'result-failure.json').read_text()),evidence)
  return evidence

 def test_dead_api_preserves_phase_and_unknown_process_outcome_without_secrets(self):
  with tempfile.TemporaryDirectory()as directory:
   opener=mock.Mock();opener.open.side_effect=self.update.urllib.error.URLError('Connection refused')
   evidence=self.exercise(Path(directory),{'phase':'rollback_starting','error':'Cannot commit private state password-secret','protected':{'credential':'hidden-config-value'},'launch_nonce':'private-nonce'},opener)
   self.assertEqual(evidence['journal']['phase'],'rollback_starting')
   self.assertEqual(evidence['health']['process_exit'],'not_established')
   self.assertIsNone(evidence['known_processes'][0]['exit_code'])
   self.assertIn('Stdio::null',evidence['worker_stderr'])
   for private in ['private-token','another-secret','password-secret','hidden-config-value','private-nonce']:
    self.assertNotIn(private,json.dumps(evidence))
   for call in opener.open.call_args_list:self.assertEqual(call.kwargs['timeout'],2)

 def test_health_and_offer_snapshot_only_keep_allowed_scalar_metadata(self):
  with tempfile.TemporaryDirectory()as directory:
   value={'id':'example-installation','pid':123,'launcher_pid':124,'version':'0.5.2','active':0,'enabled':False,'phase':'starting','worker_active':True,'config':{'secret':'hidden-config'},'model':'hidden-model','launch_nonce':'hidden-nonce'}
   reply=mock.MagicMock(status=200);reply.__enter__.return_value=reply;reply.read.return_value=json.dumps(value).encode()
   opener=mock.Mock();opener.open.return_value=reply
   evidence=self.exercise(Path(directory),{'phase':'starting','error':{'config':'hidden-config'},'candidate':{'version':{'model':'hidden-model'}}},opener)
   self.assertEqual(evidence['health']['fields']['pid'],123)
   self.assertTrue(evidence['offers'][0]['fields']['worker_active'])
   for private in ['hidden-config','hidden-model','hidden-nonce']:self.assertNotIn(private,json.dumps(evidence))

 def test_directory_cleanup_failure_keeps_original_terminal_failure(self):
  directory=mock.Mock(name='directory');directory.name='unused fixture';directory.cleanup.side_effect=PermissionError('Still open')
  original=AssertionError('Original terminal timeout')
  with mock.patch.object(self.update.tempfile,'TemporaryDirectory',return_value=directory),mock.patch('sys.stdout',new_callable=io.StringIO):
   with self.assertRaises(AssertionError)as raised:
    with self.update.fixture_directory():raise original
  self.assertIs(raised.exception,original)
  self.assertIn('cleanup not confirmed',original.__notes__[0])

 def test_malformed_journal_does_not_replace_original_failure(self):
  with tempfile.TemporaryDirectory()as directory:
   opener=mock.Mock();opener.open.side_effect=self.update.urllib.error.URLError('offline')
   evidence=self.exercise(Path(directory),[],opener)
   self.assertEqual(evidence['journal']['read_error_type'],'AttributeError')
   self.assertEqual(evidence['error']['message'],'Original terminal timeout')


class StartupFraming(unittest.TestCase):
 def present(self,principal='S-1-5-21-1234',trigger='S-1-5-21-1234'):
  xml=base64.b64encode('<Task>café 雪</Task>'.encode()).decode()
  return '\n'.join(['teams-startup-v1','present',xml,'S-1-5-21-1234',principal,trigger])+'\n'

 def test_exact_absence_marker(self):
  self.assertEqual(launch.parse_startup_observation('teams-startup-v1\nabsent\n'),{'exists':False})

 def test_present_preserves_unicode_xml_and_resolved_sids(self):
  value=launch.parse_startup_observation(self.present())
  self.assertTrue(value['exists'])
  self.assertEqual(base64.b64decode(value['xml']).decode(),'<Task>café 雪</Task>')
  self.assertEqual(value['sid'],value['principal_sid'])
  self.assertEqual(value['sid'],value['trigger_sid'])

 def test_missing_extra_unknown_or_duplicate_fields_refuse(self):
  good=self.present()
  cases=['','absent\n','teams-startup-v2\nabsent\n','teams-startup-v1\nunknown\n',
   'teams-startup-v1\nabsent\nextra\n','teams-startup-v1\nabsent\n\n',
   good.rsplit('\n',2)[0]+'\n',good+'extra\n',good.replace('present\n','present\npresent\n')]
  for text in cases:
   with self.subTest(text=text),self.assertRaises(ValueError):launch.parse_startup_observation(text)

 def test_invalid_base64_or_non_utf8_refuse(self):
  for encoded in ['','!!!','PFRhc2s+!','/w==','YQ===','YQ== ']:
   fields=self.present().splitlines();fields[2]=encoded
   with self.subTest(encoded=encoded),self.assertRaises(ValueError):launch.parse_startup_observation('\n'.join(fields)+'\n')

 def test_explicit_missing_owner_retained_for_existing_validation(self):
  value=launch.parse_startup_observation(self.present('-','-'))
  self.assertIsNone(value['principal_sid']);self.assertIsNone(value['trigger_sid'])
  # Parsing never turns an absent owner into the current user or absent task.
  self.assertTrue(value['exists']);self.assertEqual(value['sid'],'S-1-5-21-1234')

 def test_malformed_sid_refuses_but_foreign_identity_is_preserved(self):
  for index in (3,4,5):
   for sid in ['', 'null', 'MACHINE\\User', 'S-1-5--18', 'S-1-5-18 extra']+(['-']if index==3 else[]):
    fields=self.present().splitlines();fields[index]=sid
    with self.subTest(index=index,sid=sid),self.assertRaises(ValueError):launch.parse_startup_observation('\n'.join(fields)+'\n')
  value=launch.parse_startup_observation(self.present(trigger='S-1-5-18'))
  self.assertEqual(value['trigger_sid'],'S-1-5-18')
  self.assertNotEqual(value['trigger_sid'],value['sid'])


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
