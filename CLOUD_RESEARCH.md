# EquityDesk daily cloud research

This workflow runs the Yahoo scan and Qwen3 4B review on GitHub's Ubuntu runner. Your Mac can be switched off. It prepares the report from 8:30 AM and waits until 9 AM to send it in America/Indiana/Indianapolis, including weekends, following daylight saving time. GitHub can queue scheduled runs, so inbox delivery is not guaranteed at exactly 9 AM. Scheduled workflows in public repositories can also be disabled after 60 days without repository activity.

## Finish the email connection

1. Sign into the Gmail account you want to use as both sender and recipient.
2. Enable Google 2-Step Verification if necessary, then create an **EquityDesk** [Google app password](https://myaccount.google.com/apppasswords).
3. Open the repository's **Settings → Secrets and variables → Actions → New repository secret**. Name it `GMAIL_APP_PASSWORD` and paste the app password directly into GitHub. Never paste it into chat, code, or a normal repository variable. An app password grants email access; revoke this specific password in Google when retiring the workflow. If Google does not offer app passwords, delivery needs a different authentication setup.
4. Set the repository variable `EQUITYDESK_EMAIL` to the Gmail address. The same address is used for sending and receiving.
5. Under **Actions → EquityDesk daily cloud research → Run workflow**, leave **dry_run** checked for a collection/model test. Uncheck it for a real delivery. A matching report already in Gmail Sent causes a safe skip.
6. After testing, set `EQUITYDESK_CLOUD_ENABLED` to `true` to enable daily runs and pause the old Codex local schedule. Until then, scheduled cloud runs skip execution.

## What it does

- Scans the curated universe in `resources/research-universe.json`: 48 companies and 27 market, sector, and industry ETFs. This is not an exhaustive exchange scan.
- Uses completed-session Yahoo prices and disclosed source/update times. Missing metrics stay unavailable. A full scan needs at least 80% usable price coverage, usable benchmark history, and a completed cloud AI review before delivery.
- Runs the same pinned Qwen model with Ollama on the cloud runner. The model selects supported evidence; displayed financial figures come from data and calculations, not generated prose. No paid model API is required.
- Does not read personal holdings, research notes, databases, or other local files. It does not place trades.
- Reads only the headers of matching daily reports in Gmail Sent. It saves a durable delivery claim before sending, sends once through Gmail over TLS, and records the actual Gmail message ID after checking Sent. A timeout or ambiguous send is never automatically retried.
- Saves HTML/JSON reports and confirmed receipts as GitHub workflow artifacts for seven days, and tiny delivery claims for 90 days. Artifacts on this public repository may be visible to people with repository access. They contain research on the curated public securities, never holdings or credentials. Email addresses are omitted from claims and receipts.

## Find reports and troubleshoot

Open **Actions → EquityDesk daily cloud research → a run**. Download its `equitydesk-report-…` artifact to view `latest.html` or inspect `latest.json`. A successful delivery also includes `cloud-receipt.json` with the actual Gmail message ID. A green dry run validates research only; it does not test email delivery.

If Yahoo blocks the cloud runner or the model fails, the job stops and saves any available quantitative report; it does not mail a partial scan as a completed AI report. GitHub workflow notifications show failures according to your GitHub notification settings.

For an ambiguous send, check Gmail Sent for the exact report subject, recipient, and date before doing anything else. Do not delete its `equitydesk-claim-…` artifact or rerun sending until delivery has been reconciled. Claims prevent duplicate emails even if a runner stops immediately after SMTP accepts a message.

Standard GitHub-hosted runner compute is free for public repositories. This workflow uses a standard runner, no persistent model cache, and short report retention. Check GitHub billing if you make the repository private or change storage/runner settings.

## Implementation and checks

The workflow is `.github/workflows/daily-research.yml`. `cloud_research.py` handles model preparation, preflight checks, validation, and Gmail delivery. Existing `research_agent.py` and `local_research_ai.py` handle collection and review. Local Mac research still works independently.

Run offline checks with `python -m unittest discover -s tests -p 'test*research*.py'`. A manual dry run on GitHub verifies the actual Linux runtime, Yahoo access, and model execution.

References: [GitHub schedules](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule), [GitHub runner billing](https://docs.github.com/en/actions/concepts/billing-and-usage), [Google app passwords](https://support.google.com/accounts/answer/185833), [Ollama Linux installation](https://docs.ollama.com/linux).
