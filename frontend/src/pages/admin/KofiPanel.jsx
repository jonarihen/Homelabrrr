import { Fragment, useCallback, useEffect, useId, useRef, useState } from 'react';
import api from '../../api.js';
import Field from '../../components/Field.jsx';
import ErrorCallout from '../../components/ErrorCallout.jsx';
import { useConfirm } from '../../contexts/FeedbackContext.jsx';
import { Actions, Badge, Cell, DataTable, EmptyState, Row, RowsSkeleton, Section, Stat, SubHead, btnPrimary, btnSecondary, btnSm, btnSmDanger, inputCls, money, when } from './PayPalOperationsPanel.jsx';

const BASE = '/payments/admin/kofi';
const btnDanger = 'bg-red-700 hover:bg-red-600 text-white rounded-xl px-4 py-2.5 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap';
const checkCls = 'flex cursor-pointer items-center gap-2 text-xs text-gray-400';
const clip = 'block max-w-[9rem] truncate';
// Free text from a payer or an administrator: at most three lines, never wider than its column.
const clamp = 'min-w-[6.5rem] max-w-[14rem] line-clamp-3 [overflow-wrap:anywhere]';

// Amount fields accept a Danish decimal comma; the API takes a dot ("37.25").
const AMOUNT = /^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/;
const decimal = (value) => String(value ?? '').trim().replace(',', '.');
// Whole øre from an amount field without floats; null when the text is not an amount.
const toOre = (value) => {
  const text = decimal(value);
  if (!AMOUNT.test(text)) return null;
  const [whole, cents = ''] = text.split('.');
  return Number(whole) * 100 + Number(cents.padEnd(2, '0'));
};
// Date over time, for the narrow "Received" column of the review table.
const day = (value) => value ? new Intl.DateTimeFormat('da-DK', { dateStyle: 'short' }).format(new Date(value)) : '—';
const clock = (value) => value ? new Intl.DateTimeFormat('da-DK', { timeStyle: 'short' }).format(new Date(value)) : '';
const GROSS_MIN_ORE = 100;
const GROSS_MAX_ORE = 1000000;

const WEBHOOK_ERRORS = {
  RETURN_ORIGIN_NOT_CONFIGURED: 'The webhook URL cannot be shown: PORTAL_BASE_URL (or ALLOWED_ORIGIN) is not set on the backend.',
  WEBHOOK_ORIGIN_INVALID: 'The webhook URL cannot be shown: the configured portal origin is not an HTTPS origin.',
};
const REASONS = {
  MEMBER_UNMATCHED: 'Payer email is not linked to a member',
  EMAIL_MISSING: 'No usable payer email',
  CURRENCY_NOT_DKK: 'Foreign currency: record the DKK amount',
  INVALID_CURRENCY: 'Currency code is not valid',
  UNSUPPORTED_TYPE: 'Commissions and shop orders are not recorded',
  UNKNOWN_TYPE: 'Unknown Ko-fi event type',
  INVALID_AMOUNT: 'Amount is missing or out of range',
  INVALID_TRANSACTION_ID: 'Transaction id is missing or malformed',
  INVALID_TIMESTAMP: 'Timestamp is missing or implausible',
  DUPLICATE_MANUAL_RECEIPT: 'Already recorded as a manual receipt',
  TRANSACTION_CONFLICT: 'Same transaction id with another amount or kind',
  PROCESSING_FAILED: 'Processing failed after repeated attempts',
};
// A long code may wrap after an underscore instead of widening the table.
const reasonCode = (code) => code.split('_').map((part, index) => <Fragment key={index}>{index > 0 && <>_<wbr /></>}{part}</Fragment>);
const REVIEW_FILTERS = [['needs_review', 'Needs review'], ['resolved', 'Resolved'], ['all', 'All']];
const RECEIPT_FILTERS = [['net_unresolved', 'Awaiting fee'], ['posted', 'Posted'], ['reversed', 'Reversed'], ['voided', 'Voided'], ['all', 'All']];
const RECEIPT_STATUS = { net_unresolved: ['warn', 'awaiting fee'], posted: ['ok', 'posted'], reversed: ['neutral', 'reversed'], voided: ['neutral', 'voided'] };
const SOURCES = { admin_link: 'Linked from review', admin_entry: 'Entered in advance' };
const TILES = [
  ['Last event', (s) => s.lastEventAt ? [when(s.lastEventAt), s.lastEventType, s.lastEventOutcome].filter(Boolean).join(' · ') : '—'],
  ['Last test event', (s) => when(s.lastTestEventAt)],
  ['Last error', (s) => s.lastErrorAt ? [when(s.lastErrorAt), s.lastErrorCode].filter(Boolean).join(' · ') : '—'],
  ['Token replaced', (s) => when(s.tokenUpdatedAt)],
  ['Inbox pending', (s) => s.counts?.pending ?? '—'],
  ['Needs review', (s) => s.counts?.needsReview ?? '—'],
  ['Awaiting fee', (s) => s.counts?.awaitingFee ?? '—'],
  ['Awaiting DKK amount', (s) => s.counts?.awaitingDkkAmount ?? '—'],
];

// Member picker options. '' = nothing chosen yet; 'none' = deliberately no member (sent as userId: null).
// `known` keeps an already linked member selectable when the user list did not load.
function memberOptions(users, { none = false, known = null } = {}) {
  const missing = known && !users.some((user) => user.id === known.id);
  return <>
    <option value="" disabled>Choose…</option>
    {none && <option value="none">No member (counted, not attributed)</option>}
    {missing && <option value={known.id}>{known.username || `#${known.id}`}</option>}
    {users.map((user) => <option key={user.id} value={user.id}>{user.username}</option>)}
  </>;
}
const pickedUserId = (value) => value === 'none' ? null : Number(value);
// A list answer as { items, nextOffset }, whatever came back.
const page = (data) => ({ items: Array.isArray(data?.items) ? data.items : [], nextOffset: data?.nextOffset ?? null });

// One open form per table, keyed by action and row.
function useRowForm() {
  const [open, setOpen] = useState(null);
  const [form, setForm] = useState({});
  return {
    form,
    is: (kind, id) => open?.kind === kind && open.id === id,
    start: (kind, id, initial = {}) => { setOpen({ kind, id }); setForm(initial); },
    close: () => { setOpen(null); setForm({}); },
    text: (key) => ({ value: form[key] ?? '', onChange: (event) => setForm((old) => ({ ...old, [key]: event.target.value })) }),
    check: (key) => ({ checked: !!form[key], onChange: (event) => setForm((old) => ({ ...old, [key]: event.target.checked })) }),
  };
}

// A row's form spans the visible width of the scrolling table (100cqw of the
// @container around it, minus the table border) and stays put while the table
// scrolls sideways, so it is usable at phone width.
function FormRow({ span, label, onSubmit, children }) {
  return <tr className="border-b border-gray-800 last:border-0 bg-gray-950/40">
    <td colSpan={span} className="p-0">
      <form onSubmit={onSubmit} aria-label={label} className="sticky left-0 w-[calc(100cqw-2px)] p-4 grid gap-4 sm:grid-cols-2">{children}</form>
    </td>
  </tr>;
}

function FormContext({ children }) {
  return <p className="sm:col-span-2 text-xs text-gray-400 break-words">{children}</p>;
}

function FormButtons({ label, working, disabled, danger, onCancel }) {
  return <div className="sm:col-span-2 flex flex-wrap gap-3">
    <button disabled={disabled} className={danger ? btnDanger : btnPrimary}>{working ? 'Working…' : label}</button>
    <button type="button" onClick={onCancel} className={btnSecondary}>Cancel</button>
  </div>;
}

function AmountField({ label, hint, invalid, ...input }) {
  const id = useId();
  return <div>
    <label htmlFor={id} className="block text-xs text-gray-400 mb-1.5">{label}</label>
    <input id={id} inputMode="decimal" autoComplete="off" aria-invalid={invalid || undefined} aria-describedby={`${id}-hint`} className={inputCls} {...input} />
    <p id={`${id}-hint`} className={`text-xs mt-1.5 ${invalid ? 'text-red-400' : 'text-gray-500'}`}>{hint}</p>
  </div>;
}

// The net that will count, shown before the administrator confirms. It stays
// blank until both amounts are valid, so a half-typed value never shows a figure.
function NetLine({ grossOre, feeOre }) {
  const known = grossOre != null && feeOre != null && feeOre <= grossOre;
  return <p className="sm:col-span-2 font-mono text-xs text-gray-400">
    Counts as: {known ? <><span className="text-sm text-gray-100">{money(grossOre - feeOre)}</span> <span className="text-gray-500">= {money(grossOre)} before fees − {money(feeOre)} fee</span></>
      : <span className="text-gray-500">—</span>}
  </p>;
}

// A fixed amount shown in the place of an input, so it reads as part of the form.
function ReadOnlyAmount({ label, children }) {
  return <div>
    <p className="block text-xs text-gray-400 mb-1.5">{label}</p>
    <p className="bg-gray-950/50 border border-gray-800 rounded-xl px-3 py-2.5 text-sm font-mono text-gray-100">{children}</p>
  </div>;
}

function TableShell({ list, failed, empty, columns, onMore, busy, children }) {
  if (!list) return failed ? <EmptyState>Unavailable until Ko-fi details load.</EmptyState> : <RowsSkeleton />;
  if (list.items.length === 0) return <EmptyState>{empty}</EmptyState>;
  return <>
    <div className="@container"><DataTable columns={columns}>{children}</DataTable></div>
    {list.nextOffset != null && <div className="mt-3"><button type="button" disabled={!!busy} onClick={onMore} className={btnSm}>Load more</button></div>}
  </>;
}

function FilterSelect({ label, value, onChange, options }) {
  return <div className="w-44"><Field label={label}>
    <select value={value} onChange={(event) => onChange(event.target.value)} className={inputCls}>
      {options.map(([key, name]) => <option key={key} value={key}>{name}</option>)}
    </select>
  </Field></div>;
}

function SetupCard({ status, failed, run, busy }) {
  const confirm = useConfirm();
  const hookId = useId();
  const [pageUrl, setPageUrl] = useState('');
  const [token, setToken] = useState('');
  const [copied, setCopied] = useState(false);
  // Show the saved page URL once; a later reload never replaces an unsaved edit.
  const seeded = useRef(false);
  useEffect(() => { if (status && !seeded.current) { seeded.current = true; setPageUrl(status.pageUrl || ''); } }, [status]);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(status.webhookUrl); setCopied(true); }
    catch { /* clipboard blocked: the field stays selectable */ }
  };
  const save = (event) => {
    event.preventDefault();
    const secret = token.trim();
    const body = { pageUrl: pageUrl.trim(), ...(secret ? { verificationToken: secret } : {}) };
    run('kofi-save', () => api.post(`${BASE}/config`, body), ({ data }) => { setToken(''); setPageUrl(data?.pageUrl || body.pageUrl); });
  };
  const toggle = async () => {
    const enabling = !status.enabled;
    if (!enabling && !await confirm({ message: 'Stop accepting Ko-fi deliveries? Payments made while Ko-fi is disabled are not stored and must be recorded as manual receipts.', confirmLabel: 'Disable Ko-fi', danger: true })) return;
    run('kofi-toggle', () => api.post(`${BASE}/enabled`, { enabled: enabling }));
  };
  const loading = !status;
  return <Section title="Ko-fi setup · live"
    description="Ko-fi posts every payment to the webhook URL below. Paste that URL into Ko-fi's webhook settings (ko-fi.com/manage/webhooks) and store the verification token shown there. The token is write-only and encrypted at rest."
    actions={status && <div className="flex flex-wrap items-center gap-2">
      <Badge tone={status.configured ? 'ok' : 'neutral'}>{status.configured ? 'Configured' : 'Not configured'}</Badge>
      <Badge tone={status.enabled ? 'ok' : 'neutral'}>{status.enabled ? 'Ko-fi enabled' : 'Ko-fi disabled'}</Badge>
    </div>}>
    {loading && failed ? <EmptyState>Ko-fi setup could not be loaded.</EmptyState> : <>
      {status && (status.webhookUrl ? <div>
        <label htmlFor={hookId} className="block text-xs text-gray-400 mb-1.5">Webhook URL</label>
        <div className="flex gap-2">
          <input id={hookId} readOnly value={status.webhookUrl} onFocus={(event) => event.target.select()} className={`${inputCls} min-w-0 font-mono`} />
          <button type="button" onClick={copy} className={btnSecondary}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
      </div> : <p className="text-xs text-orange-300 bg-orange-900/10 border border-orange-800/40 rounded-xl p-3">
        {WEBHOOK_ERRORS[status.webhookUrlError] || 'The webhook URL is unavailable.'}{status.webhookUrlError && <span className="font-mono"> · {status.webhookUrlError}</span>}
      </p>)}
      <form onSubmit={save} aria-label="Ko-fi configuration" className="mt-5">
        <div className="grid md:grid-cols-2 gap-4">
          <Field label="Ko-fi page URL">
            <input value={pageUrl} onChange={(event) => setPageUrl(event.target.value)} placeholder="https://ko-fi.com/yourpage" autoComplete="off" required className={inputCls} />
          </Field>
          <Field label="Verification token">
            <input type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off"
              placeholder={loading ? '' : status.tokenStored ? 'A token is stored. Leave blank to keep it.' : 'No token stored yet. Paste it from Ko-fi.'} className={inputCls} />
          </Field>
        </div>
        <p className="text-xs text-gray-500 mt-4">The stored token is never shown again. Saving does not change whether Ko-fi is enabled. While disabled, deliveries are refused and nothing is stored.</p>
        <div className="flex flex-wrap gap-3 mt-5">
          <button disabled={!!busy || loading} className={btnPrimary}>{busy === 'kofi-save' ? 'Saving…' : 'Save Ko-fi settings'}</button>
          <button type="button" disabled={!!busy || loading || (!status.enabled && !status.configured)} onClick={toggle} className={btnSecondary}>{status?.enabled ? 'Disable Ko-fi' : 'Enable Ko-fi'}</button>
        </div>
      </form>
      <SubHead>Deliveries</SubHead>
      <dl className="grid grid-cols-2 md:grid-cols-4 gap-3" aria-busy={loading}>
        {TILES.map(([name, read]) => <Stat key={name} label={name} loading={loading} value={status ? read(status) : '—'} />)}
      </dl>
    </>}
  </Section>;
}

function ReviewQueue({ list, failed, filter, onFilter, onMore, users, run, busy }) {
  const rows = useRowForm();
  const { form } = rows;
  const path = (item, action) => `${BASE}/review/${encodeURIComponent(item.id)}/${action}`;
  // An email can only be remembered for a chosen member, when the event has a usable one that is not linked yet.
  const canRemember = (item) => !!form.member && form.member !== 'none' && !!item.email && item.reason !== 'EMAIL_MISSING' && item.matchedUserId == null;
  const grossOre = toOre(form.gross);
  const feeOre = toOre(form.fee);
  const grossOk = grossOre != null && grossOre >= GROSS_MIN_ORE && grossOre <= GROSS_MAX_ORE;
  const feeOk = feeOre != null && (grossOre == null || feeOre <= grossOre);
  const link = (event, item) => {
    event.preventDefault();
    const body = { userId: pickedUserId(form.member), rememberEmail: canRemember(item) && !!form.remember };
    run('kofi-link', () => api.post(path(item, 'link'), body), rows.close);
  };
  const settle = (event, item) => {
    event.preventDefault();
    const note = (form.note || '').trim();
    const body = { userId: pickedUserId(form.member), grossDkk: decimal(form.gross), fee: decimal(form.fee),
      rememberEmail: canRemember(item) && !!form.remember, ...(note ? { note } : {}) };
    run('kofi-settle', () => api.post(path(item, 'settle'), body), rows.close);
  };
  const dismiss = (event, item) => {
    event.preventDefault();
    const body = { note: form.note.trim() };
    run('kofi-dismiss', () => api.post(path(item, 'dismiss'), body), rows.close);
  };
  const payment = (item) => <>{item.eventType}{item.amount != null && <> · <span className="font-mono text-gray-200">{item.amount} {item.currency}</span></>}{item.fromName && <> from <span className="text-gray-200">{item.fromName}</span></>}</>;
  const remember = (item) => canRemember(item) && <label className={`${checkCls} sm:col-span-2`}>
    <input type="checkbox" className="accent-blue-500" {...rows.check('remember')} />Remember this email for this member, so later payments are matched automatically</label>;
  return <Section title="Ko-fi review queue · live"
    description="Held events block finalized net support until they are resolved. Link records a DKK payment for a member. Record in DKK settles a foreign-currency payment at the amount that actually arrived. Dismiss records the event as not lab income and posts nothing."
    actions={<FilterSelect label="Events shown" value={filter} onChange={onFilter} options={REVIEW_FILTERS} />}>
    <TableShell list={list} failed={failed} busy={busy} onMore={onMore} empty={filter === 'needs_review' ? 'No Ko-fi events need review.' : 'No Ko-fi events to show.'}
      columns={['Payment', 'Payer', 'Message', 'Reason', 'Received', 'Actions']}>
      {list?.items.map((item) => <Fragment key={item.id}>
        <Row>
          <Cell><span className="block font-mono text-gray-100 whitespace-nowrap">{item.amount != null ? `${item.amount} ${item.currency ?? ''}` : '—'}</span>
            <span className="block text-xs text-gray-400 whitespace-nowrap">{item.eventType}</span>
            {item.tierName && <span className={`${clip} text-xs text-gray-500`} title={item.tierName}>{item.tierName}</span>}
            {item.isSubscriptionPayment && <span className="block text-xs text-gray-500 whitespace-nowrap">{item.isFirstSubscriptionPayment ? 'first payment' : 'recurring payment'}</span>}</Cell>
          <Cell>{item.payloadRetained === false ? <span className="text-xs text-gray-500 whitespace-nowrap">payer details removed</span> : <>
            <span className={`${clip} text-gray-200`} title={item.fromName || undefined}>{item.fromName || '—'}</span>
            <span className={`${clip} text-xs text-gray-400`} title={item.email || undefined}>{item.email || 'no email'}</span>
            {item.matchedUsername && <span className={`${clip} text-xs text-green-400`}>linked to {item.matchedUsername}</span>}</>}</Cell>
          <Cell className="text-gray-400">{item.message ? <span className={clamp} title={item.message}>{item.message}</span> : '—'}</Cell>
          <Cell><span className="block min-w-[8.5rem] max-w-[13rem]">
            <span className="font-mono text-xs text-orange-300">{reasonCode(item.reason || 'review')}</span>
            {REASONS[item.reason] && <span className="block text-xs text-gray-500">{REASONS[item.reason]}</span>}</span></Cell>
          <Cell className="text-gray-400 whitespace-nowrap">{day(item.receivedAt)}<span className="block text-xs text-gray-500">{clock(item.receivedAt)}</span></Cell>
          <Cell>{item.status === 'needs_review' ? <Actions>
            {item.settleable && <button type="button" disabled={!!busy} className={btnSm}
              onClick={() => rows.start('settle', item.id, { member: item.matchedUserId != null ? String(item.matchedUserId) : '', remember: true })}>Record in DKK</button>}
            {item.linkable && !item.settleable && <button type="button" disabled={!!busy} className={btnSm} onClick={() => rows.start('link', item.id, { member: '', remember: true })}>Link</button>}
            <button type="button" disabled={!!busy} className={btnSm} onClick={() => run('kofi-retry', () => api.post(path(item, 'retry')), rows.close)}>Retry</button>
            <button type="button" disabled={!!busy} className={btnSmDanger} onClick={() => rows.start('dismiss', item.id, { note: '' })}>Dismiss</button>
          </Actions> : <span className="text-xs text-gray-500 whitespace-nowrap">{item.resolution || item.status}{item.resolvedAt ? ` · ${when(item.resolvedAt)}` : ''}</span>}</Cell>
        </Row>
        {rows.is('link', item.id) && <FormRow span={6} label="Link payment" onSubmit={(event) => link(event, item)}>
          <FormContext>Record {payment(item)} as a receipt awaiting its fee.</FormContext>
          <Field label="Member"><select required className={inputCls} {...rows.text('member')}>{memberOptions(users, { none: true })}</select></Field>
          {remember(item)}
          <FormButtons label="Link payment" working={busy === 'kofi-link'} disabled={!!busy || !form.member} onCancel={rows.close} />
        </FormRow>}
        {rows.is('settle', item.id) && <FormRow span={6} label="Record payment in DKK" onSubmit={(event) => settle(event, item)}>
          <FormContext>Record {payment(item)} at its DKK value. Nothing is converted or estimated here: read both amounts from the payout.</FormContext>
          <div className="sm:col-span-2 sm:max-w-sm"><Field label="Member">
            <select required className={inputCls} {...rows.text('member')}>
              {memberOptions(users, { none: true, known: item.matchedUserId != null ? { id: item.matchedUserId, username: item.matchedUsername } : null })}
            </select></Field></div>
          <AmountField label="DKK amount before fees" placeholder="e.g. 37,25" invalid={!!form.gross && !grossOk} {...rows.text('gross')}
            hint={form.gross && !grossOk ? 'Enter an amount between 1,00 and 10.000,00 DKK.' : 'The converted amount of the payment in your payout account, before the processor fee.'} />
          <AmountField label="Fee in DKK" placeholder="e.g. 1,95" invalid={!!form.fee && !feeOk} {...rows.text('fee')}
            hint={form.fee && !feeOk ? 'Enter a fee from 0,00 up to the amount before fees.' : 'The processor fee taken from this payment. Enter 0,00 if none was charged.'} />
          <NetLine grossOre={grossOk ? grossOre : null} feeOre={feeOk ? feeOre : null} />
          {remember(item)}
          <div className="sm:col-span-2"><Field label="Note (optional, stored privately)"><input maxLength={500} autoComplete="off" className={inputCls} {...rows.text('note')} /></Field></div>
          <FormButtons label="Record payment" working={busy === 'kofi-settle'} disabled={!!busy || !form.member || !grossOk || !feeOk} onCancel={rows.close} />
        </FormRow>}
        {rows.is('dismiss', item.id) && <FormRow span={6} label="Dismiss event" onSubmit={(event) => dismiss(event, item)}>
          <FormContext>Dismiss {payment(item)}. Nothing is posted and the event stops blocking net support.</FormContext>
          <div className="sm:col-span-2"><Field label="Why is this not lab income? (required, stored privately)">
            <input required minLength={3} maxLength={500} autoComplete="off" className={inputCls} {...rows.text('note')} /></Field></div>
          <FormButtons danger label="Dismiss event" working={busy === 'kofi-dismiss'} disabled={!!busy || (form.note || '').trim().length < 3} onCancel={rows.close} />
        </FormRow>}
      </Fragment>)}
    </TableShell>
  </Section>;
}

function Receipts({ list, failed, filter, onFilter, onMore, run, busy }) {
  const rows = useRowForm();
  const { form } = rows;
  const feeOre = toOre(form.fee);
  const creditOre = toOre(form.feeCredit);
  const enterFee = (event, item) => {
    event.preventDefault();
    const note = (form.note || '').trim();
    const body = { fee: decimal(form.fee), ...(note ? { note } : {}) };
    run('kofi-fee', () => api.post(`${BASE}/receipts/${item.id}/fee`, body), rows.close);
  };
  // Reverse covers both: a posted receipt is reversed, an unresolved one is voided.
  const reverse = (event, item) => {
    event.preventDefault();
    const credit = decimal(form.feeCredit);
    const body = { reason: form.reason.trim(), ...(item.status === 'posted' && credit ? { feeCredit: credit } : {}) };
    run('kofi-reverse', () => api.post(`${BASE}/receipts/${item.id}/reverse`, body), rows.close);
  };
  const member = (item) => item.username || (item.userId != null ? `#${item.userId}` : 'No member');
  const label = (item) => <>receipt #{item.id} · <span className="font-mono text-gray-200">{money(item.grossOre)}</span> · {item.kind} · {member(item)}</>;
  const reasonField = <div className="sm:col-span-2"><Field label="Reason (required, stored privately)">
    <input required minLength={3} maxLength={500} autoComplete="off" className={inputCls} {...rows.text('reason')} /></Field></div>;
  const reasonMissing = (form.reason || '').trim().length < 3;
  return <Section title="Ko-fi receipts · live"
    description="A receipt counts toward the budget only once its actual fee is entered; a missing fee is never treated as zero. Postings are never edited: reverse a posted receipt, or void one that is still awaiting its fee."
    actions={<FilterSelect label="Receipts shown" value={filter} onChange={onFilter} options={RECEIPT_FILTERS} />}>
    <TableShell list={list} failed={failed} busy={busy} onMore={onMore} empty={filter === 'net_unresolved' ? 'No Ko-fi receipts are awaiting a fee.' : 'No Ko-fi receipts to show.'}
      columns={['Gross', 'Member', 'Effective', 'Status', 'Fee', 'Net', 'Note', 'Actions']}>
      {list?.items.map((item) => {
        const feeOk = feeOre != null && feeOre <= item.grossOre;
        const creditOk = !form.feeCredit || (creditOre != null && creditOre <= (item.feeOre ?? 0));
        const [tone, name] = RECEIPT_STATUS[item.status] || ['neutral', item.status];
        return <Fragment key={item.id}>
          <Row>
            <Cell className="whitespace-nowrap"><span className="block text-gray-100">{money(item.grossOre)}</span>
              {item.originalAmount && <span className="block font-mono text-xs text-gray-400">{item.originalAmount} {item.originalCurrency}</span>}
              <span className="block text-xs text-gray-500">{item.kind}</span></Cell>
            <Cell className="text-gray-300"><span className={clip}>{member(item)}</span></Cell>
            <Cell className="text-gray-400 whitespace-nowrap">{when(item.effectiveAt)}</Cell>
            <Cell><Badge tone={tone}><span className="font-mono whitespace-nowrap">{name}</span></Badge></Cell>
            <Cell className="text-gray-300 whitespace-nowrap">{item.feeOre == null ? '—' : money(item.feeOre)}</Cell>
            <Cell className="text-gray-300 whitespace-nowrap">{item.netOre == null ? '—' : money(item.netOre)}</Cell>
            <Cell className="text-gray-400">{item.note ? <span className={clamp} title={item.note}>{item.note}</span> : '—'}</Cell>
            <Cell><Actions>
              {item.status === 'net_unresolved' && <>
                <button type="button" disabled={!!busy} className={btnSm} onClick={() => rows.start('fee', item.id)}>Enter fee</button>
                <button type="button" disabled={!!busy} className={btnSmDanger} onClick={() => rows.start('void', item.id)}>Void</button></>}
              {item.status === 'posted' && <button type="button" disabled={!!busy} className={btnSmDanger} onClick={() => rows.start('reverse', item.id)}>Reverse</button>}
            </Actions></Cell>
          </Row>
          {rows.is('fee', item.id) && <FormRow span={8} label="Enter fee" onSubmit={(event) => enterFee(event, item)}>
            <FormContext>Confirm the fee for {label(item)}. Read it from the payout: a posted fee cannot be edited afterwards.</FormContext>
            <ReadOnlyAmount label="DKK amount before fees">{money(item.grossOre)}{item.originalAmount && <span className="text-gray-500"> · {item.originalAmount} {item.originalCurrency}</span>}</ReadOnlyAmount>
            <AmountField label="Fee in DKK" placeholder="e.g. 1,95" invalid={!!form.fee && !feeOk} {...rows.text('fee')}
              hint={form.fee && !feeOk ? 'Enter a fee from 0,00 up to the amount before fees.' : 'The processor fee taken from this payment. Enter 0,00 if none was charged.'} />
            <NetLine grossOre={item.grossOre} feeOre={feeOk ? feeOre : null} />
            <div className="sm:col-span-2"><Field label="Note (optional, stored privately)"><input maxLength={500} autoComplete="off" className={inputCls} {...rows.text('note')} /></Field></div>
            <FormButtons label="Post fee" working={busy === 'kofi-fee'} disabled={!!busy || !feeOk} onCancel={rows.close} />
          </FormRow>}
          {rows.is('void', item.id) && <FormRow span={8} label="Void receipt" onSubmit={(event) => reverse(event, item)}>
            <FormContext>Void {label(item)}. Nothing is posted, and this Ko-fi transaction cannot be recorded again.</FormContext>
            {reasonField}
            <FormButtons danger label="Void receipt" working={busy === 'kofi-reverse'} disabled={!!busy || reasonMissing} onCancel={rows.close} />
          </FormRow>}
          {rows.is('reverse', item.id) && <FormRow span={8} label="Reverse receipt" onSubmit={(event) => reverse(event, item)}>
            <FormContext>Reverse {label(item)}. A negative posting for the full amount is appended; this cannot be undone.</FormContext>
            {reasonField}
            <AmountField label="Fee credit in DKK (optional)" placeholder="0,00" invalid={!creditOk} {...rows.text('feeCredit')}
              hint={creditOk ? `The part of the ${money(item.feeOre)} fee the processor returned. Leave blank for none.` : `Enter an amount from 0,00 up to the recorded fee of ${money(item.feeOre)}.`} />
            <FormButtons danger label="Reverse receipt" working={busy === 'kofi-reverse'} disabled={!!busy || reasonMissing || !creditOk} onCancel={rows.close} />
          </FormRow>}
        </Fragment>;
      })}
    </TableShell>
  </Section>;
}

function LinkedEmails({ members, failed, users, run, busy }) {
  const confirm = useConfirm();
  const [member, setMember] = useState('');
  const [email, setEmail] = useState('');
  const add = (event) => {
    event.preventDefault();
    const body = { userId: Number(member), email: email.trim() };
    run('kofi-member-add', () => api.post(`${BASE}/members`, body), () => { setMember(''); setEmail(''); });
  };
  const remove = async (item) => {
    if (!await confirm({ message: `Unlink ${item.emailHint} from ${item.username}? Later Ko-fi payments from that address are held for review.`, confirmLabel: 'Unlink', danger: true })) return;
    run('kofi-member-remove', () => api.delete(`${BASE}/members/${item.id}`));
  };
  return <Section title="Ko-fi linked emails"
    description="A DKK payment from a linked email is recorded for that member without review. Only a keyed hash and the masked hint shown here are stored, never the address itself.">
    {!members ? (failed ? <EmptyState>Unavailable until Ko-fi details load.</EmptyState> : <RowsSkeleton />)
      : members.length === 0 ? <EmptyState>No emails linked yet.</EmptyState> :
        <DataTable columns={['Email', 'Member', 'Source', 'Verified', 'Actions']}>{members.map((item) => <Row key={item.id}>
          <Cell className="font-mono text-gray-200 whitespace-nowrap">{item.emailHint}</Cell>
          <Cell className="text-gray-300"><span className={clip}>{item.username}</span></Cell>
          <Cell className="text-gray-400 whitespace-nowrap">{SOURCES[item.source] || item.source}</Cell>
          <Cell className="text-gray-400 whitespace-nowrap">{when(item.verifiedAt)}</Cell>
          <Cell><button type="button" disabled={!!busy} className={btnSmDanger} onClick={() => remove(item)}>Remove</button></Cell>
        </Row>)}</DataTable>}
    <SubHead>Link an email in advance</SubHead>
    <form onSubmit={add} aria-label="Link an email" className="grid gap-4 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] sm:items-end">
      <Field label="Member"><select required value={member} onChange={(event) => setMember(event.target.value)} className={inputCls}>{memberOptions(users)}</select></Field>
      <Field label="Email the member uses on Ko-fi"><input type="email" required maxLength={254} autoComplete="off" value={email} onChange={(event) => setEmail(event.target.value)} className={inputCls} /></Field>
      <div><button disabled={!!busy || !member || !email.trim()} className={btnSecondary}>{busy === 'kofi-member-add' ? 'Linking…' : 'Link email'}</button></div>
    </form>
  </Section>;
}

// Ko-fi is live only, so nothing here follows the page's sandbox/live selector.
// Every action goes through the page's `act`, which opens the identity check on
// REAUTHENTICATION_REQUIRED and replays the request afterwards.
export default function KofiPanel({ act, busy }) {
  const [status, setStatus] = useState(null);
  const [review, setReview] = useState(null);
  const [receipts, setReceipts] = useState(null);
  const [members, setMembers] = useState(null);
  const [users, setUsers] = useState([]);
  const [failed, setFailed] = useState({});
  const [reviewFilter, setReviewFilter] = useState('needs_review');
  const [receiptFilter, setReceiptFilter] = useState('net_unresolved');
  // Each part settles on its own, and only the newest request for a part may apply its answer.
  const tickets = useRef({});
  const fetchPart = useCallback(async (key, request, apply) => {
    const ticket = tickets.current[key] = (tickets.current[key] || 0) + 1;
    try {
      const { data } = await request();
      if (tickets.current[key] !== ticket) return;
      apply(data); setFailed((old) => ({ ...old, [key]: false }));
    } catch { if (tickets.current[key] === ticket) setFailed((old) => ({ ...old, [key]: true })); }
  }, []);
  const loadConfig = useCallback(() => fetchPart('config', () => api.get(`${BASE}/config`), setStatus), [fetchPart]);
  const loadReview = useCallback(() => fetchPart('review', () => api.get(`${BASE}/review`, { params: { status: reviewFilter } }), (data) => setReview(page(data))), [fetchPart, reviewFilter]);
  const loadReceipts = useCallback(() => fetchPart('receipts', () => api.get(`${BASE}/receipts`, { params: { status: receiptFilter } }), (data) => setReceipts(page(data))), [fetchPart, receiptFilter]);
  const loadMembers = useCallback(() => fetchPart('members', () => api.get(`${BASE}/members`), (data) => setMembers(page(data).items)), [fetchPart]);
  const loadUsers = useCallback(() => fetchPart('users', () => api.get('/admin/users'),
    (data) => setUsers(Array.isArray(data) ? [...data].sort((a, b) => String(a.username).localeCompare(String(b.username))) : [])), [fetchPart]);
  useEffect(() => { loadConfig(); loadMembers(); loadUsers(); }, [loadConfig, loadMembers, loadUsers]);
  useEffect(() => { setReview(null); loadReview(); }, [loadReview]);
  useEffect(() => { setReceipts(null); loadReceipts(); }, [loadReceipts]);
  const reload = () => Promise.all([loadConfig(), loadReview(), loadReceipts(), loadMembers()]);
  const more = (key, path, filter, list, setList) => fetchPart(key, () => api.get(`${BASE}/${path}`, { params: { status: filter, offset: list.nextOffset } }),
    (data) => setList({ items: [...list.items, ...page(data).items.filter((item) => !list.items.some((old) => old.id === item.id))], nextOffset: page(data).nextOffset }));
  // The follow-up and the reload live inside the request, so they also run when
  // the page replays it after the identity check.
  const run = (key, request, done) => act(key, async () => {
    const response = await request();
    done?.(response);
    await reload();
  });
  const anyFailed = Object.values(failed).some(Boolean);
  return <section id="kofi" aria-label="Ko-fi" className="space-y-6 scroll-mt-4 border-t border-gray-800 pt-6">
    <div>
      <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-orange-500">Ko-fi · live only</p>
      <p className="text-sm text-gray-500 mt-1">Independent of the PayPal environment selected above. Ko-fi has no sandbox.</p>
    </div>
    {anyFailed && <div className="space-y-3">
      <ErrorCallout error="Could not load some Ko-fi details." />
      <button type="button" onClick={() => { reload(); loadUsers(); }} className={btnSm}>Try again</button>
    </div>}
    <SetupCard status={status} failed={failed.config} run={run} busy={busy} />
    <ReviewQueue list={review} failed={failed.review} filter={reviewFilter} onFilter={setReviewFilter} users={users} run={run} busy={busy}
      onMore={() => more('review', 'review', reviewFilter, review, setReview)} />
    <Receipts list={receipts} failed={failed.receipts} filter={receiptFilter} onFilter={setReceiptFilter} run={run} busy={busy}
      onMore={() => more('receipts', 'receipts', receiptFilter, receipts, setReceipts)} />
    <LinkedEmails members={members} failed={failed.members} users={users} run={run} busy={busy} />
  </section>;
}
