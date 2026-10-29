/**
 * Client half of dsh-layers-hippocampus (dsh.client, platform "web").
 *
 * Hard rules, because a broken client entry aborts the whole Web boot
 * ("web boot: N entries did not activate"):
 *
 *   1. Module scope does nothing but hand a factory to the module loader.
 *   2. The factory never throws: a missing `react` yields an inert plugin.
 *   3. `apply` never throws: every slot registration is isolated, and a slot we
 *      cannot fill is skipped — the Host keeps working, the panel just doesn't
 *      appear.
 *   4. Registrations use `ctx.slots.inject(name, () => register(...))`.
 *   5. Rendering data comes from the Host's JSON routes; the browser cannot call
 *      agent tools.
 *
 * Surfaces: sidebar icon + main panel (stats, SVG storage ring, force graph) and
 * a settings section. The graph is a *cached* projection: the panel asks for at
 * most `config.graphMaxEdges` edges and never sorts client-side.
 */

(function bootstrapHippocampusClient() {
  'use strict';

  const loader = typeof window === 'object' ? window.__ModuleLoader__ : undefined;
  if (!loader || typeof loader.load !== 'function') return;

  loader.load({
    id: 'dsh-layers-hippocampus',
    factory(require) {
      let React = null;
      try {
        React = require('react');
      } catch (error) {
        React = null;
      }
      if (!React || typeof React.createElement !== 'function') {
        return { inject: [], apply() {} };
      }
      const h = React.createElement;

      const API = {
        stats: '/api/hippocampus/stats',
        config: '/api/hippocampus/config',
        graph: '/api/hippocampus/graph',
        retry: '/api/hippocampus/retry',
      };
      const POLL_MS = 3000;
      /** Soft storage budget used only by the ring; over it the ring turns red. */
      const STORAGE_BUDGET_BYTES = 50 * 1024 * 1024;

      // ---- data --------------------------------------------------------------

      async function getJson(url, init) {
        const response = await fetch(url, { credentials: 'same-origin', ...init });
        let body = null;
        try {
          body = await response.json();
        } catch (error) {
          body = { ok: false, error: { code: 'MEM_E_NETWORK', message: `HTTP ${response.status}` } };
        }
        return { status: response.status, body };
      }

      function useMemoryStats() {
        const [state, setState] = React.useState({ loading: true, payload: null, error: null });

        React.useEffect(() => {
          let alive = true;
          let timer = null;
          const tick = async () => {
            try {
              const { status, body } = await getJson(API.stats);
              if (!alive) return;
              if (body && body.ok === true) {
                setState({ loading: false, payload: body, error: null });
              } else if (status === 503 && body) {
                setState({ loading: false, payload: body, error: null });
              } else {
                setState((prev) => ({
                  loading: false,
                  payload: prev.payload,
                  error: (body && body.error) || { code: 'MEM_E_NETWORK', message: `HTTP ${status}` },
                }));
              }
            } catch (error) {
              if (!alive) return;
              setState((prev) => ({
                loading: false,
                payload: prev.payload,
                error: { code: 'MEM_E_NETWORK', message: String((error && error.message) || error) },
              }));
            } finally {
              if (alive) timer = setTimeout(tick, POLL_MS);
            }
          };
          tick();
          return () => {
            alive = false;
            if (timer) clearTimeout(timer);
          };
        }, []);

        return state;
      }

      /**
       * Graph fetch keyed by the configured edge ceiling: when the setting
       * changes, the next render fetches with the new limit and redraws.
       */
      function useGraph(limit, available) {
        const [state, setState] = React.useState({ graph: null, error: null, limit: null });

        React.useEffect(() => {
          if (!available) return undefined;
          let alive = true;
          setState((prev) => ({ ...prev, error: null }));
          getJson(`${API.graph}?limit=${encodeURIComponent(limit)}`)
            .then(({ body }) => {
              if (!alive) return;
              if (body && body.ok && body.graph) {
                setState({ graph: body.graph, error: null, limit });
              } else {
                setState((prev) => ({ ...prev, error: (body && body.error) || { code: 'MEM_E_GRAPH', message: 'graph unavailable' }, limit }));
              }
            })
            .catch((error) => {
              if (alive) setState((prev) => ({ ...prev, error: { code: 'MEM_E_NETWORK', message: String(error) }, limit }));
            });
          return () => {
            alive = false;
          };
        }, [limit, available]);

        return state;
      }

      // ---- presentation ------------------------------------------------------

      const palette = {
        card: 'var(--dsh-surface-raised, rgba(127,127,127,0.08))',
        border: 'var(--dsh-border-subtle, rgba(127,127,127,0.22))',
        muted: 'var(--dsh-text-muted, rgba(127,127,127,0.9))',
        text: 'var(--dsh-text-primary, currentColor)',
        accent: 'var(--dsh-accent, #4f8cff)',
        warn: 'var(--dsh-warning, #d99b2b)',
        danger: 'var(--dsh-danger, #d9534f)',
      };

      const cardStyle = {
        background: palette.card,
        border: `1px solid ${palette.border}`,
        borderRadius: 12,
        padding: '12px 14px',
      };
      const labelStyle = { fontSize: 12, color: palette.muted, marginBottom: 4 };

      const fmtNumber = (value) =>
        typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US') : '—';

      const fmtBytes = (bytes) => {
        if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '—';
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
      };

      const fmtTime = (ms) => {
        if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—';
        const date = new Date(ms);
        const pad = (n) => String(n).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
      };

      function StatCard(props) {
        return h(
          'div',
          { style: { ...cardStyle, minWidth: 120, flex: '1 1 120px' } },
          h('div', { style: labelStyle }, props.label),
          h('div', { style: { fontSize: 20, fontWeight: 600, lineHeight: 1.2, fontVariantNumeric: 'tabular-nums' } }, props.value),
          props.hint ? h('div', { style: { ...labelStyle, marginTop: 4, marginBottom: 0 } }, props.hint) : null,
        );
      }

      function Row(props) {
        return h(
          'div',
          {
            style: {
              display: 'flex',
              justifyContent: 'space-between',
              gap: 12,
              padding: '5px 0',
              borderBottom: `1px solid ${palette.border}`,
              fontSize: 13,
            },
          },
          h('span', { style: { color: palette.muted } }, props.label),
          h('span', { style: { color: palette.text, fontVariantNumeric: 'tabular-nums' } }, props.value),
        );
      }

      function PhaseBadge(props) {
        const tones = { ready: palette.accent, failed: palette.danger, in_progress: palette.warn, pending: palette.muted };
        const text = { ready: '就绪', failed: '失败', in_progress: '启动中', pending: '等待启动' };
        const phase = props.phase;
        return h(
          'span',
          {
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              color: tones[phase] || palette.muted,
              border: `1px solid ${tones[phase] || palette.border}`,
              borderRadius: 999,
              padding: '2px 10px',
            },
          },
          h('span', { style: { width: 6, height: 6, borderRadius: 999, background: tones[phase] || palette.muted } }),
          text[phase] || String(phase || '未知'),
        );
      }

      /** Failed banner: the phase, the error code and the one action that helps. */
      function FailureBanner(props) {
        const [busy, setBusy] = React.useState(false);
        const [result, setResult] = React.useState(null);
        const failure = props.error || {};

        const retry = async () => {
          setBusy(true);
          setResult(null);
          try {
            const { status, body } = await getJson(API.retry, { method: 'POST' });
            setResult({ ok: status === 202 && body && body.ok !== false, text: (body && (body.message || body.code)) || `HTTP ${status}` });
          } catch (error) {
            setResult({ ok: false, text: String((error && error.message) || error) });
          } finally {
            setBusy(false);
          }
        };

        return h(
          'div',
          { style: { ...cardStyle, borderColor: palette.danger, display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between' } },
          h(
            'div',
            null,
            h('div', { style: { fontWeight: 600, marginBottom: 4, color: palette.danger } }, '记忆库启动失败'),
            h('div', { style: { fontSize: 13 } }, `${failure.code || 'MEM_E_UNKNOWN'}: ${failure.message || '未知错误'}`),
            result ? h('div', { style: { ...labelStyle, marginTop: 4, marginBottom: 0 } }, result.text) : null,
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: retry,
              disabled: busy,
              style: {
                padding: '6px 14px',
                borderRadius: 8,
                border: `1px solid ${palette.danger}`,
                background: 'transparent',
                color: palette.danger,
                cursor: busy ? 'default' : 'pointer',
                fontSize: 13,
                whiteSpace: 'nowrap',
              },
            },
            busy ? '重试中…' : '重试',
          ),
        );
      }

      function PhaseCard(props) {
        const payload = props.payload;
        if (payload && payload.phase === 'failed') return h(FailureBanner, { error: payload.error || props.error });
        if (props.error) {
          return h(
            'div',
            { style: { ...cardStyle, borderColor: palette.warn } },
            h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '无法连接记忆服务'),
            h('div', { style: { fontSize: 13, color: palette.muted } }, `${props.error.code || 'MEM_E_NETWORK'}: ${props.error.message || ''}`),
          );
        }
        return h(
          'div',
          { style: cardStyle },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 } },
            h('span', {
              style: {
                width: 12,
                height: 12,
                borderRadius: 999,
                border: `2px solid ${palette.accent}`,
                borderTopColor: 'transparent',
                display: 'inline-block',
              },
            }),
            payload && payload.phase === 'in_progress' ? '正在迁移/加载索引…' : '正在启动…',
          ),
          h('div', { style: { ...labelStyle, marginTop: 8 } }, '启动在后台进行，检索就绪后本卡片会自动刷新。'),
        );
      }

      function MemoryIcon(props) {
        const size = (props && props.size) || 18;
        const active = Boolean(props && props.active);
        return h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: active ? palette.accent : 'currentColor',
            strokeWidth: 1.8,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            role: 'img',
            'aria-label': 'Hippocampus Memory',
          },
          h('path', { d: 'M12 3c-4.97 0-9 2.24-9 5s4.03 5 9 5 9-2.24 9-5-4.03-5-9-5Z' }),
          h('path', { d: 'M3 8v6c0 2.76 4.03 5 9 5s9-2.24 9-5V8' }),
          h('path', { d: 'M3 14v4c0 2.76 4.03 5 9 5s9-2.24 9-5v-4' }),
        );
      }

      // ---- storage ring ------------------------------------------------------

      /**
       * Pure SVG ring: one arc drawn from a dash pattern, no chart library.
       * Over 100% the arc is clamped (a ring cannot exceed a full circle) and the
       * card turns red so "over budget" is never hidden by the clamp.
       */
      function StorageRing(props) {
        const used = typeof props.used === 'number' && Number.isFinite(props.used) ? props.used : 0;
        const budget = props.budget || STORAGE_BUDGET_BYTES;
        const rawPercent = budget > 0 ? (used / budget) * 100 : 0;
        const over = rawPercent > 100;
        const percent = Math.max(0, Math.min(rawPercent, 100));
        const size = 132;
        const stroke = 12;
        const radius = (size - stroke) / 2;
        const circumference = 2 * Math.PI * radius;
        const dash = (percent / 100) * circumference;
        const tint = over ? palette.danger : palette.accent;

        return h(
          'div',
          { style: { ...cardStyle, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minWidth: 180 } },
          h(
            'svg',
            { width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': `存储占用 ${rawPercent.toFixed(0)}%` },
            h('circle', { cx: size / 2, cy: size / 2, r: radius, fill: 'none', stroke: palette.border, strokeWidth: stroke }),
            h('circle', {
              cx: size / 2,
              cy: size / 2,
              r: radius,
              fill: 'none',
              stroke: tint,
              strokeWidth: stroke,
              strokeLinecap: 'round',
              strokeDasharray: `${dash} ${circumference - dash}`,
              transform: `rotate(-90 ${size / 2} ${size / 2})`,
            }),
            h(
              'text',
              { x: '50%', y: '47%', textAnchor: 'middle', fill: palette.text, style: { fontSize: 17, fontWeight: 600, fontVariantNumeric: 'tabular-nums' } },
              fmtBytes(used),
            ),
            h(
              'text',
              { x: '50%', y: '62%', textAnchor: 'middle', fill: over ? palette.danger : palette.muted, style: { fontSize: 12, fontVariantNumeric: 'tabular-nums' } },
              `${rawPercent.toFixed(0)}%${over ? ' !' : ''}`,
            ),
          ),
          h('div', { style: { ...labelStyle, marginTop: 6, marginBottom: 0, color: over ? palette.danger : palette.muted } }, over ? `超出预算 ${fmtBytes(used - budget)}` : `预算 ${fmtBytes(budget)}`),
        );
      }

      // ---- force graph -------------------------------------------------------

      /** Deterministic PRNG so a redraw looks the same across reloads. */
      function mulberry32(seed) {
        let a = seed >>> 0;
        return () => {
          a = (a + 0x6d2b79f5) >>> 0;
          let t = Math.imul(a ^ (a >>> 15), 1 | a);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      }

      function hashSeed(text) {
        let hash = 2166136261;
        for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
        return hash >>> 0;
      }

      /**
       * Position the graph ONCE, off the render path.
       *
       * Force model equivalent to d3-force's trio (link spring, charge repulsion,
       * centring) with a fixed iteration budget and a deterministic seed. The
       * result is frozen in a ref by the caller, so progressive reveal — which
       * only changes how many frozen coordinates are painted — can never restart
       * the simulation.
       */
      function computeLayout(nodes, edges, width, height) {
        const rand = mulberry32(hashSeed(nodes.map((node) => node.id).join('|')));
        const index = new Map(nodes.map((node, i) => [node.id, i]));
        const count = nodes.length;
        const positions = nodes.map((node, i) => ({
          id: node.id,
          x: width / 2 + (rand() - 0.5) * width * 0.6 + (i % 7) * 2,
          y: height / 2 + (rand() - 0.5) * height * 0.6 + (i % 5) * 2,
          vx: 0,
          vy: 0,
          // Isolated nodes get extra jitter so they cannot sit in a neat pile.
          jitter: (rand() - 0.5) * 24,
        }));

        const links = edges
          .map((edge) => ({ a: index.get(edge.source), b: index.get(edge.target), weight: edge.weight || 1 }))
          .filter((link) => link.a !== undefined && link.b !== undefined);

        const iterations = Math.min(320, 40 + count * 4);
        const repulsion = 900;
        for (let step = 0; step < iterations; step += 1) {
          const alpha = 0.9 * (1 - step / iterations) + 0.02;
          for (let i = 0; i < count; i += 1) {
            for (let j = i + 1; j < count; j += 1) {
              const a = positions[i];
              const b = positions[j];
              let dx = a.x - b.x;
              let dy = a.y - b.y;
              let distance = Math.sqrt(dx * dx + dy * dy);
              if (distance < 1) {
                dx = (rand() - 0.5) * 2;
                dy = (rand() - 0.5) * 2;
                distance = 1;
              }
              const force = (repulsion / (distance * distance)) * alpha;
              const fx = (dx / distance) * force;
              const fy = (dy / distance) * force;
              a.vx += fx;
              a.vy += fy;
              b.vx -= fx;
              b.vy -= fy;
            }
          }
          for (const link of links) {
            const a = positions[link.a];
            const b = positions[link.b];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const distance = Math.sqrt(dx * dx + dy * dy) || 1;
            const target = 80;
            const force = ((distance - target) / distance) * 0.04 * alpha * Math.min(2, link.weight);
            a.vx += dx * force;
            a.vy += dy * force;
            b.vx -= dx * force;
            b.vy -= dy * force;
          }
          for (let i = 0; i < count; i += 1) {
            const node = positions[i];
            node.vx += ((width / 2 - node.x) / width) * 2 * alpha;
            node.vy += ((height / 2 - node.y) / height) * 2 * alpha;
            node.vx *= 0.6;
            node.vy *= 0.6;
            node.x = Math.max(24, Math.min(width - 24, node.x + node.vx + node.jitter * 0.05));
            node.y = Math.max(24, Math.min(height - 24, node.y + node.vy + node.jitter * 0.05));
          }
        }
        return positions;
      }

      function KnowledgeGraph(props) {
        const graph = props.graph;
        const width = 640;
        const height = 320;
        const nodes = (graph && graph.nodes) || [];
        const edges = (graph && graph.edges) || [];

        const layoutRef = React.useRef(null);
        const layoutKey = nodes.length + ':' + edges.length + ':' + (graph ? graph.generatedAt : 0);
        if (!layoutRef.current || layoutRef.current.key !== layoutKey) {
          layoutRef.current = { key: layoutKey, positions: computeLayout(nodes, edges, width, height) };
        }
        const positions = layoutRef.current.positions;
        const byId = new Map(positions.map((position) => [position.id, position]));

        // Progressive reveal paints frozen coordinates only; it never re-runs
        // the layout above, so the graph cannot jump back to the start.
        const [revealed, setRevealed] = React.useState(0);
        React.useEffect(() => {
          setRevealed(0);
          if (nodes.length === 0) return undefined;
          let current = 0;
          const timer = setInterval(() => {
            current = Math.min(nodes.length, current + Math.max(1, Math.ceil(nodes.length / 24)));
            setRevealed(current);
            if (current >= nodes.length) clearInterval(timer);
          }, 70);
          return () => clearInterval(timer);
        }, [layoutKey, nodes.length]);

        const [focus, setFocus] = React.useState(null);
        const maxWeight = Math.max(1, ...nodes.map((node) => node.weight || 0));

        if (nodes.length === 0) {
          return h('div', { style: { ...cardStyle, color: palette.muted, fontSize: 13 } }, '暂无图谱：维护完成后由日志（去墓碑）离线生成。');
        }

        return h(
          'div',
          { style: cardStyle },
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 } },
            h('div', { style: { fontSize: 13, fontWeight: 600 } }, '知识图谱'),
            h('div', { style: { ...labelStyle, marginBottom: 0 } }, `${fmtNumber(graph.nodeCount)} 节点 · ${fmtNumber(graph.edgeCount)} 边${graph.truncated ? '（已截断）' : ''}`),
          ),
          h(
            'svg',
            { width: '100%', viewBox: `0 0 ${width} ${height}`, style: { display: 'block' } },
            // Edges first, and only when BOTH endpoints are painted: no dangling lines.
            edges.map((edge, i) => {
              const a = byId.get(edge.source);
              const b = byId.get(edge.target);
              if (!a || !b) return null;
              const ai = positions.indexOf(a);
              const bi = positions.indexOf(b);
              if (ai >= revealed || bi >= revealed) return null;
              return h('line', {
                key: `e${i}`,
                x1: a.x,
                y1: a.y,
                x2: b.x,
                y2: b.y,
                stroke: palette.border,
                strokeWidth: Math.min(2.5, 0.4 + (edge.weight || 1) * 0.25),
                style: { transition: 'opacity 240ms ease' },
                opacity: 0.8,
              });
            }),
            nodes.map((node, i) => {
              if (i >= revealed) return null;
              const position = positions[i];
              if (!position) return null;
              const radius = 3 + (Math.sqrt((node.weight || 0) / maxWeight) || 0) * 7;
              const core = i < 5;
              const active = focus === node.id;
              return h(
                'g',
                {
                  key: node.id,
                  transform: `translate(${position.x}, ${position.y})`,
                  style: { cursor: 'pointer' },
                  onMouseEnter: () => setFocus(node.id),
                  onMouseLeave: () => setFocus(null),
                  onClick: () => setFocus((prev) => (prev === node.id ? null : node.id)),
                },
                h('circle', { r: radius, fill: active ? palette.accent : 'rgba(79,140,255,0.55)', stroke: palette.border, strokeWidth: 1 }),
                (core || active) && h('text', { x: radius + 4, y: 4, fill: palette.text, style: { fontSize: 10 } }, node.label),
              );
            }),
          ),
          h('div', { style: { ...labelStyle, marginTop: 6, marginBottom: 0 } }, '悬停或点击节点查看标签；核心节点常显。'),
        );
      }

      // ---- panel -------------------------------------------------------------

      function MemoryPanel() {
        const state = useMemoryStats();
        const payload = state.payload;
        const ready = Boolean(payload && payload.ok === true);
        const limit = (payload && payload.config && payload.config.graphMaxEdges) || 500;
        const graphState = useGraph(limit, ready);

        if (!payload || !ready) {
          return h('div', { style: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12 } }, h(PhaseCard, { payload, error: state.error }));
        }

        const panel = payload.panel || {};
        const global = panel.global || {};
        const tokens = panel.tokens || {};
        const storage = panel.storage || {};
        const maintenance = panel.maintenance || {};
        const generations = panel.generations || {};
        const graphInfo = panel.graph || {};

        return h(
          'div',
          { style: { padding: 16, display: 'flex', flexDirection: 'column', gap: 14 } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
            h(
              'div',
              null,
              h('div', { style: { fontSize: 16, fontWeight: 600 } }, '海马体记忆'),
              h('div', { style: { ...labelStyle, marginTop: 2 } }, `${generations.logGen || '—'} · ${generations.indexGen || '—'}`),
            ),
            h(PhaseBadge, { phase: payload.phase }),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 12, flexWrap: 'wrap' } },
            h(StorageRing, { used: storage.diskBytes || 0 }),
            h(
              'div',
              { style: { display: 'flex', flexWrap: 'wrap', gap: 10, flex: '1 1 320px', alignContent: 'flex-start' } },
              h(StatCard, { label: '总记忆数', value: fmtNumber(global.events), hint: '日志内事件' }),
              h(StatCard, { label: '活跃标签', value: fmtNumber(global.activeTags), hint: '常驻活跃集合' }),
              h(StatCard, { label: '累计节省 Token', value: fmtNumber(tokens.cumulativeSavedTokens), hint: `${fmtNumber(tokens.evictedBlocks)} 块已驱逐` }),
              h(StatCard, { label: '图谱', value: `${fmtNumber(graphInfo.nodeCount)} / ${fmtNumber(graphInfo.edgeCount)}`, hint: `上限 ${fmtNumber(graphInfo.limit)} 边` }),
            ),
          ),
          graphState.graph
            ? h(KnowledgeGraph, { graph: graphState.graph })
            : h('div', { style: { ...cardStyle, color: palette.muted, fontSize: 13 } }, graphState.error ? `图谱不可用：${graphState.error.code}` : '正在读取图谱缓存…'),
          h(
            'div',
            { style: cardStyle },
            h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, '维护'),
            h(Row, { label: '上次成功', value: fmtTime(maintenance.lastSuccessAt) }),
            h(Row, { label: '下次预计', value: fmtTime(maintenance.nextRunAt) }),
            h(Row, { label: 'Cron', value: maintenance.maintenanceCron || '—' }),
            h(Row, { label: '图谱生成于', value: fmtTime(graphInfo.generatedAt) }),
          ),
          h('div', { style: { ...labelStyle, marginTop: 2 } }, '数据每 3 秒自动刷新；配置请到 设置 → 海马体记忆。'),
        );
      }

      // ---- settings ----------------------------------------------------------

      function Toggle(props) {
        return h(
          'label',
          { style: { display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 0', cursor: props.disabled ? 'default' : 'pointer' } },
          h('input', {
            type: 'checkbox',
            checked: Boolean(props.checked),
            disabled: Boolean(props.disabled),
            onChange: (event) => props.onChange(event.target.checked),
            style: { marginTop: 2 },
          }),
          h('span', null, h('span', { style: { fontSize: 13 } }, props.label), props.hint ? h('div', { style: { ...labelStyle, marginBottom: 0 } }, props.hint) : null),
        );
      }

      function Field(props) {
        return h(
          'label',
          { style: { display: 'block', padding: '8px 0' } },
          h('div', { style: { fontSize: 13, marginBottom: 4 } }, props.label),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('input', {
              type: 'number',
              value: props.value,
              min: props.min,
              max: props.max,
              step: props.step,
              disabled: Boolean(props.disabled),
              onChange: (event) => props.onChange(Number(event.target.value)),
              style: { width: 140, padding: '6px 8px', borderRadius: 8, border: `1px solid ${palette.border}`, background: 'transparent', color: palette.text },
            }),
            props.suffix ? h('span', { style: { ...labelStyle, marginBottom: 0 } }, props.suffix) : null,
          ),
          props.hint ? h('div', { style: { ...labelStyle, marginTop: 4, marginBottom: 0 } }, props.hint) : null,
        );
      }

      function MemorySettings() {
        const state = useMemoryStats();
        const payload = state.payload;
        const serverConfig = payload && payload.ok === true ? payload.config : null;
        const [draft, setDraft] = React.useState(null);
        const [status, setStatus] = React.useState(null);
        const [saving, setSaving] = React.useState(false);

        React.useEffect(() => {
          if (serverConfig && draft === null) {
            setDraft({ ...serverConfig, context: { ...(serverConfig.context || {}) }, temp: { ...(serverConfig.temp || {}) } });
          }
        }, [serverConfig, draft]);

        if (payload && payload.phase === 'failed') {
          return h('div', { style: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12 } }, h(FailureBanner, { error: payload.error || state.error }));
        }
        if (!serverConfig) return h('div', { style: { padding: 16 } }, h(PhaseCard, { payload, error: state.error }));
        if (!draft) return h('div', { style: { padding: 16, color: palette.muted } }, '读取配置…');

        const edit = (path, value) => {
          setStatus(null);
          setDraft((prev) => {
            const next = { ...prev, context: { ...(prev.context || {}) }, temp: { ...(prev.temp || {}) } };
            if (path.indexOf('.') >= 0) {
              const parts = path.split('.');
              next[parts[0]] = { ...(next[parts[0]] || {}), [parts[1]]: value };
            } else {
              next[path] = value;
            }
            return next;
          });
        };

        const save = async () => {
          setSaving(true);
          setStatus(null);
          const patch = {
            enableDream: Boolean(draft.enableDream),
            enableReflection: Boolean(draft.enableReflection),
            dreamIdleMinutes: Number(draft.dreamIdleMinutes),
            graphMaxEdges: Number(draft.graphMaxEdges),
            'context.maxTokens': Number(draft.context.maxTokens),
            'context.threshold': Number(draft.context.threshold),
            'context.target': Number(draft.context.target),
            'temp.ttlDays': Number(draft.temp.ttlDays),
          };
          try {
            const { body } = await getJson(API.config, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ patch }),
            });
            if (body && body.ok === true) {
              setStatus({ tone: body.persisted ? 'ok' : 'warn', text: body.persisted ? '已保存并生效' : `已生效（未持久化）：${body.note || ''}` });
              setDraft({ ...body.config, context: { ...(body.config.context || {}) }, temp: { ...(body.config.temp || {}) } });
            } else {
              setStatus({ tone: 'error', text: `${(body && body.error && body.error.code) || 'MEM_E_UNKNOWN'}: ${(body && body.error && body.error.message) || '保存失败'}` });
            }
          } catch (error) {
            setStatus({ tone: 'error', text: String((error && error.message) || error) });
          } finally {
            setSaving(false);
          }
        };

        const toneColor = status && status.tone === 'error' ? palette.danger : status && status.tone === 'warn' ? palette.warn : palette.accent;

        return h(
          'div',
          { style: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 640 } },
          h('div', { style: { fontSize: 16, fontWeight: 600 } }, '海马体记忆'),
          h('div', { style: labelStyle }, '保存后立即作用于运行时，并在可持久化时写回 Loader 配置。'),
          h(
            'div',
            { style: cardStyle },
            h(Toggle, {
              label: '空闲时自动整理（Dream）',
              hint: `连续 ${draft.dreamIdleMinutes} 分钟没有记忆工具调用后跑一次维护（与 Cron 共用同一入口）。`,
              checked: draft.enableDream,
              onChange: (value) => edit('enableDream', value),
              disabled: saving,
            }),
            h(Toggle, {
              label: '反思提示（Reflection）',
              hint: '连续工具调用达到阈值后，在提示里追加自我检查。',
              checked: draft.enableReflection,
              onChange: (value) => edit('enableReflection', value),
              disabled: saving,
            }),
            h(Field, {
              label: '空闲判定（分钟）',
              value: draft.dreamIdleMinutes,
              min: 1,
              max: 525600,
              step: 1,
              onChange: (value) => edit('dreamIdleMinutes', value),
              disabled: saving,
            }),
          ),
          h(
            'div',
            { style: cardStyle },
            h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 4 } }, '上下文窗口'),
            h(Field, {
              label: '预算（token）',
              value: draft.context.maxTokens,
              min: 256,
              max: 1000000,
              step: 256,
              onChange: (value) => edit('context.maxTokens', value),
              disabled: saving,
            }),
            h(Field, {
              label: '淘汰阈值',
              hint: '占用超过该比例即开始淘汰，必须大于收敛目标。',
              value: draft.context.threshold,
              min: 0.1,
              max: 0.99,
              step: 0.01,
              onChange: (value) => edit('context.threshold', value),
              disabled: saving,
            }),
            h(Field, {
              label: '收敛目标',
              value: draft.context.target,
              min: 0.05,
              max: 0.98,
              step: 0.01,
              onChange: (value) => edit('context.target', value),
              disabled: saving,
            }),
            h(Field, {
              label: 'L2.5 隔离期',
              value: draft.temp.ttlDays,
              min: 1,
              max: 3650,
              step: 1,
              suffix: '天',
              onChange: (value) => edit('temp.ttlDays', value),
              disabled: saving,
            }),
          ),
          h(
            'div',
            { style: cardStyle },
            h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 4 } }, '知识图谱'),
            h(Field, {
              label: '最大边数',
              hint: '保存后前端按新上限重新拉取 /api/hippocampus/graph 并重绘。',
              value: draft.graphMaxEdges,
              min: 100,
              max: 2000,
              step: 100,
              onChange: (value) => edit('graphMaxEdges', value),
              disabled: saving,
            }),
          ),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 12 } },
            h(
              'button',
              {
                type: 'button',
                onClick: save,
                disabled: saving,
                style: {
                  padding: '7px 16px',
                  borderRadius: 8,
                  border: `1px solid ${palette.accent}`,
                  background: saving ? 'transparent' : palette.accent,
                  color: saving ? '#fff' : '#fff',
                  cursor: saving ? 'default' : 'pointer',
                  fontSize: 13,
                },
              },
              saving ? '保存中…' : '保存',
            ),
            status ? h('span', { style: { fontSize: 12, color: toneColor } }, status.text) : null,
          ),
        );
      }

      return {
        inject: ['slots'],
        apply(ctx) {
          let slots = null;
          try {
            slots = ctx && ctx.slots;
          } catch (error) {
            slots = null;
          }
          if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return;

          const mount = (name, options, component) => {
            try {
              slots.inject(name, () => {
                try {
                  return slots.register({ name, ...options }, component);
                } catch (error) {
                  report(`register ${name}`, error);
                  return undefined;
                }
              });
            } catch (error) {
              report(`inject ${name}`, error);
            }
          };

          mount('sidebar.panellist', { id: 'hippocampus-panel', order: 60, label: '海马体记忆' }, MemoryIcon);
          mount('main', { key: 'hippocampus-panel' }, MemoryPanel);
          mount('settings.section', { id: 'hippocampus-settings', order: 25, label: '海马体记忆' }, MemorySettings);
        },
      };
    },
  });

  function report(where, error) {
    try {
      if (typeof console !== 'undefined' && console.error) console.error(`[hippocampus] ${where} failed:`, error);
    } catch (ignored) {
      // console itself unavailable — nothing left to do.
    }
  }
})();
