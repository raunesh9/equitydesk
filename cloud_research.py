"""GitHub runner orchestration and Gmail delivery. Never accesses portfolio data."""
import argparse
import datetime as dt
import email
from email.message import EmailMessage
from email.policy import default
from email.utils import format_datetime, getaddresses
import hashlib
import imaplib
import json
import os
from pathlib import Path
import re
import smtplib
import ssl
import sys
import time
import urllib.request

from research_agent import DIRECTORY, LOCAL, render, stamp, write_json

MODEL_DIGEST = '359d7dd4bcdab3d86b87d73ac27966f4dbb9f5efdfcc75d34a8764a09474fae7'


def today():
    return dt.datetime.now(LOCAL).date().isoformat()


def account():
    address = os.environ.get('EQUITYDESK_EMAIL', '').strip().lower()
    if not re.fullmatch(r'[a-z0-9.+_-]+@gmail\.com', address):
        raise ValueError('Set the EQUITYDESK_EMAIL repository variable to your Gmail address.')
    return address


def password():
    value = ''.join(os.environ.get('GMAIL_APP_PASSWORD', '').split())
    if not value:
        raise ValueError('Add the GMAIL_APP_PASSWORD GitHub Actions secret. Do not put it in code.')
    return value


def identity(address, date):
    key = date + '-' + hashlib.sha256(address.encode()).hexdigest()[:16]
    return {'date': date, 'key': key, 'subject': 'EquityDesk daily watchlist · ' + date,
            'headerMessageId': '<equitydesk-' + key + '@gmail.com>',
            'claimArtifact': 'equitydesk-claim-' + key}


def github_json(path):
    token = os.environ.get('GH_TOKEN')
    repo = os.environ.get('GITHUB_REPOSITORY', '')
    if not token or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo):
        raise ValueError('A GitHub runner token and repository are required for delivery claims.')
    request = urllib.request.Request('https://api.github.com/repos/' + repo + path,
        headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
                 'X-GitHub-Api-Version': '2022-11-28'})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def has_claim(item):
    # A durable artifact is uploaded BEFORE SMTP. A lost/ambiguous send is never retried.
    for page in range(1, 101):
        result = github_json('/actions/artifacts?per_page=100&page=' + str(page))
        artifacts = result['artifacts']
        if any(a['name'] == item['claimArtifact'] and not a.get('expired') for a in artifacts):
            return True
        if len(artifacts) < 100:
            return False
    raise RuntimeError('Could not inspect the full delivery ledger; refusing to send.')


def find_sent(address, item):
    """Read only headers of reports matching recipient, title, and report date."""
    with imaplib.IMAP4_SSL('imap.gmail.com', 993, ssl_context=ssl.create_default_context(), timeout=30) as mail:
        mail.login(address, password())
        status, folders = mail.list()
        if status != 'OK':
            raise RuntimeError('Gmail Sent folders could not be listed.')
        sent = None
        for folder in folders:
            if not isinstance(folder, bytes):
                continue
            match = re.match(rb'\([^)]*\\Sent[^)]*\) "[^"]*" (.+)$', folder, re.I)
            if match:
                sent = match.group(1).decode('ascii')
                break
        if not sent:
            raise RuntimeError('The Gmail Sent folder is unavailable through IMAP.')
        status, _ = mail.select(sent, readonly=True)
        if status != 'OK':
            raise RuntimeError('Gmail Sent could not be opened.')
        day = dt.date.fromisoformat(item['date'])
        status, data = mail.uid('search', None,
            'SINCE', (day - dt.timedelta(days=1)).strftime('%d-%b-%Y'),
            'BEFORE', (day + dt.timedelta(days=2)).strftime('%d-%b-%Y'),
            'TO', '"' + address + '"', 'SUBJECT', '"EquityDesk daily watchlist"',
            'SUBJECT', '"' + item['date'] + '"')
        if status != 'OK':
            raise RuntimeError('Gmail Sent search failed; refusing to risk a duplicate.')
        for uid in (data[0] or b'').split():
            status, response = mail.uid('fetch', uid, '(X-GM-MSGID BODY.PEEK[HEADER.FIELDS (TO SUBJECT DATE MESSAGE-ID)])')
            if status != 'OK':
                raise RuntimeError('Could not verify a matching Gmail report.')
            for part in response:
                if not isinstance(part, tuple):
                    continue
                headers = email.message_from_bytes(part[1], policy=default)
                recipients = [v.lower() for _, v in getaddresses(headers.get_all('To', []))]
                if str(headers.get('Subject')) != item['subject'] or address not in recipients:
                    continue
                date = email.utils.parsedate_to_datetime(str(headers['Date']))
                if date.astimezone(LOCAL).date().isoformat() != item['date']:
                    continue
                message_id = re.search(rb'X-GM-MSGID (\d+)', part[0])
                if not message_id:
                    raise RuntimeError('Gmail matched the report but did not supply a message ID. Do not resend.')
                return format(int(message_id.group(1)), 'x')
    return None


def output(values):
    target = os.environ.get('GITHUB_OUTPUT')
    if target:
        with open(target, 'a') as file:
            for key, value in values.items():
                file.write(f'{key}={value}\n')


def receipt(item, message_id):
    result = {'status': 'sent', 'date': item['date'], 'messageId': message_id, 'confirmedAt': stamp()}
    write_json(DIRECTORY / 'cloud-receipt.json', result)
    print(json.dumps(result))


def preflight(dry_run=False):
    item = identity(account(), today())
    output({'date': item['date'], 'claim': item['claimArtifact'], 'skip': 'false'})
    if dry_run:
        print('Cloud validation run: collect and review, without sending email.')
        return
    password()
    # Search first: also prevents duplicate delivery after migration from the Mac.
    message_id = find_sent(account(), item)
    if message_id:
        receipt(item, message_id)
        output({'skip': 'true'})
        print('Today’s report is already in Gmail Sent. No new email will be sent.')
        return
    if has_claim(item):
        raise RuntimeError('Today’s delivery was already claimed. Inspect Gmail Sent before any manual recovery; no automatic resend.')
    print('Gmail authenticated and no prior report or claim was found.')


def prepare_model():
    from local_research_ai import MODEL, ensure_running, request
    ensure_running()
    request('/api/pull', {'model': MODEL, 'stream': False}, timeout=1800)
    models = request('/api/tags').get('models', [])
    if not any(m.get('name') == MODEL and m.get('digest') == MODEL_DIGEST for m in models):
        raise RuntimeError('The downloaded Qwen model does not match the reviewed model digest.')
    print('Qwen3 4B is ready and its model digest matches.')


def validated_report(report, date):
    if report.get('reportId') != date or report.get('scope') != 'full':
        raise ValueError('A current, full research scan is required.')
    coverage = report.get('coverage', {})
    requested, usable = coverage.get('requested', 0), coverage.get('usablePrices', 0)
    if not requested or usable / requested < .8:
        raise ValueError('Less than 80% price coverage. The quantitative report is saved, but email is blocked.')
    ai = report.get('localAI', {})
    if ai.get('status') != 'complete' or ai.get('runtime') != 'github-actions':
        raise ValueError('The cloud AI review did not complete. Inspect the saved quantitative report.')
    return render(report)


def prepare():
    item = identity(account(), today())
    report = json.loads((DIRECTORY / 'latest.json').read_text())
    page = validated_report(report, item['date'])
    item.update(status='claimed', claimedAt=stamp(), reportHash=hashlib.sha256(page.encode()).hexdigest())
    # No email address or credential is placed in the public artifact.
    write_json(DIRECTORY / 'cloud-claim.json', item)
    print('Full cloud report validated. Ready for the durable delivery claim.')


def delivery_delay(now, event):
    if event != 'schedule':
        return 0
    local = now.astimezone(LOCAL)
    target = local.replace(hour=9, minute=0, second=0, microsecond=0)
    return max(0, (target - local).total_seconds())


def wait_for_delivery():
    while True:
        seconds = delivery_delay(dt.datetime.now(LOCAL), os.environ.get('GITHUB_EVENT_NAME'))
        if not seconds:
            return
        time.sleep(min(60, seconds))


def send():
    address = account()
    item = identity(address, today())
    claim = json.loads((DIRECTORY / 'cloud-claim.json').read_text())
    if claim.get('key') != item['key'] or claim.get('status') != 'claimed':
        raise ValueError('The prepared delivery claim is missing or out of date.')
    report = json.loads((DIRECTORY / 'latest.json').read_text())
    page = validated_report(report, item['date'])
    if hashlib.sha256(page.encode()).hexdigest() != claim.get('reportHash'):
        raise ValueError('The report changed after the claim was prepared.')
    if not has_claim(item):
        raise RuntimeError('The durable GitHub claim is missing. No email was sent.')
    existing = find_sent(address, item)
    if existing:
        receipt(item, existing)
        return
    message = EmailMessage()
    message['To'] = address
    message['From'] = address
    message['Subject'] = item['subject']
    message['Message-ID'] = item['headerMessageId']
    message['Date'] = format_datetime(dt.datetime.now(LOCAL))
    message.set_content(page, subtype='html', charset='utf-8')
    # Deliberately no retry loop around SMTP, even on a timeout or disconnect.
    with smtplib.SMTP_SSL('smtp.gmail.com', 465, context=ssl.create_default_context(), timeout=45) as smtp:
        smtp.login(address, password())
        refused = smtp.send_message(message)
        if refused:
            raise RuntimeError('Gmail refused a recipient; inspect delivery before retrying.')
    for attempt in range(6):
        actual_id = find_sent(address, item)
        if actual_id:
            receipt(item, actual_id)
            return
        time.sleep(5)
    raise RuntimeError('SMTP accepted the email, but Gmail Sent has not confirmed it. The claim remains; do not resend automatically.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['preflight', 'prepare-model', 'prepare', 'wait', 'send'])
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    DIRECTORY.mkdir(parents=True, exist_ok=True)
    try:
        if args.action == 'preflight':
            preflight(args.dry_run)
        elif args.action == 'prepare-model':
            prepare_model()
        elif args.action == 'prepare':
            prepare()
        elif args.action == 'wait':
            wait_for_delivery()
        else:
            send()
    except (ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        return 1
    except Exception as error:
        # Provider exceptions can contain credentials/addresses. Do not print them.
        print(type(error).__name__ + ': cloud research failed. Check connectivity or Gmail authentication. '
              'If a claim exists, inspect Sent before retrying.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
