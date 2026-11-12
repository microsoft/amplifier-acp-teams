#!/usr/bin/env python3
"""Real downloaded-package cutover in a disposable paused Teams installation."""
import argparse,contextlib,hashlib,importlib.util,json,os,queue,shutil,sqlite3,subprocess,tempfile,threading,time
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

def run(package,result,browser=False):
 checks=[];offers=[]
 with tempfile.TemporaryDirectory(prefix='Teams update café 雪 ')as tmp:
  root=Path(tmp);bundle=root/'download';bundle.mkdir();launch.extract(package,bundle)
  name='acp-teams-adapter.exe' if os.name=='nt' else 'acp-teams-adapter';binary=next(p for p in bundle.rglob(name)if p.is_file());home=root/'saved-connection';log=open(root/'process.log','ab')
  process=subprocess.Popen([str(binary),'--home',str(home),'--no-browser'],stdin=subprocess.DEVNULL,stdout=log,stderr=log)
  base=None;token=None
  def current():
   settings=read(home/'native.json');origin=settings['origin'];code,_,session=launch.request(origin,'/auth/session');return origin if code==200 else None
  def api(path,body=None):return launch.request(base,'/api/v1/'+path,body,{'Authorization':'Bearer '+token})[2]
  try:
   base=wait(current);token=(home/'secrets/control-token').read_text().strip();cap=read(home/'secrets/first-account.json')['token']
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
    offer=subprocess.Popen([str(executable),'--home',str(home),'--no-browser'],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=log,text=True,encoding='utf8');offers.append(offer)
    lines=queue.Queue();threading.Thread(target=lambda:lines.put(offer.stdout.readline()),daemon=True).start()
    line=lines.get(timeout=240);assert line,read(home/'native-update.json')if(home/'native-update.json').exists()else 'No prepared update'
    invitation=json.loads(line);address,capability=invitation['url'].split('#');address=address.rstrip('/');headers={'Authorization':'Bearer '+capability,'Origin':address}
    prepared=wait(lambda:(j if(j:=read(home/'native-update.json'))['request_id']!=previous_id and j['phase']=='prepared' else None),240);assert api('status')['enabled']is False
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
  finally:
   if base and token and(home/'native-update.json').exists():
    try:
     record=read(home/'native-update.json');record['phase']='rolling_back';(home/'native-update.json').write_text(json.dumps(record),encoding='utf8')
     status=api('status');handle=None
     if os.name=='nt':
      import ctypes
      from ctypes import wintypes
      kernel=ctypes.WinDLL('kernel32',use_last_error=True);kernel.OpenProcess.argtypes=[wintypes.DWORD,wintypes.BOOL,wintypes.DWORD];kernel.OpenProcess.restype=wintypes.HANDLE;kernel.WaitForSingleObject.argtypes=[wintypes.HANDLE,wintypes.DWORD];kernel.CloseHandle.argtypes=[wintypes.HANDLE];handle=kernel.OpenProcess(0x100000,False,status['launcher_pid'])
     api('native-update/stop',{'request_id':record['request_id']})
     if handle:assert kernel.WaitForSingleObject(handle,20000)==0;kernel.CloseHandle(handle)
    except Exception as error:print('Fixture stop:',type(error).__name__,str(error))
   for offer in offers:
    if offer.poll()is None:offer.terminate();offer.wait(timeout=20)
   if process.poll()is None:process.terminate()
   process.wait(timeout=20);log.close()
 receipt={'passed':True,'checks':checks,'package_sha256':digest(package),'limits':['Exact local package fixture, not a published release or signed/notarized app','Candidate payload modified only in the disposable fixture to exercise actual failed startup','Teams remains paused/unconfigured; no platform/model availability claim']};result.write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt,indent=2))
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--package',type=Path,required=True);p.add_argument('--result',type=Path,required=True);p.add_argument('--browser',action='store_true');a=p.parse_args();run(a.package.resolve(),a.result,a.browser)
