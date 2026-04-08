import json
with open(r'd:\het-desktop\shalin_bhaiya_funnel\src\contracts_nsefo.json', 'r') as f:
    data = json.load(f)
    match = [c for c in data if c['t'] == '47585']
    print(json.dumps(match, indent=2))
