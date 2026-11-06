import json,sys
send=lambda v:print(json.dumps({'jsonrpc':'2.0',**v}),flush=True)
def ask(id,params):
 send({'id':id,'method':'elicitation/create','params':params});return json.loads(sys.stdin.readline())
authed=False
for line in sys.stdin:
 r=json.loads(line);i=r.get('id');m=r.get('method');p=r.get('params',{})
 if m=='initialize':
  assert p['clientCapabilities']['elicitation']=={'form':{},'url':{}}
  result={'protocolVersion':1,'authMethods':[{'id':'browser','name':'Browser login'}]}
 elif m=='session/new' and not authed:
  send({'id':i,'error':{'code':-32000,'message':'Authentication required'}});continue
 elif m=='authenticate':
  assert ask('url',{'requestId':i,'mode':'url','message':'Login','url':'https://example.test/login','elicitationId':'external'})['result']=={'action':'accept'};authed=True;result={}
 elif m=='session/new':result={'sessionId':'s'}
 elif m=='session/prompt':
  schema={'type':'object','properties':{'count':{'type':'integer','minimum':1,'maximum':3}},'required':['count']}
  assert 'error' in ask('wrong',{'sessionId':'elsewhere','mode':'form','message':'Wrong room','requestedSchema':schema})
  assert ask('q',{'sessionId':'s','mode':'form','message':'Count','requestedSchema':schema})['result']=={'action':'accept','content':{'count':2}}
  send({'method':'session/update','params':{'sessionId':'s','update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':'Owner answered'}}}});result={'stopReason':'end_turn'}
 else:result={}
 send({'id':i,'result':result})
