"""Daily email claim ledger; the connected Gmail tool performs the actual send."""
import argparse
import datetime as dt
import fcntl
import hashlib
import json
from pathlib import Path
from zoneinfo import ZoneInfo
from research_agent import DIRECTORY, write_json, stamp, render


def delivery(action, message_id=None):
    configuration = json.loads((DIRECTORY / 'delivery-config.json').read_text())
    recipient = configuration['recipient']
    today = dt.datetime.now(ZoneInfo(configuration['timezone'])).strftime('%Y-%m-%d')
    key = today + '|' + recipient.lower()
    path = DIRECTORY / 'deliveries.json'
    with (DIRECTORY / '.delivery-lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        ledger = json.loads(path.read_text()) if path.exists() else {}
        existing = ledger.get(key)
        if action == 'status':
            return existing or {'status':'not_sent','date':today,'recipient':recipient}
        if action == 'sent':
            if not existing or existing['status'] != 'claimed' or not message_id:
                raise ValueError('A claim and a confirmed Gmail message ID are required.')
            existing.update(status='sent', sentAt=stamp(), messageId=message_id)
            write_json(path, ledger)
            return existing
        if existing:
            return {'status':'blocked','reason':'Already sent or claimed. Inspect Gmail before any retry.', 'delivery':existing}
        report = json.loads((DIRECTORY / 'latest.json').read_text())
        if report['reportId'] != today:
            raise ValueError('Generate today’s report before delivery.')
        if report.get('scope') != 'full' or not report['coverage'].get('usablePrices'):
            raise ValueError('A full scan with usable market data is required before delivery.')
        if report.get('localAI', {}).get('status') != 'complete':
            raise ValueError('Finish the local AI review before sending the daily report.')
        page = render(report)
        entry = {'status':'claimed','date':today,'recipient':recipient,'claimedAt':stamp(),
                 'reportHash':hashlib.sha256(page.encode()).hexdigest(),
                 'subject':'EquityDesk daily watchlist · ' + today}
        ledger[key] = entry
        write_json(path, ledger)
        return entry | {'html':page}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['status','claim','sent'])
    parser.add_argument('--message-id')
    args = parser.parse_args()
    print(json.dumps(delivery(args.action, args.message_id), ensure_ascii=False))


if __name__ == '__main__':
    main()
