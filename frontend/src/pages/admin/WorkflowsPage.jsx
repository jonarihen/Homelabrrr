import useDocumentTitle from '../../hooks/useDocumentTitle.js';
import WorkflowEditor from './WorkflowEditor.jsx';
import WorkflowModals from './WorkflowModals.jsx';
import { Banner, inputMono, label, panel } from './WorkflowPageComponents.jsx';
import WorkflowSidebar from './WorkflowSidebar.jsx';
import useWorkflowPage from './useWorkflowPage.js';

function WorkflowContent({ page }) {
  if (page.firewalls.length === 0) return <div className={`${panel} p-10 text-center text-sm text-gray-500`}>Register a firewall first — workflows are configured per firewall.</div>;
  return <>
    <div className="flex flex-wrap gap-1.5 border-b border-gray-800 pb-3">{page.catalog.triggers.map((item) => {
      const match = page.workflows.find((candidate) => candidate.trigger === item.trigger);
      const active = page.trigger === item.trigger;
      return <button key={item.trigger} onClick={() => page.setTrigger(item.trigger)} className={`border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.1em] transition-colors ${active ? 'border-orange-600 bg-orange-600/10 text-orange-300' : 'border-gray-800 text-gray-500 hover:border-gray-600 hover:text-gray-300'}`}>{item.label}{match && !match.enabled ? ' · off' : ''}</button>;
    })}</div>
    {page.workflow && <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_20rem]"><WorkflowEditor {...page} settings={page.workflow.settings || {}} openReset={() => page.setResetOpen(true)} /><WorkflowSidebar {...page} /></div>}
  </>;
}

export default function WorkflowsPage() {
  useDocumentTitle('Workflows');
  const page = useWorkflowPage();
  if (page.loading) return <div className="p-6 font-mono text-xs uppercase tracking-widest text-gray-500">Loading…</div>;
  return <div className="mx-auto max-w-6xl space-y-5 p-6">
    <div className="flex flex-wrap items-end justify-between gap-4"><div><h1 className="aaris-display text-xl text-gray-100">Provisioning Workflows</h1><p className="mt-1 text-sm text-gray-500">Configure the exact FortiGate steps each provisioning flow runs — reorder, toggle, parametrize, and preview. Defaults reproduce the built-in behavior.</p></div>{page.firewalls.length > 1 && <div className="flex items-center gap-2"><span className={label}>Firewall</span><select value={page.selectedFw || ''} onChange={(event) => page.setSelectedFw(parseInt(event.target.value, 10))} className={inputMono}>{page.firewalls.map((firewall) => <option key={firewall.id} value={firewall.id}>{firewall.name}</option>)}</select></div>}</div>
    {page.error && <Banner kind="error" onClose={() => page.setError('')}>{page.error}</Banner>}
    {page.notice && <Banner kind="info" onClose={() => page.setNotice('')}>{page.notice}</Banner>}
    <WorkflowContent page={page} />
    <WorkflowModals {...page} closeReset={() => page.setResetOpen(false)} closeRun={() => page.setOpenRun(null)} />
  </div>;
}
