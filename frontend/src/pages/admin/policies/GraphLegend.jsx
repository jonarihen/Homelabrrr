import { SERVICES, SERVICE_COLORS, DENY_COLOR, badgeStyle } from './services.js';

export default function GraphLegend({ usedServices, hasDeny }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {SERVICES.map(service => {
        const used = !usedServices || usedServices.has(service.name);
        return (
          <span
            key={service.name}
            title={used ? undefined : 'No policy currently uses this service'}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em] transition-opacity ${used ? '' : 'opacity-40'}`}
            style={badgeStyle(service.name)}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: SERVICE_COLORS[service.name] }}
            />
            {service.label}
          </span>
        );
      })}
      {hasDeny && (
        <span
          className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em]"
          style={badgeStyle('DENY', 'deny')}
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: DENY_COLOR }} />
          Deny
        </span>
      )}
    </div>
  );
}
