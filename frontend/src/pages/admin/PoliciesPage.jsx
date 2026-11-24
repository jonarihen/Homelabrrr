import { useState, useEffect, useMemo } from 'react';
import api from '../../api.js';
import useDocumentTitle from '../../hooks/useDocumentTitle.js';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useConfirm, useToast } from '../../contexts/FeedbackContext.jsx';
import GraphLegend from './policies/GraphLegend.jsx';
import usePoliciesData from './policies/usePoliciesData.js';
import usePolicyObjects from './policies/usePolicyObjects.js';
import usePolicyMesh from './policies/usePolicyMesh.js';
import PolicyMeshCanvas from './policies/PolicyMeshCanvas.jsx';
import PolicyRulesTab from './policies/PolicyRulesTab.jsx';
import AddressObjectsTab from './policies/AddressObjectsTab.jsx';
import ServiceObjectsTab from './policies/ServiceObjectsTab.jsx';
import CreatePolicyModal from './policies/CreatePolicyModal.jsx';

export default function PoliciesPage() {
  const confirm = useConfirm();
  const toast = useToast();
  useDocumentTitle('Policies');
  const { user } = useAuth();
  const canManageObjects = !!user?.isAdmin;
  const { firewalls, selectedFw, setSelectedFw, vlans, policies, loading, policiesLoading, loadData } = usePoliciesData();

  const [srcVlan, setSrcVlan] = useState(null);
  const [dstVlan, setDstVlan] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [selectedServices, setSelectedServices] = useState(new Set(['ALL']));
  const [bidirectional, setBidirectional] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const objects = usePolicyObjects({ selectedFw, canManageObjects });
  const { activeTab, setActiveTab } = objects;

  const mesh = usePolicyMesh({ vlans, policies, srcVlan, loading });
  const { dragRef, setDragOverrides, linePopover, setLinePopover, peerTags, selectedLineCount } = mesh;

  // Esc walks back one step: modal → line popover → source selection
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      if (showModal) { cancelSelection(); return; }
      if (linePopover) { setLinePopover(null); return; }
      if (srcVlan) cancelSelection();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const usedServices = useMemo(() => {
    const set = new Set();
    policies.forEach(p => (p.service || []).forEach(s => set.add(s)));
    return set;
  }, [policies]);
  const hasDeny = useMemo(() => policies.some(p => p.action !== 'accept'), [policies]);

  const handleCardClick = (vlan) => {
    // Ignore click if user was dragging the node
    if (dragRef.current?.moved) return;
    if (!srcVlan) {
      setSrcVlan(vlan);
      setDragOverrides({});
      return;
    }
    if (srcVlan.tag === vlan.tag) {
      cancelSelection();
      return;
    }
    setDstVlan(vlan);
    setSelectedServices(new Set(['ALL']));
    setBidirectional(false);
    setError('');
    setShowModal(true);
  };

  const cancelSelection = () => {
    setSrcVlan(null);
    setDstVlan(null);
    setShowModal(false);
    setError('');
    setDragOverrides({});
  };

  const createPolicy = async () => {
    setCreating(true);
    setError('');
    try {
      await api.post('/admin/policies', {
        firewallId: selectedFw,
        srcVlanTag: srcVlan.tag,
        dstVlanTag: dstVlan.tag,
        services: Array.from(selectedServices),
        action: 'accept',
        bidirectional,
      });
      cancelSelection();
      loadData();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create policy');
    } finally {
      setCreating(false);
    }
  };

  const deletePolicy = async (policyId) => {
    if (!await confirm({ message: 'Delete this policy?', confirmLabel: 'Delete', danger: true })) return;
    try {
      await api.delete(`/admin/policies/${policyId}?firewallId=${selectedFw}`);
      setLinePopover(null);
      loadData();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to delete policy');
    }
  };

  if (loading) {
    return (
      <div className="p-6 lg:p-8 max-w-7xl mx-auto">
        <div className="bg-gray-900 border border-gray-800 rounded-3xl h-[700px] animate-pulse" />
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      <div className="space-y-4">
        <div className="rounded-3xl border border-gray-800 bg-gray-900 p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-3">
              <div>
                <h1 className="aaris-display text-xl text-gray-100">Policy Mesh</h1>
                <p className="mt-1 text-sm text-slate-400">
                  {srcVlan
                    ? `Source locked on ${srcVlan.name}. Existing peers pull inward so you can see the neighborhood before choosing a destination.`
                    : 'Choose a source VLAN to pull its existing peers into focus, then click a destination to define the rule.'}
                </p>
              </div>
              <GraphLegend usedServices={usedServices} hasDeny={hasDeny} />
            </div>

            <div className="flex flex-col gap-3 sm:flex-row">
              <div className="rounded-2xl border border-slate-800 bg-slate-900/70 px-4 py-3 text-sm">
                <p className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Selection</p>
                <p className="mt-1 font-medium text-white">
                  {srcVlan ? srcVlan.name : 'No source selected'}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {srcVlan
                    ? `${peerTags.size} linked VLANs, ${selectedLineCount || 0} visible routes`
                    : `${vlans.length} VLANs in this firewall mesh`}
                </p>
              </div>

              <div className="rounded-2xl border border-slate-800 bg-slate-900/70 px-4 py-3 text-sm">
                <p className="text-[11px] uppercase tracking-[0.22em] text-slate-500">Firewall</p>
                {firewalls.length > 1 ? (
                  <select
                    value={selectedFw || ''}
                    onChange={e => { setSelectedFw(parseInt(e.target.value, 10)); cancelSelection(); }}
                    className="mt-1 rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-white"
                  >
                    {firewalls.map(fw => <option key={fw.id} value={fw.id}>{fw.name}</option>)}
                  </select>
                ) : (
                  <p className="mt-1 font-medium text-white">{firewalls[0]?.name || 'No firewall selected'}</p>
                )}
              </div>
            </div>
          </div>

          <PolicyMeshCanvas
            mesh={mesh}
            vlans={vlans}
            srcVlan={srcVlan}
            dstVlan={dstVlan}
            policiesLoading={policiesLoading}
            onCardClick={handleCardClick}
            onDeletePolicy={deletePolicy}
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-3xl border border-gray-800 bg-gray-900/90 p-5">
            <p className="text-[11px] uppercase tracking-[0.24em] text-slate-500">How To Read It</p>
            <div className="mt-3 space-y-3 text-sm text-slate-300">
              <p>Pick a VLAN. It moves to the center.</p>
              <p>Existing neighbors pull into the inner ring so you can see what is already wired.</p>
              <p>Route colors reflect the allowed service mix on that policy. Click a route to inspect or delete it.</p>
              <p>Outer-ring VLANs are still valid targets, but they are not currently linked to the selected source.</p>
              <p className="text-xs text-slate-500">Scroll to zoom, drag empty space to pan, drag nodes to rearrange. Esc steps back out of any selection.</p>
            </div>
          </div>

          <div className="rounded-3xl border border-gray-800 bg-gray-900/90 p-5">
            <p className="text-[11px] uppercase tracking-[0.24em] text-slate-500">Current Focus</p>
            {srcVlan ? (
              <div className="mt-3">
                <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/5 px-4 py-3">
                  <p className="text-sm font-semibold text-white">{srcVlan.name}</p>
                  <p className="mt-1 text-xs font-mono text-slate-400">{srcVlan.fwSubnet}</p>
                  <p className="mt-3 text-xs text-slate-400">
                    {peerTags.size} linked VLANs already share a policy with this source.
                  </p>
                </div>
                <button
                  onClick={cancelSelection}
                  className="mt-3 w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2.5 text-sm text-slate-200 transition-colors hover:bg-slate-700"
                >
                  Clear Selection
                </button>
              </div>
            ) : (
              <p className="mt-3 text-sm text-slate-500">No VLAN selected. Click any node in the mesh to start routing from that source.</p>
            )}
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-3xl border border-gray-800 bg-gray-900">
        <div className="flex border-b border-gray-800">
          {[
            { id: 'rules', label: 'Policies', count: policies.length },
            ...(canManageObjects ? [
              { id: 'addresses', label: 'Address Objects' },
              { id: 'services', label: 'Service Objects' },
            ] : []),
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`relative px-5 py-3 text-sm font-medium transition-colors ${
                activeTab === tab.id ? 'text-white' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {tab.label}
              {tab.count > 0 && <span className="ml-1.5 text-[11px] text-gray-500">({tab.count})</span>}
              {activeTab === tab.id && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-cyan-400" />}
            </button>
          ))}
        </div>

        {activeTab === 'rules' && <PolicyRulesTab policies={policies} onDelete={deletePolicy} />}

        {activeTab === 'addresses' && <AddressObjectsTab objects={objects} selectedFw={selectedFw} />}

        {activeTab === 'services' && <ServiceObjectsTab objects={objects} selectedFw={selectedFw} />}
      </div>

      {showModal && srcVlan && dstVlan && (
        <CreatePolicyModal
          srcVlan={srcVlan}
          dstVlan={dstVlan}
          selectedServices={selectedServices}
          setSelectedServices={setSelectedServices}
          bidirectional={bidirectional}
          setBidirectional={setBidirectional}
          creating={creating}
          error={error}
          onCancel={cancelSelection}
          onCreate={createPolicy}
        />
      )}
    </div>
  );
}
