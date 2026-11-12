#!/usr/bin/env python3
"""Actual extracted app, disposable local account. No tenant, ACP or model calls."""
import argparse,base64,hashlib,json,os,plistlib,re,shutil,socket,subprocess,sys,tarfile,tempfile,time,urllib.request,urllib.error,uuid,zipfile
from pathlib import Path
import xml.etree.ElementTree as ET

def extract(package,dest):
 if package.name.endswith('.tar.gz'):
  with tarfile.open(package)as source:source.extractall(dest,filter='data')
 else:
  with zipfile.ZipFile(package)as source:
   for row in source.infolist():
    p=dest/row.filename
    if p.resolve().is_relative_to(dest.resolve()) is False:raise ValueError('Archive path escapes')
    if row.is_dir():p.mkdir(parents=True,exist_ok=True);continue
    p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(source.read(row));p.chmod((row.external_attr>>16)&0o777 or 0o644)
def request(base,path,body=None,headers=None):
 r=urllib.request.Request(base+path,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json',**(headers or {})})
 try:response=urllib.request.build_opener(urllib.request.ProxyHandler({})).open(r,timeout=20)
 except urllib.error.HTTPError as e:response=e
 with response:return response.status,dict(response.headers.items()),json.load(response)

def validate_windows_startup(value,executable,home,require_trigger_owner=True):
 """Inspect COM Unicode XML plus Windows-resolved identities, not display names."""
 task=ET.fromstring(base64.b64decode(value['xml']).decode('utf8'));ns={'t':'http://schemas.microsoft.com/windows/2004/02/mit/task'}
 actions=task.find('t:Actions',ns);principals=task.find('t:Principals',ns);triggers=task.find('t:Triggers',ns)
 assert actions is not None and len(actions)==1 and actions[0].tag.endswith('}Exec')
 assert principals is not None and len(principals)==1 and principals[0].tag.endswith('}Principal')
 assert triggers is not None and len(triggers)==1 and triggers[0].tag.endswith('}LogonTrigger')
 action,principal,trigger=actions[0],principals[0],triggers[0]
 assert os.path.samefile(action.findtext('t:Command',namespaces=ns),executable)
 arguments=action.findtext('t:Arguments',namespaces=ns)
 assert arguments.startswith('--home "')and arguments.endswith('" serve'),arguments
 assert os.path.samefile(arguments[len('--home "'):-len('" serve')],home)
 assert len(principal.findall('t:UserId',ns))==1 and value['principal_sid']==value['sid']
 assert principal.findtext('t:LogonType',namespaces=ns)=='InteractiveToken'
 assert principal.findtext('t:RunLevel',namespaces=ns)in(None,'LeastPrivilege')
 assert principal.find('t:GroupId',ns)is None
 owners=trigger.findall('t:UserId',ns)
 if require_trigger_owner:assert len(owners)==1 and owners[0].text,'New task must bind its logon trigger'
 else:assert len(owners)<=1
 if owners:assert value['trigger_sid']==value['sid'],'Logon trigger must resolve to the current SID'
 assert trigger.findtext('t:Enabled',namespaces=ns)in(None,'true')
 return hashlib.sha256(ET.tostring(task)).hexdigest()

def parse_startup_observation(text):
 """Fixed .NET output; no PowerShell module/JSON command discovery is needed."""
 fields=text.splitlines()
 if fields==['teams-startup-v1','absent']:return {'exists':False}
 if len(fields)!=6 or fields[:2]!=['teams-startup-v1','present']:
  raise ValueError('Invalid startup observation framing')
 xml=base64.b64decode(fields[2],validate=True)
 if not xml or base64.b64encode(xml).decode('ascii')!=fields[2]:
  raise ValueError('Invalid startup observation XML encoding')
 xml.decode('utf8')
 value={'exists':True,'xml':fields[2]}
 for key,field in zip(('sid','principal_sid','trigger_sid'),fields[3:]):
  if field=='-' and key!='sid':value[key]=None
  elif re.fullmatch(r'S-1-[0-9]+(?:-[0-9]+)+',field):value[key]=field
  else:raise ValueError('Invalid startup observation SID field')
 return value

def observe_startup(root,home,label,require_trigger_owner=True):
 executable=home/'bin'/('acp-teams-adapter.exe'if os.name=='nt'else'acp-teams-adapter')
 if os.name=='nt':
  # Fixed inline code avoids changing or bypassing ordinary script-file policy.
  # Only the fixture UUID and output path vary, through environment variables.
  script=r'''$ErrorActionPreference = 'Stop'
function Mark([string]$phase) { [Console]::Error.WriteLine('startup-inspection: ' + $phase); [Console]::Error.Flush() }
Mark 'script-entered'
function AccountSid([string]$account) {
 if ([string]::IsNullOrEmpty($account)) { return $null }
 if ($account.StartsWith('S-1-')) { return ([Security.Principal.SecurityIdentifier]::new($account)).Value }
 return ([Security.Principal.NTAccount]::new($account)).Translate([Security.Principal.SecurityIdentifier]).Value
}
Mark 'before-service'
$serviceType = [Type]::GetTypeFromProgID('Schedule.Service',$true)
Mark 'before-com-activation'
$s = [Activator]::CreateInstance($serviceType)
Mark 'before-connect'
$s.Connect()
$t = $null
Mark 'before-folder'
$folder = $s.GetFolder('\')
Mark 'before-query'
try { $t = $folder.GetTask($env:TEAMS_FIXTURE_TASK) }
catch {
 Mark 'query-exception'
 $e = $_.Exception
 $seen = [System.Collections.Generic.List[object]]::new()
 for ($i=0; $i -lt 12; $i++) {
  foreach ($old in $seen) { if ([Object]::ReferenceEquals($old,$e)) { throw 'Startup inspection exception cycle' } }
  $seen.Add($e)
  Mark ('exception-' + $i + '-hresult-' + $e.HResult)
  if ($null -eq $e.InnerException) { break }
  if ($i -eq 11) { throw 'Startup inspection exception depth exceeded' }
  $e = $e.InnerException
 }
 if ($e.HResult -ne -2147024894) { throw }
 Mark 'confirmed-absent'
}
Mark 'query-complete'
$fields = [string[]]@('teams-startup-v1','absent')
if ($null -ne $t) {
 [xml]$x = $t.Xml
 $ns = [Xml.XmlNamespaceManager]::new($x.NameTable)
 $ns.AddNamespace('t','http://schemas.microsoft.com/windows/2004/02/mit/task')
 $p = $x.SelectSingleNode('/t:Task/t:Principals/t:Principal/t:UserId',$ns)
 $g = $x.SelectSingleNode('/t:Task/t:Triggers/t:LogonTrigger/t:UserId',$ns)
 $principal = AccountSid $p.InnerText
 $trigger = AccountSid $g.InnerText
 if ($null -eq $principal) { $principal = '-' }
 if ($null -eq $trigger) { $trigger = '-' }
 $fields = [string[]]@('teams-startup-v1','present',[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t.Xml)),[Security.Principal.WindowsIdentity]::GetCurrent().User.Value,$principal,$trigger)
}
Mark 'before-result'
$encoded = [String]::Join("`n",$fields) + "`n"
$utf8 = [Text.UTF8Encoding]::new($false)
Mark 'before-result-write'
[IO.File]::WriteAllText($env:TEAMS_FIXTURE_OUTPUT,$encoded,$utf8)
Mark 'result-written'
Mark 'complete'
'''
  output=root/'startup-observation.txt';env=dict(os.environ,TEAMS_FIXTURE_TASK=label,TEAMS_FIXTURE_OUTPUT=str(output))
  powershell=Path(os.environ['SystemRoot'])/'System32/WindowsPowerShell/v1.0/powershell.exe'
  print('startup-inspection: before-powershell',file=sys.stderr,flush=True)
  try:
   subprocess.run([str(powershell),'-NoProfile','-NonInteractive','-Command',script],env=env,check=True,capture_output=True,timeout=30)
  except (subprocess.TimeoutExpired,subprocess.CalledProcessError) as error:
   # Fixed fixture diagnostics only: no configuration, account or secret bytes.
   for stream in (error.stdout,error.stderr):
    if stream:print(stream.decode('utf8',errors='replace') if isinstance(stream,bytes) else stream,file=sys.stderr,flush=True)
   raise
  value=parse_startup_observation(output.read_text(encoding='utf8'))
  if not value['exists']:return None
  return validate_windows_startup(value,executable,home,require_trigger_owner)
 if sys.platform!='darwin':raise AssertionError('Startup registration fixture requires Windows or macOS')
 path=Path.home()/'Library/LaunchAgents'/(label+'.plist')
 if not path.exists():return None
 value=plistlib.loads(path.read_bytes())
 assert value['Label']==label and value['RunAtLoad']is True
 args=value['ProgramArguments'];assert len(args)==4 and args[1]=='--home'and args[3]=='serve'
 assert os.path.samefile(args[0],executable)and os.path.samefile(args[2],home)
 return hashlib.sha256(path.read_bytes()).hexdigest()

def exercise_startup(base,auth,root,home,config,password,checks):
 label='acp-teams-adapter-'+str(uuid.UUID(json.loads(config)['id']))
 assert observe_startup(root,home,label)is None,'Fresh fixture must not replace any existing registration'
 attempted=False;removed=False
 try:
  attempted=True
  code,_,value=request(base,'/api/v1/startup',{'enabled':True},auth)
  assert code==200 and value=={'configured':True},(code,value)
  original=observe_startup(root,home,label);assert original is not None
  code,_,value=request(base,'/api/v1/startup',{'enabled':True},auth)
  assert code==200 and value=={'configured':True},(code,value)
  assert observe_startup(root,home,label)==original,'Repeated enable changed the owned registration'
  checks.append('authenticated startup enable and idempotent GUI readback bind the exact installation and current logon owner')
  code,_,value=request(base,'/api/v1/startup',{'enabled':False},auth)
  assert code==200 and value=={'configured':False},(code,value)
  assert observe_startup(root,home,label)is None;removed=True
  assert(home/'adapter.json').read_bytes()==config and(home/'secrets/local-password.json').read_bytes()==password
  code,_,status=request(base,'/api/v1/status',headers=auth)
  assert code==200 and status['enabled']is False and status['teams_configured']is False and status['active']==0
  checks.append('startup removal preserves account, config and paused connector; no OS sign-in or external engine start')
 finally:
  if attempted and not removed:
   # Only the fresh UUID, previously absent and still bound to our exact command,
   # home and principal, is eligible for fixture cleanup if the app refuses it.
   failure=sys.exc_info()[1]
   try:
    if observe_startup(root,home,label,require_trigger_owner=False)is not None:
     if os.name=='nt':
      executable=Path(os.environ['SystemRoot'])/'System32/schtasks.exe'
      subprocess.run([str(executable),'/Delete','/TN',label,'/F'],check=True,capture_output=True,timeout=20)
     else:(Path.home()/'Library/LaunchAgents'/(label+'.plist')).unlink()
     assert observe_startup(root,home,label)is None
   except BaseException as cleanup:
    if failure is None:raise
    failure.add_note('Fixture startup cleanup failed: '+str(cleanup))

def launch_failure_details(root,home,bundle):
 """Retain bounded file names/phase markers, never configuration or secret bytes."""
 details={'published_home_exists':home.exists(),'stages':[]}
 try:
  manifest=next(bundle.rglob('native-bundle.json'))
  expected=set(json.loads(manifest.read_text(encoding='utf8'))['files'])
  markers=['native-bundle.json','adapter.json','native.json','secrets/first-account.json','bin/acp-teams-adapter','bin/acp-teams-adapter.exe']
  for stage in sorted(home.parent.glob('.teams-setup-*'))[:4]:
   files={p.relative_to(stage).as_posix():p.stat().st_mtime_ns for p in stage.rglob('*')if p.is_file()}
   missing=sorted(expected-files.keys())
   details['stages'].append({'expected_files':len(expected),'present_expected_files':len(expected&files.keys()),'missing_count':len(missing),'first_missing':missing[:12],'last_committed':sorted(files,key=files.get)[-12:],'markers':{name:(stage/name).is_file()for name in markers}})
 except (OSError,ValueError,KeyError,StopIteration) as error:
  details['inventory_error']=type(error).__name__
 try:log=(root/'server.log').read_text(encoding='utf8',errors='replace')[-4000:]
 except OSError:log='Native process log unavailable'
 log=re.sub(r'(#setup=)[^"\s]+',r'\1[redacted]',log)
 return json.dumps(details,ensure_ascii=True)+'\n'+log

def wait_started(process,log,root,home,bundle,seconds=180):
 try:
  deadline=time.monotonic()+seconds
  while time.monotonic()<deadline:
   if process.poll() is not None:raise AssertionError(f'Native process exited ({process.returncode})')
   try:
    settings=json.loads((home/'native.json').read_text(encoding='utf8'));base=settings['origin'];status,_,_=request(base,'/auth/session')
    if status==200:return process,log,base
   except(OSError,ValueError):pass
   time.sleep(.1)
  raise AssertionError(f'Native app did not become ready after {seconds} seconds')
 except BaseException as failure:
  cleanup_error=None
  try:
   if process.poll()is None:process.kill()
   process.wait(timeout=20)
  except (OSError,subprocess.TimeoutExpired)as error:cleanup_error=type(error).__name__
  finally:log.close()
  details=launch_failure_details(root,home,bundle)
  if cleanup_error:details+='\nOwned process cleanup: '+cleanup_error
  raise AssertionError(str(failure)+'\n'+details)from failure

def run(package,result,browser=False,verify_startup=False):
 checks=[]
 if verify_startup and os.name!='nt'and sys.platform!='darwin':raise AssertionError('Startup fixture requires Windows/macOS; no Linux manager is provisioned')
 with tempfile.TemporaryDirectory(prefix='Teams native ')as tmp:
  root=Path(tmp);bundle=root/'download';bundle.mkdir();extract(package,bundle);binary=next(p for p in bundle.rglob('acp-teams-adapter.exe' if os.name=='nt' else 'acp-teams-adapter')if p.is_file());binary.chmod(0o755);home=root/'connection café 雪'
  env={k:v for k,v in os.environ.items()if not k.upper().startswith(('TEAMS_','OPENAI_','ANTHROPIC_','AZURE_','GOOGLE_','AMPLIFIER_','NODE_','ACP_'))};env['PATH']=str(root/'no-tools')
  if verify_startup:env['PATH']=str(Path(os.environ['SystemRoot'])/'System32')if os.name=='nt'else'/usr/bin:/bin'
  def start():
   log=open(root/'server.log','ab')
   try:p=subprocess.Popen([str(binary),'--home',str(home),'--no-browser'],stdin=subprocess.DEVNULL,stdout=log,stderr=log,env=env)
   except BaseException:
    log.close();raise
   return wait_started(p,log,root,home,bundle)
  def stop(p,log,base):
   p.terminate();p.wait(timeout=20);log.close()
   for _ in range(60):
    try:request(base,'/auth/session');time.sleep(.05)
    except OSError:break
   else:raise AssertionError('Child server survived native launcher termination')
  p,log,base=start()
  stop(p,log,base)
  checks.append('immediate close after endpoint readiness leaves no child server')
  p,log,base=start()
  try:
   config=(home/'adapter.json').read_bytes();c=json.loads(config);assert c['enabled'] is False and c['teams']['client_id']=='' and c['acp']['command']=='';checks.append('fresh package stays paused without tenant, agent or model')
   code,_,_=request(base,'/api/v1/status');assert code==401
   code,_,_=request(base,'/auth/session',headers={'Host':'evil.test','Origin':'http://evil.test'});assert code==403
   code,_,_=request(base,'/api/messages',{});assert code==503;checks.append('no management exposure or fabricated Teams availability')
   cap=json.loads((home/'secrets/first-account.json').read_text())['token'];password='Disposable Teams password 29';origin={'Origin':base}
   code,_,_=request(base,'/auth/first-account',{'setup_token':'wrong','password':password,'start_at_signin':False},origin);assert code==403
   if browser:
    fixture=root/'browser.json';fixture.write_text(json.dumps({'base':base,'cap':cap,'password':password}));subprocess.run([shutil.which('node'),str(Path(__file__).with_name('native-browser.mjs')),str(fixture)],check=True,timeout=90);checks.append('browser local setup lost reply and sign-in')
    code,headers,session=request(base,'/auth/login',{'password':password},origin)
   else:code,headers,session=request(base,'/auth/first-account',{'setup_token':cap,'password':password,'start_at_signin':False},origin)
   assert code==200 and session['authenticated'];cookie=next(v for k,v in headers.items()if k.lower()=='set-cookie').split(';')[0];auth={'Cookie':cookie,'X-CSRF-Token':session['csrf'],'Origin':base}
   saved=(home/'secrets/local-password.json').read_bytes();assert password.encode()not in saved and json.loads(saved)['encoded'].startswith('$argon2id$');checks.append('shared Argon2 account without system tools or secret argv')
   code,_,_=request(base,'/auth/first-account',{'setup_token':cap,'password':password+' changed','start_at_signin':False},origin);assert code==409;assert(home/'secrets/local-password.json').read_bytes()==saved
   code,_,_=request(base,'/api/v1/views',{}, {'Cookie':cookie,'Origin':base});assert code==401
   code,_,view=request(base,'/api/v1/views',{},auth);assert code in (200,201);checks.append('existing browser API requires session and CSRF; account create-only')
   code,_,status=request(base,'/api/v1/status',headers=auth);assert code==200 and status['enabled']is False and status['teams_configured']is False and status['active']==0
   code,_,startup=request(base,'/api/v1/startup',headers=auth);assert code==200 and startup['configured']is False;checks.append('no startup service or external agent activated')
   if verify_startup:exercise_startup(base,auth,root,home,config,saved,checks)
   if os.name=='nt':
    subprocess.run([str(home/'runtime/node.exe'),str(Path(__file__).with_name('native-acp-lifetime.mjs')),str(home/'bin/acp-teams-adapter.exe'),base],check=True,timeout=30)
    checks.append('individual native ACP close stops its immediate grandchildren while Teams app stays available')
   reopened=subprocess.run([str(binary),'--home',str(home),'--no-browser'],env=env,capture_output=True,text=True,encoding='utf8',timeout=20);assert reopened.returncode==0,reopened.stderr;assert(home/'adapter.json').read_bytes()==config;checks.append('reopen proves same listener without duplicate process or config replacement')
   code,_,_=request(base,'/auth/logout',{},auth);assert code==200
   code,_,_=request(base,'/api/v1/status',headers=auth);assert code==401;checks.append('signout revokes only local browser session')
  finally:stop(p,log,base)
  p,log,base=start()
  try:
   assert(home/'adapter.json').read_bytes()==config and(home/'secrets/local-password.json').read_bytes()==saved
   code,h,session=request(base,'/auth/login',{'password':password},{'Origin':base});assert code==200
   cookie=next(v for k,v in h.items()if k.lower()=='set-cookie').split(';')[0];code,_,retained=request(base,'/api/v1/views/'+view['id'],headers={'Cookie':cookie});assert code==200 and retained['id']==view['id'];checks.append('restart retains account, configuration and saved views')
  finally:stop(p,log,base)
  checks.append('launcher shutdown contains its child server')
 result.parent.mkdir(parents=True,exist_ok=True);result.write_text(json.dumps({'checks':checks,'passed':len(checks),'package_sha256':hashlib.sha256(package.read_bytes()).hexdigest(),'production_operations':False,'startup_installation':verify_startup,'startup_registration_removed':verify_startup,'automatic_sign_in_launch':'not_tested','tenant_or_model_calls':0},indent=2)+'\n');print(json.dumps({'passed':len(checks),'checks':checks}))
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--package',type=Path,required=True);p.add_argument('--result',type=Path,required=True);p.add_argument('--browser',action='store_true');p.add_argument('--verify-startup',action='store_true');a=p.parse_args();run(a.package,a.result,a.browser,a.verify_startup)
