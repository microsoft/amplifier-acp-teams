#!/usr/bin/env python3
"""Real downloaded-package cutover in a disposable paused Teams installation."""
import argparse,contextlib,hashlib,importlib.util,json,os,queue,shutil,sqlite3,subprocess,sys,tempfile,threading,time,urllib.request,urllib.error,re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('launch',ROOT/'tests/native-launch.py');launch=importlib.util.module_from_spec(spec);spec.loader.exec_module(launch)
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def read(path):return json.loads(path.read_text(encoding='utf8'))
def wait(fn,seconds=180):
 deadline=time.monotonic()+seconds
 while time.monotonic()<deadline:
  try:
   result=fn()
   if result:return result
  except(OSError,ValueError,KeyError):pass
  time.sleep(.1)
 raise AssertionError('Bounded fixture wait expired')
def db(home,sql,args=()):
 with contextlib.closing(sqlite3.connect(home/'state.sqlite3')) as c:
  result=c.execute(sql,args).fetchall();c.commit();return result

@contextlib.contextmanager
def fixture_directory():
 directory=tempfile.TemporaryDirectory(prefix='Teams update café 雪 ');original=None
 try:yield directory.name
 except BaseException as error:original=error;raise
 finally:
  try:directory.cleanup()
  except Exception as error:
   if original is None:raise
   original.add_note('Fixture directory cleanup not confirmed: '+type(error).__name__)
   print('Fixture directory cleanup not confirmed: '+type(error).__name__,flush=True)

def failure_evidence(root,home,result,base,token,process,offers,offer_endpoints,secrets,failure):
 """Bounded fixture evidence before cleanup changes the journal; never full config."""
 def redact(value,limit=1600):
  text=str(value)
  for secret in sorted((str(s)for s in secrets if s),key=len,reverse=True):text=text.replace(secret,'[redacted]')
  text=re.sub(r'(#(?:setup=)?)[^"\s]+',r'\1[redacted]',text)
  text=re.sub(r'(?i)(Bearer\s+)[^"\s]+',r'\1[redacted]',text)
  return text[-limit:]
 def observed(url,credential,allowed):
  if not url or not credential:return {'observed':False,'reason':'No captured endpoint credential'}
  try:
   req=urllib.request.Request(url,headers={'Authorization':'Bearer '+credential})
   with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req,timeout=2)as reply:
    raw=reply.read(65537)
    if len(raw)>65536:raise ValueError('Diagnostic response exceeds bound')
    value=json.loads(raw)
    return {'observed':True,'http_status':reply.status,'fields':{key:redact(value[key])if isinstance(value[key],str)else value[key]for key in allowed if key in value and isinstance(value[key],(str,int,bool,type(None)))}}
  except Exception as error:return {'observed':False,'error_type':type(error).__name__,'error':redact(error),'process_exit':'not_established'}
 failure_message=redact(failure.args[0])if failure.args and isinstance(failure.args[0],str)else'Non-text exception detail omitted; see bounded journal snapshot'
 evidence={'at':time.time(),'error':{'type':type(failure).__name__,'message':failure_message},'journal':{},'known_processes':[],'worker_stderr':'Unavailable: product spawns apply worker with Stdio::null; no stderr capture was claimed','worker_pid':'Not exposed by dispatch; offer worker_active is a lock observation, not a process-exit receipt','model_or_tenant_calls':0}
 try:
  with(home/'native-update.json').open('rb')as stream:raw=stream.read(4*1024*1024+1)
  if len(raw)>4*1024*1024:raise ValueError('Journal exceeds bound')
  journal=json.loads(raw)
  evidence['journal']={key:redact(journal[key])for key in ['schema','request_id','installation_id','phase','error']if key in journal and isinstance(journal[key],(str,int,bool,type(None)))}
  for key in ['candidate','previous']:
   if isinstance(journal.get(key),dict)and isinstance(journal[key].get('version'),str):evidence['journal'][key+'_version']=redact(journal[key]['version'])
 except Exception as error:evidence['journal']={'read_error_type':type(error).__name__,'read_error':redact(error)}
 for role,child in [('initial_launcher',process)]+[(f'offer_{i}',child)for i,child in enumerate(offers)]:
  evidence['known_processes'].append({'role':role,'pid':child.pid,'exit_code':child.poll(),'descendant_exit':'not_established'})
 evidence['health']=observed(base+'/api/v1/status'if base else None,token,['id','version','pid','launcher_pid','enabled','active'])
 evidence['offers']=[observed(url+'/status',cap,['phase','error','worker_active'])for url,cap in offer_endpoints]
 try:
  with(root/'server.log').open('rb')as stream:stream.seek(0,2);stream.seek(max(0,stream.tell()-8192));tail=stream.read(8192)
  evidence['captured_server_offer_stderr_tail']=redact(tail.decode('utf8',errors='replace'),4000)
 except OSError as error:evidence['captured_server_offer_stderr_tail']='Unavailable: '+type(error).__name__
 target=result.with_name(result.stem+'-failure.json');target.parent.mkdir(parents=True,exist_ok=True);target.write_text(json.dumps(evidence,indent=2)+'\n',encoding='utf8')
 print('Native update failure evidence: '+json.dumps(evidence),flush=True)
 return evidence

def run(package,result,browser=False):
 checks=[];offers=[];offer_endpoints=[];secrets=[]
 with fixture_directory()as tmp:
  root=Path(tmp);bundle=root/'download';bundle.mkdir();launch.extract(package,bundle)
  name='acp-teams-adapter.exe' if os.name=='nt' else 'acp-teams-adapter';binary=next(p for p in bundle.rglob(name)if p.is_file());home=root/'saved-connection';log=open(root/'server.log','ab')
  env={k:v for k,v in os.environ.items()if not k.upper().startswith(('TEAMS_','OPENAI_','ANTHROPIC_','AZURE_','GOOGLE_','AMPLIFIER_','NODE_','ACP_'))};env['PATH']=str(root/'no-tools')
  process=subprocess.Popen([str(binary),'--home',str(home),'--no-browser'],stdin=subprocess.DEVNULL,stdout=log,stderr=log,env=env)
  base=None;token=None
  def api(path,body=None):return launch.request(base,'/api/v1/'+path,body,{'Authorization':'Bearer '+token})[2]
  try:
   process,log,base=launch.wait_started(process,log,root,home,bundle);token=(home/'secrets/control-token').read_text().strip();cap=read(home/'secrets/first-account.json')['token']
   secrets.extend([token,cap,'Disposable Teams update account'])
   assert launch.request(base,'/auth/first-account',{'setup_token':cap,'password':'Disposable Teams update account','start_at_signin':False},{'Origin':base})[0]==200
   protected={name:digest(home/name)for name in ['adapter.json','native.json','secrets/control-token','secrets/local-password.json']}
   db(home,"INSERT INTO jobs(id,key,message,status,time,session_id,note) VALUES('uncertain','source','{}','uncertain',1,'original-session','unknown effect retained')")
   db(home,"INSERT INTO events(time,kind,detail) VALUES(1,'native-fixture','1')")
   for fails in [False,True]:
    candidate=root/('failed-candidate' if fails else 'candidate');shutil.copytree(bundle,candidate)
    executable=next(p for p in candidate.rglob(name)if p.is_file());resources=executable.parent.parent/'Resources' if os.name!='nt' and executable.parent.name=='MacOS' else executable.parent
    script=resources/'app/dist/native_update.js';script.write_bytes(script.read_bytes()+(b'\nthrow new Error("disposable candidate start failure");\n'if fails else b'\n// disposable replacement payload\n'))
    manifest=read(resources/'native-bundle.json');manifest['files']['app/dist/native_update.js']=digest(script);(resources/'native-bundle.json').write_text(json.dumps(manifest),encoding='utf8')
    previous_id=read(home/'native-update.json')['request_id'] if(home/'native-update.json').exists()else None
    offer=subprocess.Popen([str(executable),'--home',str(home),'--no-browser'],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=log,text=True,encoding='utf8',env=env);offers.append(offer)
    lines=queue.Queue();threading.Thread(target=lambda:lines.put(offer.stdout.readline()),daemon=True).start()
    line=lines.get(timeout=240);assert line,read(home/'native-update.json')if(home/'native-update.json').exists()else 'No prepared update'
    invitation=json.loads(line);address,capability=invitation['url'].split('#');address=address.rstrip('/');headers={'Authorization':'Bearer '+capability,'Origin':address}
    offer_endpoints.append((address,capability));secrets.append(capability)
    progress=[time.monotonic()-30]
    def preparation():
     code,_,observed=launch.request(address,'/status',headers=headers)
     assert code==200,observed
     assert not observed.get('error'),{'preparation_error':observed['error']}
     if time.monotonic()-progress[0]>=30:
      progress[0]=time.monotonic()
      print(json.dumps({'preparation_phase':observed['phase'],'staged_regular_files':sum(p.is_file()for p in(home/'native-updates').rglob('*'))}),flush=True)
     j=read(home/'native-update.json')
     return j if j['request_id']!=previous_id and j['phase']=='prepared' else None
    prepared=wait(preparation,240);assert api('status')['enabled']is False
    if not fails:
     before=api('status')['launcher_pid'];db(home,"INSERT INTO jobs(id,key,message,status,time) VALUES('pending-fixture','queued','{}','pending',1)")
     code,_,_=launch.request(address,'/apply',{},headers);assert code==200
     wait(lambda:read(home/'native-update.json')['phase']=='deferred',30)
     assert api('status')['launcher_pid']==before,'Busy work must defer before stopping the app'
     db(home,"DELETE FROM jobs WHERE id='pending-fixture'")
     checks.append('pending work defers without changing the running process; explicit same-request retry follows settlement')
    # New evidence after staging must survive both replacement and failed-health rollback.
    db(home,"UPDATE events SET detail=? WHERE kind='native-fixture'",('3'if fails else '2',))
    if browser and not fails:
     fixture=root/'update-browser.json';fixture.write_text(json.dumps({'url':invitation['url']}),encoding='utf8');subprocess.run([shutil.which('node'),str(ROOT/'tests/native-update-browser.mjs'),str(fixture)],check=True,timeout=270)
    else:
     code,_,reply=launch.request(address,'/apply',{},headers);assert code==200 and reply['request_id']==prepared['request_id']
    terminal=wait(lambda:(j if(j:=read(home/'native-update.json'))['phase']in('applied','rolled_back','recovery_required')else None),240)
    assert terminal['phase']==('rolled_back'if fails else'applied'),terminal
    wait(lambda:api('status')['id']==read(home/'native.json')['id'],30)
    assert all(digest(home/name)==sha for name,sha in protected.items())
    assert db(home,"SELECT status,session_id,note FROM jobs WHERE id='uncertain'")==[('uncertain','original-session','unknown effect retained')]
    assert db(home,"SELECT detail FROM events WHERE kind='native-fixture'")==[('3'if fails else'2',)]
    checks.append('actual failed candidate start restores app and Node, preserving newer database evidence'if fails else'actual private owner confirmation performs idle app/Node/launcher swap and same-identity restart')
    offer.terminate();offer.wait(timeout=20)
   checks.append('configuration, account, unknown effect record and original session binding preserved')
   checks.append('no tenant authorization, ACP prompt, model call or startup registration')
  except BaseException as failure:
   try:failure_evidence(root,home,result,base,token,process,offers,offer_endpoints,secrets,failure)
   except Exception as evidence_error:failure.add_note('Failure evidence unavailable: '+type(evidence_error).__name__)
   raise
  finally:
   original_failure=sys.exc_info()[1];cleanup_errors=[]
   if base and token and(home/'native-update.json').exists():
    try:
     record=read(home/'native-update.json');record['phase']='rolling_back';(home/'native-update.json').write_text(json.dumps(record),encoding='utf8')
     status=api('status');handle=None
     if os.name=='nt':
      import ctypes
      from ctypes import wintypes
      kernel=ctypes.WinDLL('kernel32',use_last_error=True);kernel.OpenProcess.argtypes=[wintypes.DWORD,wintypes.BOOL,wintypes.DWORD];kernel.OpenProcess.restype=wintypes.HANDLE;kernel.WaitForSingleObject.argtypes=[wintypes.HANDLE,wintypes.DWORD];kernel.CloseHandle.argtypes=[wintypes.HANDLE];handle=kernel.OpenProcess(0x100000,False,status['launcher_pid'])
     try:
      api('native-update/stop',{'request_id':record['request_id']})
      if handle:assert kernel.WaitForSingleObject(handle,20000)==0,'Known connector process has not exited'
     finally:
      if handle:kernel.CloseHandle(handle)
    except Exception as error:cleanup_errors.append('Fixture stop not confirmed: '+type(error).__name__)
   for index,offer in enumerate(offers):
    try:
     if offer.poll()is None:offer.terminate()
     offer.wait(timeout=20)
    except Exception as error:cleanup_errors.append(f'Offer{index} exit not confirmed: '+type(error).__name__)
   try:
    if process.poll()is None:process.terminate()
    process.wait(timeout=20)
   except Exception as error:cleanup_errors.append('Initial launcher exit not confirmed: '+type(error).__name__)
   finally:log.close()
   if cleanup_errors:
    print('Fixture cleanup: '+json.dumps(cleanup_errors),flush=True)
    if original_failure is not None:original_failure.add_note('; '.join(cleanup_errors))
    else:raise AssertionError('; '.join(cleanup_errors))
 receipt={'passed':True,'checks':checks,'package_sha256':digest(package),'limits':['Exact local package fixture, not a published release or signed/notarized app','Candidate payload modified only in the disposable fixture to exercise actual failed startup','Teams remains paused/unconfigured; no platform/model availability claim']};result.write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt,indent=2))
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--package',type=Path,required=True);p.add_argument('--result',type=Path,required=True);p.add_argument('--browser',action='store_true');a=p.parse_args();run(a.package.resolve(),a.result,a.browser)
