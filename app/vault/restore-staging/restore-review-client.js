'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  buildVaultRestoreReviewApproval, classifyVaultRestoreReviewHistory,
} from '../../../lib/oge-vault-restore-review.js';
import styles from './restore-staging.module.css';

const historyEndpoint = '/api/vault/backup-import/chunk/history';
const approveEndpoint = '/api/vault/backup-import/chunk/authorize';

async function readResponse(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error || 'Staging request unavailable.');
  return body;
}

export default function RestoreReviewClient() {
  const [history, setHistory] = useState(null);
  const [historyError, setHistoryError] = useState('');
  const [historyBusy, setHistoryBusy] = useState(true);
  const [fields, setFields] = useState({
    sourceSnapshot: '', inventoryDigest: '', targetHead: '',
    fingerprint: '', selectedIdsText: '',
  });
  const [reviewed, setReviewed] = useState(false);
  const [typedConfirmation, setTypedConfirmation] = useState('');
  const [approveBusy, setApproveBusy] = useState(false);
  const [approvalError, setApprovalError] = useState('');
  const [receipt, setReceipt] = useState(null);
  const [copied, setCopied] = useState(false);
  const [receiptStatus, setReceiptStatus] = useState(null);
  const [receiptStatusError, setReceiptStatusError] = useState('');
  const [statusBusy, setStatusBusy] = useState(false);

  const loadHistory = useCallback(async (signal) => {
    setHistoryBusy(true);
    setHistoryError('');
    setHistory(null);
    try {
      const response = await fetch(historyEndpoint, {
        cache: 'no-store', credentials: 'same-origin', signal,
      });
      const data = await readResponse(response);
      if (!signal?.aborted) setHistory(data);
    } catch (error) {
      if (!signal?.aborted)
        setHistoryError(error instanceof Error
          ? error.message : 'Staging history unavailable.');
    } finally {
      if (!signal?.aborted) setHistoryBusy(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadHistory(controller.signal);
    return () => controller.abort();
  }, [loadHistory]);

  const review = classifyVaultRestoreReviewHistory(history);
  const canRequest = !historyBusy && !historyError &&
    review.canRequestReceipt && reviewed &&
    typedConfirmation === 'APPROVE ONE BATCH' &&
    !approveBusy && !receipt;

  async function requestReceipt(event) {
    event.preventDefault();
    if (!canRequest) return;
    setApprovalError('');
    setApproveBusy(true);
    try {
      const selected = buildVaultRestoreReviewApproval(fields);
      const response = await fetch(approveEndpoint, {
        method: 'POST', cache: 'no-store', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(selected),
      });
      const result = await readResponse(response);
      if (result?.format !== 'oge-vault-staging-one-time-restore-receipt' ||
          typeof result.ticket !== 'string' ||
          !/^[A-Za-z0-9_-]{60,3900}\.[a-f0-9]{64}$/.test(result.ticket) ||
          !/^[a-f0-9]{64}$/.test(result.receiptId || '') ||
          result.immediatelyExecutesRestore !== false ||
          result.productionRestoreAuthorized !== false ||
          result.oneTimeClaimRequired !== true)
        throw new Error('The staging receipt response is invalid. Check history before trying again.');
      setReceipt({
        ticket: result.ticket,
        receiptId: result.receiptId,
        expiresAt: result.expiresAt,
        selectedCount: result.selectedCount,
      });
      setCopied(false);
    } catch (error) {
      // POST may have issued a receipt despite a lost browser response.
      // Never automatically replay or issue a second POST here.
      setApprovalError((error instanceof Error ? error.message
        : 'Approval receipt was not confirmed.') +
        ' Inspect the read-only history before considering a new request.');
    } finally { setApproveBusy(false); }
  }

  async function copyTicket() {
    if (!receipt) return;
    setCopied(false);
    try {
      await navigator.clipboard.writeText(JSON.stringify({
        ticket: receipt.ticket,
      }));
      setCopied(true);
    } catch {
      setApprovalError('Clipboard access denied. Do not put the receipt in chat, logs or public files.');
    }
  }

  async function loadReceiptStatus() {
    if (!receipt || statusBusy) return;
    setStatusBusy(true);
    setReceiptStatusError('');
    try {
      const response = await fetch('/api/vault/backup-import/chunk/status?receiptId=' +
        encodeURIComponent(receipt.receiptId), {
          cache: 'no-store', credentials: 'same-origin',
        });
      const data = await readResponse(response);
      setReceiptStatus(data);
    } catch (error) {
      setReceiptStatus(null);
      setReceiptStatusError(error instanceof Error
        ? error.message : 'Status unavailable. Do not retry the GitHub write.');
    } finally { setStatusBusy(false); }
  }

  const field = (name) => (event) =>
    setFields((value) => ({ ...value, [name]: event.target.value }));

  return (
    <div className={styles.layout}>
      <section className={styles.panel} aria-labelledby="restore-history-heading">
        <div className={styles.headingRow}>
          <div><span className={styles.kicker}>01 / BATCH HISTORY</span>
            <h2 id="restore-history-heading">What is already known?</h2></div>
          <button type="button" className={styles.secondary}
            onClick={() => loadHistory()} disabled={historyBusy || approveBusy}>
            {historyBusy ? 'Checking…' : 'Refresh history'}
          </button>
        </div>
        <p className={styles.helper}>This is a metadata-only view, not GitHub
          source verification. No next batch is automatically authorized.</p>
        {historyBusy && <p role="status">Checking signed staging history…</p>}
        {historyError && <p role="alert" className={styles.alert}>
          {historyError} Approval is disabled while history is unavailable.</p>}
        {!historyBusy && !historyError && (
          <>
            <p role="status" className={review.canRequestReceipt
              ? styles.neutral : styles.alert}>{review.label}</p>
            <p className={styles.muted}>
              {history?.visibleBatchCount ?? 0} recent receipt(s) visible.
              Records older than the retention window may be absent.
            </p>
            {Array.isArray(history?.batches) && history.batches.length > 0 && (
              <ul className={styles.historyList}>
                {history.batches.map((batch) => (
                  <li key={batch.receiptId}>
                    <strong>{batch.state === 'GITHUB_BATCH_CONFIRMED'
                      ? 'Confirmed GitHub batch'
                      : batch.state === 'PENDING_APPROVAL_CLAIM'
                        ? 'Pending operator claim'
                        : 'Claimed — investigate if interrupted'}</strong>
                    <span>Receipt {batch.receiptId.slice(0, 10)}…</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <section className={styles.panel} aria-labelledby="restore-approval-heading">
        <span className={styles.kicker}>02 / EXACT REVIEWED SELECTION</span>
        <h2 id="restore-approval-heading">Approve one operator receipt</h2>
        <p className={styles.helper}>Enter only the IDs and hashes from the
          independently verified M57 read-only plan. Never paste note bodies,
          complete archive JSON, passwords, or GitHub credentials here.</p>
        <form onSubmit={requestReceipt} className={styles.form} autoComplete="off">
          <label>Source backup Git commit (40 lowercase hex)
            <input name="sourceSnapshot" value={fields.sourceSnapshot}
              onChange={field('sourceSnapshot')} spellCheck={false}
              placeholder="Exact 40-character source commit" maxLength={40}
              disabled={Boolean(receipt)} required />
          </label>
          <label>Complete source inventory SHA-256 (64 lowercase hex)
            <input name="inventoryDigest" value={fields.inventoryDigest}
              onChange={field('inventoryDigest')} spellCheck={false}
              placeholder="Exact 64-character inventory checksum" maxLength={64}
              disabled={Boolean(receipt)} required />
          </label>
          <label>Reviewed current destination HEAD (40 lowercase hex)
            <input name="targetHead" value={fields.targetHead}
              onChange={field('targetHead')} spellCheck={false}
              placeholder="Exact reviewed target commit" maxLength={40}
              disabled={Boolean(receipt)} required />
          </label>
          <label>Verified M57 selection fingerprint (64 lowercase hex)
            <input name="fingerprint" value={fields.fingerprint}
              onChange={field('fingerprint')} spellCheck={false}
              placeholder="Exact reviewed selection fingerprint" maxLength={64}
              disabled={Boolean(receipt)} required />
          </label>
          <label>Selected note UUIDs (1–12, comma or newline separated)
            <textarea name="selectedIdsText" value={fields.selectedIdsText}
              onChange={field('selectedIdsText')} spellCheck={false}
              placeholder="Paste only selected note UUIDs" rows={4}
              maxLength={600} disabled={Boolean(receipt)} required />
          </label>
          <label className={styles.checkbox}>
            <input type="checkbox" checked={reviewed} disabled={Boolean(receipt)}
              onChange={(e) => setReviewed(e.target.checked)} />
            <span>I independently reviewed the create-only candidates, encrypted
              draft conflicts, complete source proof, and exact target HEAD.</span>
          </label>
          <label>Type APPROVE ONE BATCH to request a receipt
            <input name="typedConfirmation" value={typedConfirmation}
              onChange={(e) => setTypedConfirmation(e.target.value)}
              disabled={Boolean(receipt)} autoComplete="off"
              placeholder="APPROVE ONE BATCH" maxLength={32} />
          </label>
          {approvalError && <p role="alert" className={styles.alert}>
            {approvalError}</p>}
          <button type="submit" className={styles.primary}
            disabled={!canRequest}>
            {approveBusy ? 'Requesting…' : 'Request one-time staging receipt'}
          </button>
        </form>
        <p className={styles.muted}>This request issues a signed 10-minute receipt
          only. It never commits Notes. The private operator must separately
          verify the backup and claim the receipt once.</p>
      </section>

      {receipt && <section className={styles.panel} aria-labelledby="restore-ticket-heading">
        <span className={styles.kicker}>03 / PRIVATE OPERATOR HANDOFF</span>
        <h2 id="restore-ticket-heading">One-time receipt issued</h2>
        <p role="status" className={styles.neutral}>Approval recorded for
          {receipt.selectedCount} note(s). GitHub has not been modified by
          this page.</p>
        <p className={styles.helper}>Expires {receipt.expiresAt}. Transfer the
          ticket only to the authorized staging operator, using a private
          owner-only 0600 JSON file outside the backup directory.</p>
        <p className={styles.muted}>Receipt ID: <code>{receipt.receiptId}</code></p>
        <button type="button" className={styles.primary} onClick={copyTicket}>
          Copy private ticket JSON to clipboard
        </button>
        {copied && <p role="status" className={styles.neutral}>
          Copied. The clipboard now contains sensitive authorization
          material. Clear it after securely handing off the ticket.</p>}
        <button type="button" className={styles.secondary}
          onClick={loadReceiptStatus} disabled={statusBusy}>
          {statusBusy ? 'Checking…' : 'Check this receipt status'}
        </button>
        {receiptStatusError && <p role="alert" className={styles.alert}>
          {receiptStatusError}</p>}
        {receiptStatus && <p role="status" className={styles.neutral}>
          {receiptStatus.status === 'GITHUB_BATCH_CONFIRMED'
            ? 'GitHub batch confirmed.'
            : receiptStatus.status === 'PENDING_APPROVAL_CLAIM'
              ? 'Receipt has not yet been claimed.'
              : 'Receipt claimed; GitHub outcome may require independent review.'}
          {' '}Do not automatically retry, release a lock, or start another batch.
        </p>}
      </section>}
    </div>
  );
}
