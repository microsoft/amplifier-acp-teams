import sys,json,uuid,time
session=''
for line in sys.stdin:
 try: request=json.loads(line)
 except ValueError: continue
 if 'method' not in request: continue
 method=request['method'];params=request.get('params',{});result={}
 if method=='initialize': result={'protocolVersion':1,'agentInfo':{'name':'independent-fixture','version':'1'},'agentCapabilities':{'loadSession':True,'promptCapabilities':{'image':True,'audio':True,'embeddedContext':True}}}
 elif method in ['session/new','session/load']:
  session=params.get('sessionId',str(uuid.uuid4()));result={'sessionId':session}
 elif method=='session/prompt':
  text=params['prompt'][0]['text']
  try:text=json.loads(text.split('\n',1)[1])['trigger']['text']
  except (ValueError,KeyError,IndexError):pass
  if 'permission-fixture' in text:
   options=[{'optionId':'allow','name':'Allow this time','kind':'allow_once'},{'optionId':'deny','name':'Decline','kind':'reject_once'}]
   if 'duplicate-permission-fixture' in text:options[1]['optionId']='allow'
   if 'malformed-permission-fixture' in text:options={'allow':True}
   print(json.dumps({'jsonrpc':'2.0','id':'permission-1','method':'session/request_permission','params':{'sessionId':session,'toolCall':{'toolCallId':'t1','title':'Read fixture file','kind':'read'},'options':options}}),flush=True)
   response=json.loads(sys.stdin.readline());out='PERMISSION_'+response.get('result',{}).get('outcome',{}).get('outcome','ERROR')
  elif 'media-fixture' in text:
   out='MEDIA_IMAGE_RECEIVED' if any(v.get('type')=='image' for v in params['prompt']) else 'MEDIA_MISSING'
   print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':session,'update':{'sessionUpdate':'agent_message_chunk','content':{'type':'resource','resource':{'uri':'file:///result.txt','mimeType':'text/plain','text':'Done'}}}}}),flush=True)
  elif 'wait-fixture' in text:time.sleep(300);out='unexpected'
  elif 'ambient-fixture' in text:out='[[PASS]]'
  else:out='ACP_REPLY '+session
  print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':session,'update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':out}}}}),flush=True)
  result={'stopReason':'end_turn'}
 else: print(json.dumps({'jsonrpc':'2.0','id':request['id'],'error':{'code':-32601,'message':'Unsupported'}}),flush=True);continue
 print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':result}),flush=True)
