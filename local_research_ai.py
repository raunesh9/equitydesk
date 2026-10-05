"""Loopback-only Ollama reviewer. Models select verified evidence, never write figures."""
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent
MODEL = 'qwen3:4b'
ADDRESS = 'http://127.0.0.1:11435'


def environment():
    return dict(os.environ, OLLAMA_HOST='127.0.0.1:11435', OLLAMA_MODELS=str(ROOT / 'data/research/models'),
                OLLAMA_NO_CLOUD='1', OLLAMA_NUM_PARALLEL='1')


def request(path, payload=None, timeout=5):
    req = urllib.request.Request(ADDRESS + path, data=json.dumps(payload).encode() if payload is not None else None,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.load(response)


def ensure_running():
    try:
        request('/api/tags')
        return
    except (OSError, ValueError):
        pass
    binary = Path(os.environ.get('EQUITYDESK_OLLAMA_BINARY', ROOT / 'tools/ollama/ollama'))
    if not binary.is_file():
        raise RuntimeError('The local Ollama runtime is not installed.')
    directory = ROOT / 'data/research'
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / 'ollama.log').open('a') as log:
        process = subprocess.Popen([str(binary), 'serve'], env=environment(), cwd=str(ROOT),
                                   stdout=log, stderr=log, start_new_session=True)
    for _ in range(60):
        try:
            request('/api/tags')
            return
        except (OSError, ValueError):
            if process.poll() is not None:
                raise RuntimeError('Ollama could not start. Check data/research/ollama.log.')
            time.sleep(.25)
    raise RuntimeError('The local AI runtime did not become ready.')


def validate_selection(selection, candidates, market):
    by_symbol = {r['symbol']: r for r in candidates}
    market_symbols = {r['symbol'] for r in market}
    accepted, sectors, seen = [], {}, set()
    if not isinstance(selection, dict) or not isinstance(selection.get('stocks'), list) or not isinstance(selection.get('market'), list):
        raise ValueError('Malformed local AI response')
    for item in selection['stocks']:
        if not isinstance(item, dict) or item.get('symbol') not in by_symbol:
            raise ValueError('AI selected an unknown or ineligible stock')
        row = by_symbol[item['symbol']]
        for key, facts in [('evidence', row['reasons']), ('risks', row['risks'])]:
            indices = item.get(key)
            if not isinstance(indices, list) or len(indices) > 3 or any(type(i) is not int or not 0 <= i < len(facts) for i in indices):
                raise ValueError('AI selected unsupported evidence')
        if not item['evidence']:
            raise ValueError('AI selected a stock without evidence')
        sector = row.get('sector') or 'Unknown'
        if row['symbol'] in seen or sectors.get(sector, 0) >= 2:
            continue
        seen.add(row['symbol']); sectors[sector] = sectors.get(sector, 0) + 1
        accepted.append(item)
        if len(accepted) == 5: break
    focus = selection['market']
    if any(not isinstance(s, str) or s not in market_symbols for s in focus):
        raise ValueError('AI selected an unknown market proxy')
    if candidates and not accepted:
        raise ValueError('AI returned no supported selections')
    return {'stocks': accepted, 'market': list(dict.fromkeys(focus))[:4]}


def review(report):
    candidates = sorted([r for r in report['rows'] if r['kind'] == 'stock' and r['eligible'] and r['score'] >= 5],
                        key=lambda r: (-r['score'], r['symbol']))[:16]
    market = [r for r in report['rows'] if r['kind'] != 'stock' and r['eligible']]
    if not candidates and not market:
        raise ValueError('No usable market evidence for AI review')
    evidence = {
        'stocks': [{k:r[k] for k in ['symbol','sector','industry','score','fundamentals','reasons','risks']} | {'trend': r['prices']} for r in candidates],
        'market': [{'symbol':r['symbol'], 'group':r['group'], 'oneMonth':r['prices'].get('return1m'), 'threeMonths':r['prices'].get('return3m'), 'relativeToSPY':r['relative3m']} for r in market],
    }
    schema = {'type':'object', 'additionalProperties':False, 'required':['stocks','market'], 'properties':{
        'stocks': {'type':'array','maxItems':5,'items':{'type':'object','additionalProperties':False,'required':['symbol','evidence','risks'],'properties':{
            'symbol':{'type':'string','enum':[r['symbol'] for r in candidates] or ['NONE']},
            'evidence':{'type':'array','minItems':1,'maxItems':3,'items':{'type':'integer','minimum':0}},
            'risks':{'type':'array','maxItems':3,'items':{'type':'integer','minimum':0}}
        }}}, 'market':{'type':'array','maxItems':4,'items':{'type':'string','enum':[r['symbol'] for r in market] or ['NONE']}}}}
    ensure_running()
    answer = request('/api/generate', {
        'model':MODEL,'stream':False,'think':False,'keep_alive':0,'format':schema,
        'options':{'temperature':0,'num_ctx':12288,'num_predict':900},
        'system':'You are a cautious equity research reviewer. Use only supplied evidence. Choose up to five stocks worth further investigation, balancing momentum, valuation, growth, debt, missing metrics and sector diversity. Select at most two stocks per sector. Do not treat low P/E as automatically attractive or compare P/E across different industries. Return each selected symbol with zero-based indices into its supplied reasons array (evidence) and risks array (risks). Choose up to four noteworthy broad/sector/industry ETFs in market, including weaknesses when informative. Do not invent facts, numbers, symbols, news, predictions, or orders. Output the requested JSON only.',
        'prompt':json.dumps(evidence, separators=(',',':'), allow_nan=False)
    }, timeout=1800 if os.environ.get('GITHUB_ACTIONS') == 'true' else 600)
    if answer.get('done_reason') == 'length' or not answer.get('done'):
        raise ValueError('Local AI response was incomplete')
    selection = validate_selection(json.loads(answer['response']), candidates, market)
    report['quantitativeWatchlist'] = report['watchlist']
    report['watchlist'] = [item['symbol'] for item in selection['stocks']]
    runtime = 'github-actions' if os.environ.get('GITHUB_ACTIONS') == 'true' else 'mac'
    report['localAI'] = {'status':'complete','model':MODEL,'selection':selection,'runtime':runtime,
                         'note':'The model chose research priorities and evidence. All displayed financial facts are calculated or fetched, not model-generated.'}
    return report
