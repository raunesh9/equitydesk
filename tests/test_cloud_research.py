import datetime as dt
from email.message import EmailMessage
from email.utils import format_datetime
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import cloud_research as cloud
from test_research import report


class CloudResearchTests(unittest.TestCase):
    def valid(self):
        result = report()
        result.update(reportId=cloud.today(), scope='full')
        result['localAI'] = {'status':'complete', 'model':'qwen3:4b', 'runtime':'github-actions',
                             'selection':{'stocks':[], 'market':[]}}
        return result

    def test_cloud_report_labels_execution_truthfully(self):
        page = cloud.validated_report(self.valid(), cloud.today())
        self.assertIn('Cloud AI review', page)
        self.assertIn('on a GitHub cloud runner', page)
        self.assertNotIn('on your Mac', page)

    def test_scheduled_mail_waits_for_nine_in_both_dst_and_standard_time(self):
        for month in (1,7):
            early=dt.datetime(2026,month,4,8,30,tzinfo=cloud.LOCAL)
            self.assertEqual(cloud.delivery_delay(early.astimezone(dt.timezone.utc),'schedule'),1800)
            self.assertEqual(cloud.delivery_delay(early,'workflow_dispatch'),0)
            self.assertEqual(cloud.delivery_delay(early.replace(hour=10),'schedule'),0)

    def test_blocks_old_partial_low_coverage_or_incomplete_review(self):
        for changes in [{'reportId':'2000-01-01'}, {'scope':'subset'},
                        {'coverage':{'requested':75,'usablePrices':1}},
                        {'localAI':{'status':'unavailable'}},
                        {'localAI':{'status':'complete','runtime':'mac'}}]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                cloud.validated_report(self.valid() | changes, cloud.today())

    def test_artifact_identity_does_not_include_the_address(self):
        a = cloud.identity('example@gmail.com','2026-10-04')
        self.assertNotIn('example', json.dumps(a))
        self.assertNotEqual(a['key'], cloud.identity('another@gmail.com','2026-10-04')['key'])

    def test_missing_benchmark_blocks_even_with_otherwise_high_coverage(self):
        result=self.valid()
        result['rows']=[row for row in result['rows'] if row['symbol'] != 'SPY']
        with self.assertRaisesRegex(ValueError,'benchmark'):
            cloud.validated_report(result,cloud.today())
        result=self.valid();result['rows'][0]['priceWarning']='retrieval failed'
        with self.assertRaisesRegex(ValueError,'benchmark'):
            cloud.validated_report(result,cloud.today())

    def test_sent_search_checks_exact_recipient_subject_date_and_gmail_id(self):
        item=cloud.identity('example@gmail.com','2026-10-04')
        for recipient,subject,day,expected in [
            ('example@gmail.com',item['subject'],4,'1a1097f4a73a346a'),
            ('someoneelse@gmail.com',item['subject'],4,None),
            ('example@gmail.com',item['subject']+' copied',4,None),
            ('example@gmail.com',item['subject'],3,None)]:
            with self.subTest(recipient=recipient,subject=subject,day=day), \
                 patch.object(cloud,'password',return_value='secret'), \
                 patch.object(cloud.imaplib,'IMAP4_SSL') as connection:
                message=EmailMessage()
                message['To']=recipient;message['Subject']=subject
                message['Date']=format_datetime(dt.datetime(2026,10,day,9,tzinfo=cloud.LOCAL))
                client=connection.return_value.__enter__.return_value
                client.list.return_value=('OK',[b'(\\HasNoChildren \\Sent) "/" "[Gmail]/Sent Mail"'])
                client.select.return_value=('OK',[b'1'])
                client.uid.side_effect=[('OK',[b'7']),('OK',[(b'7 (X-GM-MSGID '+str(int('1a1097f4a73a346a',16)).encode()+b')',message.as_bytes())])]
                self.assertEqual(cloud.find_sent('example@gmail.com',item),expected)
                client.select.assert_called_once_with('"[Gmail]/Sent Mail"',readonly=True)

    def test_already_sent_is_a_noop_even_without_a_cloud_claim(self):
        with patch.object(cloud,'account',return_value='example@gmail.com'), \
             patch.object(cloud,'password',return_value='secret'), \
             patch.object(cloud,'verify_smtp') as authenticate, \
             patch.object(cloud,'find_sent',return_value='actual-gmail-id'), \
             patch.object(cloud,'receipt') as save, patch.object(cloud,'output') as output, \
             patch.object(cloud,'has_claim') as claimed:
            cloud.preflight()
            save.assert_called_once()
            authenticate.assert_called_once_with('example@gmail.com')
            claimed.assert_not_called()
            self.assertIn(unittest.mock.call({'skip':'true'}), output.call_args_list)

    def test_ambiguous_claim_blocks_before_scan_or_send(self):
        with patch.object(cloud,'account',return_value='example@gmail.com'), \
             patch.object(cloud,'password',return_value='secret'), \
             patch.object(cloud,'verify_smtp'), \
             patch.object(cloud,'find_sent',return_value=None), \
             patch.object(cloud,'has_claim',return_value=True), patch.object(cloud,'output'):
            with self.assertRaisesRegex(RuntimeError,'already claimed'):
                cloud.preflight()

    def test_email_connection_check_authenticates_without_sending(self):
        with patch.object(cloud,'password',return_value='secret'), patch.object(cloud.smtplib,'SMTP_SSL') as smtp:
            cloud.verify_smtp('example@gmail.com')
            sender=smtp.return_value.__enter__.return_value
            sender.login.assert_called_once_with('example@gmail.com','secret')
            sender.send_message.assert_not_called()

    def test_claim_search_handles_pagination_and_fails_closed(self):
        item = cloud.identity('example@gmail.com','2026-10-04')
        with patch.object(cloud,'github_json',side_effect=[{'artifacts':[{'name':'other'}]*100},
                {'artifacts':[{'name':item['claimArtifact'],'expired':False}]}]) as api:
            self.assertTrue(cloud.has_claim(item))
            self.assertEqual(api.call_count,2)
        with patch.object(cloud,'github_json',side_effect=OSError('unreachable')):
            with self.assertRaises(OSError):cloud.has_claim(item)

    def send_context(self, directory):
        path = Path(directory)
        result = self.valid()
        (path/'latest.json').write_text(json.dumps(result))
        item = cloud.identity('example@gmail.com',cloud.today())
        item.update(status='claimed',reportHash=hashlib.sha256(cloud.validated_report(result,cloud.today()).encode()).hexdigest())
        (path/'cloud-claim.json').write_text(json.dumps(item))
        return item

    def test_missing_durable_claim_prevents_smtp(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(cloud,'DIRECTORY',Path(directory)), \
             patch.object(cloud,'account',return_value='example@gmail.com'), \
             patch.object(cloud,'has_claim',return_value=False), patch.object(cloud.smtplib,'SMTP_SSL') as smtp:
            self.send_context(directory)
            with self.assertRaisesRegex(RuntimeError,'durable GitHub claim'):
                cloud.send()
            smtp.assert_not_called()

    def test_changed_report_cannot_be_sent_under_old_claim(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(cloud,'DIRECTORY',Path(directory)), \
             patch.object(cloud,'account',return_value='example@gmail.com'), patch.object(cloud.smtplib,'SMTP_SSL') as smtp:
            self.send_context(directory)
            path=Path(directory)/'latest.json'; data=json.loads(path.read_text())
            data['universeDescription']='changed'; path.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError,'changed'):
                cloud.send()
            smtp.assert_not_called()

    def test_smtp_timeout_is_not_retried_and_claim_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(cloud,'DIRECTORY',Path(directory)), \
             patch.object(cloud,'account',return_value='example@gmail.com'), \
             patch.object(cloud,'password',return_value='secret'), \
             patch.object(cloud,'has_claim',return_value=True), patch.object(cloud,'find_sent',return_value=None), \
             patch.object(cloud.smtplib,'SMTP_SSL') as smtp:
            self.send_context(directory)
            sender=smtp.return_value.__enter__.return_value
            sender.send_message.side_effect=TimeoutError('ambiguous')
            with self.assertRaises(TimeoutError):cloud.send()
            self.assertEqual(sender.send_message.call_count,1)
            self.assertTrue((Path(directory)/'cloud-claim.json').exists())
            self.assertFalse((Path(directory)/'cloud-receipt.json').exists())

    def test_receipt_requires_actual_gmail_confirmation(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(cloud,'DIRECTORY',Path(directory)), \
             patch.object(cloud,'account',return_value='example@gmail.com'), \
             patch.object(cloud,'password',return_value='secret'), \
             patch.object(cloud,'has_claim',return_value=True), \
             patch.object(cloud,'find_sent',side_effect=[None,'1a-real-id']), \
             patch.object(cloud.smtplib,'SMTP_SSL') as smtp:
            self.send_context(directory)
            smtp.return_value.__enter__.return_value.send_message.return_value={}
            cloud.send()
            saved=json.loads((Path(directory)/'cloud-receipt.json').read_text())
            self.assertEqual(saved['messageId'],'1a-real-id')
            self.assertEqual(saved['status'],'sent')


if __name__ == '__main__':unittest.main()
