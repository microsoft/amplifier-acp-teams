import json
import sys
import time
import uuid
from pathlib import Path

session = ''
for line in sys.stdin:
    request = json.loads(line)
    method = request.get('method')
    if not method:
        continue
    params = request.get('params', {})
    mode = Path(sys.argv[1]).read_text().strip()
    with Path(sys.argv[2]).open('a') as stream:
        stream.write(json.dumps({'method': method, 'params': params}) + '\n')
    if method == 'initialize':
        result = {'protocolVersion': 1, 'agentCapabilities': {'loadSession': mode != 'unsupported'}}
    elif method == 'session/load':
        if mode == 'timeout':
            time.sleep(300)
        if mode == 'disconnect':
            sys.exit(0)
        if mode in ('reject', 'method-missing'):
            print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'error': {
                'code': -32601 if mode == 'method-missing' else -32603,
                'message': 'PRIVATE ENDPOINT DETAIL'}}), flush=True)
            continue
        session = params['sessionId']
        result = {}
    elif method == 'session/new':
        session = str(uuid.uuid4())
        result = {'sessionId': session}
    elif method == 'session/prompt':
        if mode == 'prompt-wait':
            time.sleep(300)
        if mode == 'prompt-disconnect':
            sys.exit(0)
        print(json.dumps({'jsonrpc': '2.0', 'method': 'session/update', 'params': {
            'sessionId': session, 'update': {'sessionUpdate': 'agent_message_chunk',
                'content': {'type': 'text', 'text': 'Fixture reply in ' + session}}}}), flush=True)
        result = {'stopReason': 'end_turn'}
    else:
        result = {}
    print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}), flush=True)
