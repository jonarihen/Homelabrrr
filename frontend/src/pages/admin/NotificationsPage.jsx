import { useState, useEffect } from 'react';
import api from '../../api.js';
import Modal from '../../components/Modal.jsx';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';

const inputCls = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors';

const CATEGORY_LABELS = {
  deployment: 'Deployments',
  backup: 'Backups',
  health: 'Node health',
  notice: 'Notices',
  security: 'Security',
  lease: 'Leases',
};

export default function NotificationsPage() {
  useDocumentTitle('Notifications');
  const [webhooks, setWebhooks] = useState([]);
  const [eventTypes, setEventTypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editWebhook, setEditWebhook] = useState(null);
  const [testResult, setTestResult] = useState({}); // id -> { ok, msg }
  const [testing, setTesting] = useState(null);

  const load = async () => {
    try {
      const [whRes, etRes] = await Promise.all([
        api.get('/notifications/webhooks'),
        api.get('/notifications/event-types'),
      ]);
      setWebhooks(whRes.data);
      setEventTypes(etRes.data);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const del = async (wh) => {
    if (!confirm(`Delete webhook "${wh.name}"? Events routed only to it will stop being sent.`)) return;
    try {
      await api.delete(`/notifications/webhooks/${wh.id}`);
      load();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to delete');
    }
  };

  const sendTest = async (wh) => {
    setTesting(wh.id);
    setTestResult(r => ({ ...r, [wh.id]: null }));
    try {
      await api.post(`/notifications/webhooks/${wh.id}/test`);
      setTestResult(r => ({ ...r, [wh.id]: { ok: true, msg: 'Test message sent' } }));
    } catch (e) {
      setTestResult(r => ({ ...r, [wh.id]: { ok: false, msg: e.response?.data?.error || 'Test failed' } }));
    } finally {
      setTesting(null);
    }
  };

  const labelFor = (key) => eventTypes.find(e => e.key === key)?.label || key;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="aaris-display text-lg text-gray-100">Notifications</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Route portal events to Discord webhooks — {webhooks.length} channel{webhooks.length !== 1 ? 's' : ''} configured
          </p>
        </div>
        <button
          onClick={() => { setEditWebhook(null); setModalOpen(true); }}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          + New Webhook
        </button>
      </div>

      {error && <p className="text-red-400 text-sm mb-4 bg-red-900/20 rounded p-3">{error}</p>}

      {loading ? (
        <div className="space-y-3">
          {[1, 2].map(i => <div key={i} className="h-20 bg-gray-900 rounded-xl animate-pulse" />)}
        </div>
      ) : webhooks.length === 0 ? (
        <div className="text-center py-20 text-gray-500">
          <p>No webhooks configured yet.</p>
          <p className="text-sm mt-1">Create a Discord webhook in your server (Channel → Integrations → Webhooks) and paste its URL here.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {webhooks.map(wh => {
            const res = testResult[wh.id];
            return (
              <div key={wh.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`w-1.5 h-1.5 rounded-full ${wh.enabled ? 'bg-green-400' : 'bg-gray-600'}`} />
                      <span className="text-white font-medium">{wh.name}</span>
                      {!wh.enabled && (
                        <span className="text-[10px] uppercase tracking-wider text-gray-400 bg-gray-800 border border-gray-700 px-2 py-0.5 rounded-full">
                          Disabled
                        </span>
                      )}
                    </div>
                    <p className="font-mono text-xs text-gray-500 mt-1 truncate">{wh.urlHint}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => sendTest(wh)}
                      disabled={testing === wh.id}
                      className="text-xs text-orange-400 hover:text-orange-300 bg-orange-500/10 hover:bg-orange-500/20 px-3 py-1.5 rounded transition-colors disabled:opacity-50"
                    >
                      {testing === wh.id ? 'Sending...' : 'Send test'}
                    </button>
                    <button
                      onClick={() => { setEditWebhook(wh); setModalOpen(true); }}
                      className="text-xs text-blue-400 hover:text-blue-300 px-3 py-1.5 rounded hover:bg-gray-700 transition-colors"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => del(wh)}
                      className="text-xs text-red-500 hover:text-red-400 px-3 py-1.5 rounded hover:bg-gray-700 transition-colors"
                    >
                      Delete
                    </button>
                  </div>
                </div>

                {wh.eventTypes.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5 mt-3">
                    {wh.eventTypes.map(key => (
                      <span key={key} className="text-[11px] text-gray-300 bg-gray-800 border border-gray-700 px-2 py-0.5 rounded">
                        {labelFor(key)}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-amber-400/80 mt-3">No event types selected — this webhook receives nothing.</p>
                )}

                {res && (
                  <p className={`text-xs mt-3 ${res.ok ? 'text-green-400' : 'text-red-400'}`}>{res.msg}</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {modalOpen && (
        <WebhookFormModal
          webhook={editWebhook}
          eventTypes={eventTypes}
          onClose={() => setModalOpen(false)}
          onSaved={() => { setModalOpen(false); load(); }}
        />
      )}
    </div>
  );
}

function WebhookFormModal({ webhook, eventTypes, onClose, onSaved }) {
  const isEdit = !!webhook;
  const [form, setForm] = useState({
    name: webhook?.name || '',
    url: '',
    enabled: webhook ? webhook.enabled : true,
  });
  const [selected, setSelected] = useState(new Set(webhook?.eventTypes || eventTypes.map(e => e.key)));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const toggle = (key) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  // Group event types by category for the checklist
  const groups = eventTypes.reduce((acc, et) => {
    (acc[et.category] = acc[et.category] || []).push(et);
    return acc;
  }, {});

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const payload = {
        name: form.name,
        eventTypes: [...selected],
        enabled: form.enabled,
      };
      // Only send the URL when creating, or when the admin typed a new one on edit.
      if (form.url.trim()) payload.url = form.url.trim();
      if (isEdit) {
        await api.put(`/notifications/webhooks/${webhook.id}`, payload);
      } else {
        await api.post('/notifications/webhooks', payload);
      }
      onSaved();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={isEdit ? `Edit ${webhook.name}` : 'New Webhook'} onClose={onClose} size="md">
      <form onSubmit={submit} className="p-5 space-y-4">
        <div>
          <label className="block text-xs text-gray-400 mb-1.5">Name</label>
          <input
            type="text"
            required
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder="e.g. #lab-alerts"
            className={inputCls}
            autoFocus
          />
        </div>

        <div>
          <label className="block text-xs text-gray-400 mb-1.5">
            Discord Webhook URL {isEdit && <span className="text-gray-600">(leave blank to keep current)</span>}
          </label>
          <input
            type="password"
            required={!isEdit}
            value={form.url}
            onChange={e => setForm(f => ({ ...f, url: e.target.value }))}
            placeholder={isEdit ? '••••••••' : 'https://discord.com/api/webhooks/…'}
            className={`${inputCls} font-mono`}
            autoComplete="off"
          />
          <p className="mt-1.5 text-xs text-gray-500">Stored encrypted at rest. Create one in Discord under Channel → Integrations → Webhooks.</p>
        </div>

        <div>
          <label className="block text-xs text-gray-400 mb-2">Events to send</label>
          <div className="space-y-3 max-h-64 overflow-y-auto border border-gray-800 rounded-lg p-3">
            {Object.entries(groups).map(([cat, items]) => (
              <div key={cat}>
                <p className="text-[10px] uppercase tracking-wider text-gray-600 mb-1.5">{CATEGORY_LABELS[cat] || cat}</p>
                <div className="space-y-1.5">
                  {items.map(et => (
                    <label key={et.key} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selected.has(et.key)}
                        onChange={() => toggle(et.key)}
                        className="accent-blue-500"
                      />
                      <span className="text-sm text-gray-300">{et.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))}
            className="accent-green-500"
          />
          <span className="text-sm text-gray-300">Enabled</span>
        </label>

        {error && <p className="text-xs text-red-400 bg-red-900/20 rounded p-2">{error}</p>}

        <button
          type="submit"
          disabled={saving}
          className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg py-2.5 text-sm font-medium transition-colors"
        >
          {saving ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Webhook'}
        </button>
      </form>
    </Modal>
  );
}
