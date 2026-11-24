import SupportCoverage from '../../components/SupportCoverage.jsx';
import { Section } from './PayPalOperationsPanel.jsx';

// The owner's copy of the cost coverage members also see on the Support and
// Energy pages, with the month-by-month table and the owner-only hints.
export default function SupportOverviewPanel({ refreshKey, uncounted = 0 }) {
  return <Section title="Cost coverage"
    description="Lab electricity cost against net support from members over the last 24 months. Members see the same totals on the Support and Energy pages; no member is named.">
    <SupportCoverage audience="owner" table refreshKey={refreshKey} uncounted={uncounted} />
  </Section>;
}
