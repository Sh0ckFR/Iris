import type { WidgetSpec } from '../../assistant/widgetTools';
import { MapWidget } from './MapWidget';
import { ChartWidget } from './ChartWidget';
import { CardsWidget, StatsWidget, TableWidget, TimelineWidget } from './DataWidgets';
import { useT } from '../../../i18n';

/** A ready-made data widget (see show_data): title, then the view for its kind. */
export function Widget({ spec }: { spec: WidgetSpec }) {
  const t = useT();
  return (
    <div className={`wg wg--${spec.kind}`}>
      <header className="wg-head">
        <h3>{spec.title}</h3>
        {spec.subtitle && <p className="brief-meta">{spec.subtitle}</p>}
      </header>
      <div className="wg-body">
        {spec.kind === 'map' && <MapWidget spec={spec} />}
        {spec.kind === 'chart' && <ChartWidget spec={spec} />}
        {spec.kind === 'table' && <TableWidget spec={spec} />}
        {spec.kind === 'stats' && <StatsWidget spec={spec} />}
        {spec.kind === 'timeline' && <TimelineWidget spec={spec} />}
        {spec.kind === 'cards' && <CardsWidget spec={spec} />}
      </div>
      {spec.source && (
        <p className="wg-source">
          {t.common.source}
          {spec.source}
        </p>
      )}
    </div>
  );
}
