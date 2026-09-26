import { useEffect, useMemo, useRef, useState } from 'react';
import { Background, ReactFlow, useEdgesState, useNodesState, type Edge, type Node, type ReactFlowInstance } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ENTITY_TYPES, USER_ID, knowledgeStore, useKnowledge, type GraphEntity } from '../../lib/knowledge';
import { uiLocale, useT } from '../../i18n';

/**
 * The user's world, as Iris has come to know it: people, places, organisations, projects and
 * topics (from the conversation summaries and what the tools looked up), around the user, with
 * their relations. Nodes grow with their mentions; what came up recently glows. Click a node to
 * see its relations or forget it. Dragged positions are kept while the HUD is open.
 */

/** Nodes shown at once (the most mentioned and most recent). */
const MAX_NODES = 60;
/** "Recent": seen in the last day. */
const RECENT_MS = 24 * 3600_000;

/** Each type has its sector around the user; entities further from the user sit further out. */
function layout(entities: GraphEntity[], hops: Map<string, number>): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const sector = (2 * Math.PI) / ENTITY_TYPES.length;
  const perLayer = 4;
  ENTITY_TYPES.forEach((type, t) => {
    const group = entities.filter((e) => e.type === type).sort((a, b) => b.mentions - a.mentions);
    group.forEach((e, i) => {
      const ring = Math.min(3, hops.get(e.id) ?? 2);
      // Spread over the whole sector; alternate radii so neighbours' labels don't touch.
      const slot = i % perLayer;
      const layer = Math.floor(i / perLayer);
      const inLayer = Math.min(perLayer, group.length - layer * perLayer);
      const angle = t * sector - Math.PI / 2 + ((slot + 0.5) / inLayer) * sector;
      const radius = 200 + (ring - 1) * 130 + layer * 95 + (slot % 2) * 40;
      positions.set(e.id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
    });
  });
  return positions;
}

export function KnowledgeGraph() {
  const { entities, relations } = useKnowledge();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges] = useEdgesState<Edge>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const flow = useRef<ReactFlowInstance | null>(null);
  const dragged = useRef(new Map<string, { x: number; y: number }>());
  const shownCount = useRef(0);
  const tr = useT();
  const m = tr.graph;

  const shown = useMemo(() => {
    const now = Date.now();
    const score = (e: GraphEntity) => e.mentions + (now - e.lastSeen < RECENT_MS ? 3 : 0);
    return [...entities].sort((a, b) => score(b) - score(a)).slice(0, MAX_NODES);
  }, [entities]);

  useEffect(() => {
    const ids = new Set(shown.map((e) => e.id));
    const visible = relations.filter((r) => (r.from === USER_ID || ids.has(r.from)) && (r.to === USER_ID || ids.has(r.to)));
    // Distance from the user, through the relations (1 = directly related).
    const hops = new Map<string, number>([[USER_ID, 0]]);
    for (let depth = 1, frontier = [USER_ID]; frontier.length && depth <= 3; depth++) {
      const next: string[] = [];
      for (const r of visible) {
        for (const [a, b] of [[r.from, r.to], [r.to, r.from]]) {
          if (frontier.includes(a) && !hops.has(b)) {
            hops.set(b, depth);
            next.push(b);
          }
        }
      }
      frontier = next;
    }
    const positions = layout(shown, hops);
    const now = Date.now();
    const maxMentions = Math.max(1, ...shown.map((e) => e.mentions));
    const userLabel = knowledgeStore.nameOf(USER_ID);

    setNodes([
      {
        id: USER_ID,
        position: dragged.current.get(USER_ID) ?? { x: 0, y: 0 },
        data: { label: userLabel },
        className: 'kg-node kg-node--core',
      },
      ...shown.map((e): Node => {
        const scale = 0.85 + 0.45 * Math.sqrt(e.mentions / maxMentions);
        return {
          id: e.id,
          position: dragged.current.get(e.id) ?? positions.get(e.id)!,
          data: { label: e.name },
          className: `kg-node kg-node--${e.type}${now - e.lastSeen < RECENT_MS ? ' kg-node--recent' : ''}${e.id === selected ? ' selected' : ''}`,
          style: { fontSize: `${(11 * scale).toFixed(1)}px` },
        };
      }),
    ]);

    const linked = new Set(visible.flatMap((r) => [r.from, r.to]));
    setEdges([
      ...visible.map(
        (r): Edge => ({
          id: r.id,
          source: r.from,
          target: r.to,
          label: r.label,
          animated: now - r.lastSeen < RECENT_MS,
          className: 'kg-edge',
          labelBgPadding: [4, 2],
          labelBgBorderRadius: 4,
        }),
      ),
      // Mentioned, but with no known relation: a faint line to the user.
      ...shown
        .filter((e) => !linked.has(e.id))
        .map((e): Edge => ({ id: `m-${e.id}`, source: USER_ID, target: e.id, className: 'kg-edge kg-edge--faint' })),
    ]);

    if (shown.length !== shownCount.current) {
      shownCount.current = shown.length;
      requestAnimationFrame(() => flow.current?.fitView({ padding: 0.2, duration: 500 }));
    }
    // m: the user's node is named in the interface language.
  }, [shown, relations, selected, setNodes, setEdges, m]);

  const entity = selected ? entities.find((e) => e.id === selected) : null;
  const entityRelations = selected ? relations.filter((r) => r.from === selected || r.to === selected) : [];

  return (
    <div className="kg">
      {entities.length === 0 && <p className="kg-empty">{m.empty}</p>}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onNodeDragStop={(_, node) => dragged.current.set(node.id, node.position)}
        onNodeClick={(_, node) => setSelected(node.id === USER_ID || node.id === selected ? null : node.id)}
        onPaneClick={() => setSelected(null)}
        onInit={(instance) => {
          flow.current = instance;
        }}
        colorMode="dark"
        fitView
        fitViewOptions={{ padding: 0.3 }}
        minZoom={0.2}
        maxZoom={1.6}
        nodesConnectable={false}
        deleteKeyCode={null}
        defaultEdgeOptions={{ type: 'straight' }}
      >
        <Background gap={24} size={1} color="rgba(118, 185, 0, 0.12)" />
      </ReactFlow>
      {entity && (
        <div className="kg-detail">
          <div className="kg-detail-head">
            <span className={`kg-badge kg-badge--${entity.type}`}>{m.types[entity.type]}</span>
            <b>{entity.name}</b>
          </div>
          <p className="brief-meta">
            {m.mentioned(entity.mentions, new Date(entity.lastSeen).toLocaleDateString(uiLocale(), { day: 'numeric', month: 'short' }))}
          </p>
          {entityRelations.length > 0 && (
            <ul>
              {entityRelations.slice(0, 8).map((r) => (
                <li key={r.id}>
                  {knowledgeStore.nameOf(r.from)} <span className="kg-detail-rel">{r.label}</span> {knowledgeStore.nameOf(r.to)}
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className="set-link"
            onClick={() => {
              knowledgeStore.remove(entity.id);
              setSelected(null);
            }}
          >
            {tr.common.forget}
          </button>
        </div>
      )}
    </div>
  );
}
