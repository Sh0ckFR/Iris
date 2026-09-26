import { dashboardStore, useDashboards } from '../../lib/dashboards';
import { Widget } from './widgets/Widget';
import { CloseIcon } from './icons';
import { useT } from '../../i18n';

/**
 * The pinned dashboards (lib/dashboards.ts): one tab per dashboard, its widgets in a grid. They
 * are ordinary widgets, so the live ones keep refreshing by themselves.
 */
export function DashboardPanel() {
  const { dashboards, open } = useDashboards();
  const t = useT().dashboard;
  const current = dashboards.find((d) => d.id === open) ?? dashboards[0];

  if (!current) {
    return <p className="dash-empty">{t.empty}</p>;
  }

  return (
    <div className="dash">
      {dashboards.length > 1 && (
        <div className="vis-tabs dash-tabs" role="tablist">
          {dashboards.map((d) => (
            <button key={d.id} type="button" role="tab" aria-selected={d.id === current.id} className={d.id === current.id ? 'on' : ''} onClick={() => dashboardStore.open(d.id)}>
              {d.name}
            </button>
          ))}
        </div>
      )}
      <div className="dash-grid">
        {current.widgets.map((w) => (
          <article key={w.id} className={`dash-tile dash-tile--${w.spec.kind}`}>
            <button
              type="button"
              className="hud-icon-btn hud-icon-btn--sm dash-unpin"
              onClick={() => dashboardStore.unpin(current.id, w.id)}
              aria-label={t.unpin}
              title={t.unpinTitle}
            >
              <CloseIcon width={12} height={12} />
            </button>
            <Widget spec={w.spec} />
          </article>
        ))}
      </div>
    </div>
  );
}
