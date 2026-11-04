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
        transfer: '/api/hippocampus/transfer',
        // Per-memory projection: the human-initiated 移动到… entry point.
        memories: '/api/hippocampus/memories',
        // Global SpaceSelector: list/create the physical spaces.
        spaces: '/api/hippocampus/spaces',
        // Escape hatch: reset a wedged rollover/handoff state.
        sessionReset: '/api/hippocampus/session/reset',
      };
      const POLL_MS = 3000;
      /** Fallback ring budget (MB) when the Host has not sent the config yet. */
      const DEFAULT_BUDGET_MB = 50;

      /**
       * Panel ↔ settings bus. Saving the form must refresh the panel *now*, not
       * on the next 3s poll — and the two components are separate slot entries,
       * so they cannot share React state.
       */
      const bus = new EventTarget();
      const announce = (type) => {
        try {
          bus.dispatchEvent(new Event(type));
        } catch {
          // An event with no listeners must never break the caller.
        }
      };

      // ---- global active space (SpaceSelector) ------------------------------
      //
      // The SELECTED space is app-global state: the panel slot and the settings
      // slot are separate registrations and cannot share React state, so one
      // module-level store + the bus is the single source of truth. Every read
      // hook appends `?space=<id>` and the backend routes the request to that
      // physical store (routing isolation), so no view can blend two spaces.
      const spaceStore = { current: 'default' };
      const DEFAULT_SPACE_ID = 'default';
      function getActiveSpace() {
        return spaceStore.current || DEFAULT_SPACE_ID;
      }
      function setActiveSpace(spaceId) {
        const next = typeof spaceId === 'string' && spaceId.trim() ? spaceId.trim() : DEFAULT_SPACE_ID;
        if (next === spaceStore.current) return;
        spaceStore.current = next;
        announce('space-changed');
      }
      /** Friendly label for the selector; unknown ids stay verbatim (no invention). */
      function spaceLabel(spaceId) {
        const id = String(spaceId ?? '');
        if (id === DEFAULT_SPACE_ID) return '默认空间';
        if (id === 'work' || id === 'workspace') return '工作空间';
        if (id === 'private' || id === 'personal') return '私人空间';
        if (id === 'global') return '全局空间';
        return id;
      }

      /**
       * Client mirror of the server's dataDir Fail-Fast rules. The server remains
       * the authority (it throws MEM_E_MIGRATION_PATH / MEM_E_MIGRATION_TARGET_BUSY);
       * this only stops an obviously invalid submit before the request. Physical
       * storage migration is COMPLETELY separate from business-data transfer: no
       * event ids, no copy/cut here.
       */
      function migrationPathProblem({ from, to } = {}) {
        const target = typeof to === 'string' ? to.trim() : '';
        if (!target) return '目标路径不能为空';
        const absolute = /^([A-Za-z]:[\\/]|\\\\|\/)/.test(target);
        if (!absolute) return '必须是绝对路径（例如 D:\\dsh-memory-data）';
        const norm = (value) => value.replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase();
        const source = norm(String(from ?? ''));
        const next = norm(target);
        if (source && next === source) return '目标不能等于当前数据目录';
        if (source && next.startsWith(source + '\\')) return '目标不能位于当前数据目录内部';
        if (/^[a-z]:\\?$/.test(next)) return '不能使用磁盘根目录';
        return null;
      }

      /** Routes the active space into every read route (stats/graph/memories). */
      function withSpace(url) {
        const id = getActiveSpace();
        return `${url}${url.includes('?') ? '&' : '?'}space=${encodeURIComponent(id)}`;
      }

      // ---- space creation: capability handshake + human-readable failures ----
      //
      // Root cause of the field incident (`MEM_E_SPACES: HTTP 404`): a NEW client
      // bundle talked to an OLD host process that did not serve /spaces yet. Two
      // defences, BOTH in code:
      //   1. capability handshake from /stats.capabilities.spaces -> do not call a
      //      route the host does not advertise (prevents the 404 entirely);
      //   2. if it still happens (stale cache, proxy, old host with no capability
      //      field), map the failure to human copy — a raw "HTTP 404" NEVER
      //      reaches the user.
      const CLIENT_SPACE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

      /** { available, reason } from the stats payload's capability handshake. */
      function spaceCreateAvailable(payload) {
        const caps = payload && payload.capabilities;
        if (!caps || typeof caps !== 'object' || caps.spaces !== true) {
          return {
            available: false,
            reason: '当前宿主版本不支持新建空间（旧版本或未重载插件）。请重启 DSH 后重试；创建功能需要新版宿主半边路由。',
          };
        }
        return { available: true, reason: null };
      }

      /**
       * v1.5.6: DELETE is a versioned sub-capability. An old host advertises
       * spaces:true but has no delete route, so the button must stay hidden — sending
       * the request to an old host is what produced the misleading "空间已存在".
       */
      function spaceDeleteAvailable(payload) {
        const caps = payload && payload.capabilities;
        return Boolean(caps && typeof caps === 'object' && caps.spaces === true && caps.spacesDelete === true);
      }

      /**
       * The ONE user-facing error mapper for space operations. Every branch returns
       * a complete sentence; codes are diagnostics, never the visible message.
       */
      function describeSpaceError(error, httpStatus, operation = 'create') {
        const prefix = operation === 'delete' ? '删除失败：' : '创建失败：';
        const code = (error && error.code) || '';
        const message = (error && error.message) || '';
        if (code === 'MEM_E_SPACE_INVALID') {
          const details = (error && error.details) || {};
          if (details.reason === 'conflict') return `${prefix}空间「${details.spaceId ?? ''}」已存在，请换一个名称`;
          if (details.reason === 'reserved') {
            return operation === 'delete' ? `${prefix}该空间不可删除或名称属于系统保留` : `${prefix}该名称是系统保留名，请换一个`;
          }
          // No raw English validator text either: the server message is diagnostics.
          return `${prefix}空间名称无效——需以小写字母/数字开头，只能含 a-z 0-9 . _ -（最长 64）`;
        }
        if (code === 'MEM_E_NOT_FOUND') return `${prefix}空间不存在或已被删除`;
        if (code === 'MEM_E_FEATURE_DISABLED') return `${prefix}当前宿主未启用多空间（需安装 dsh-orchestrator）`;
        if (code === 'MEM_E_NOT_READY') return `${prefix}记忆引擎尚未就绪，请稍后重试`;
        if (code === 'MEM_E_REQUIRE_USER_CONSENT') return `${prefix}该操作需要用户明确授权`;
        // Route missing / version mismatch / transport failure: friendly fallback,
        // never the raw `MEM_E_SPACES: HTTP 404`.
        if (
          httpStatus === 404 ||
          code === 'MEM_E_SPACES' ||
          code === 'MEM_E_NETWORK' ||
          /HTTP\s*404/i.test(message) ||
          /not found/i.test(message)
        ) {
          return `${prefix}底层引擎未响应，请检查版本或联系架构师`;
        }
        return `${prefix}${message || '未知错误'}，请稍后重试或联系架构师`;
      }

      /** Subscribe to the global space selector; returns the selected id. */
      function useActiveSpace() {
        const [space, setSpace] = React.useState(getActiveSpace());
        React.useEffect(() => {
          const onChange = () => setSpace(getActiveSpace());
          bus.addEventListener('space-changed', onChange);
          return () => bus.removeEventListener('space-changed', onChange);
        }, []);
        return space;
      }

      // ---- data --------------------------------------------------------------

      async function getJson(url, init) {
        const response = await fetch(url, { credentials: 'same-origin', ...init });
        let body = null;
        let hasJson = false;
        try {
          body = await response.json();
          hasJson = true;
        } catch (error) {
          // A 404 from the Host router has NO body: keep it distinguishable from
          // a JSON error, otherwise the retry policy cannot tell "route not
          // mounted yet" from "protocol violation".
          body = null;
          hasJson = false;
        }
        return { status: response.status, body, hasJson };
      }

      /** Explicit `failed` budget: after this many short retries the UI asks the human. */
      const FAILED_RETRIES = 5;
      /** A bodiless 404 is retried until this deadline (10 minutes), then it fails. */
      const BOOT_MAX_WAIT_MS = 10 * 60_000;
      const BACKOFF_CAP_MS = 5000;
      const FAILED_DELAY_MS = 1200;

      /**
       * The ONE retry decision, pure so it can be unit-tested. It never looks at
       * the HTTP status: `state` is the protocol. A bodiless response (404 from
       * the Host before the plugin's routes are mounted) is treated as "booting"
       * with exponential backoff up to BOOT_MAX_WAIT_MS — never as a hard error
       * after a handful of tries, which is exactly the bug this replaces.
       */
      function decideRetry({ hasJson, state, status, miss, elapsedMs }) {
        if (hasJson && state === 'ready') {
          return { kind: 'ready', delay: POLL_MS, miss: 0, attempts: 0 };
        }
        if (!hasJson || state === undefined || state === null) {
          if (elapsedMs >= BOOT_MAX_WAIT_MS) {
            return {
              kind: 'failed',
              delay: 0,
              miss,
              attempts: miss,
              gaveUp: true,
              error: {
                code: 'MEM_E_BOOT_TIMEOUT',
                message: `路由在 ${Math.round(elapsedMs / 1000)}s 内仍未就绪（最后一次 HTTP ${status}）`,
              },
            };
          }
          const nextMiss = miss + 1;
          return {
            kind: 'pending',
            delay: Math.min(1000 * 2 ** Math.min(nextMiss - 1, 3), BACKOFF_CAP_MS),
            miss: nextMiss,
            attempts: nextMiss,
          };
        }
        if (state === 'migrating') {
          // Background data-dir migration: long wait; the panel renders progress.
          return { kind: 'pending', delay: 1500, miss: 0, attempts: 0, migrating: true };
        }
        if (state === 'pending' || state === 'in_progress') {
          return { kind: 'pending', delay: 2000, miss: 0, attempts: 0 };
        }
        if (state === 'failed') {
          const nextMiss = miss + 1;
          const gaveUp = nextMiss >= FAILED_RETRIES;
          return { kind: 'failed', delay: gaveUp ? 0 : FAILED_DELAY_MS, miss: nextMiss, gaveUp, attempts: nextMiss };
        }
        // Unknown state: do not spin, do not die — keep booting with backoff.
        const nextMiss = miss + 1;
        return {
          kind: 'pending',
          delay: Math.min(1000 * 2 ** Math.min(nextMiss - 1, 3), BACKOFF_CAP_MS),
          miss: nextMiss,
          attempts: nextMiss,
        };
      }

      /**
       * The handshake consumer. Reads /stats, hands the raw shape to decideRetry,
       * and mirrors the decision into UI state. No HTTP status branching here.
       */
      function useMemoryStats(spaceId = DEFAULT_SPACE_ID) {
        const [state, setState] = React.useState({
          loading: true,
          payload: null,
          error: null,
          state: 'pending',
          gaveUp: false,
          attempts: 0,
        });
        const bootAtRef = React.useRef(Date.now());
        // Tracks the served dataDir: a background migration changes it without a
        // config POST, so the settings page and graph must be told to refetch.
        const dataDirRef = React.useRef(null);

        React.useEffect(() => {
          let alive = true;
          let inFlight = false;
          let miss = 0;
          let timer = null;

          const schedule = (ms) => {
            if (!alive) return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(tick, ms);
          };

          const tick = async () => {
            if (!alive || inFlight) return;
            inFlight = true;
            let nextDelay = POLL_MS;
            try {
              const { status, body, hasJson } = await getJson(`${API.stats}?space=${encodeURIComponent(spaceId || DEFAULT_SPACE_ID)}`);
              if (!alive) return;
              const decision = decideRetry({
                hasJson,
                state: body && body.state,
                status,
                miss,
                elapsedMs: Date.now() - bootAtRef.current,
              });
              miss = decision.miss;
              if (decision.kind === 'ready') {
                const servedDir = (body && body.config && body.config.dataDir) || null;
                if (dataDirRef.current !== null && servedDir !== dataDirRef.current) {
                  // Migration finished in the background: refresh config + graph.
                  announce('config-changed');
                }
                dataDirRef.current = servedDir;
                setState({ loading: false, payload: body, error: null, state: 'ready', gaveUp: false, attempts: 0 });
              } else if (decision.kind === 'pending') {
                const reported = hasJson && body.state ? body.state : 'pending';
                setState((prev) => ({
                  loading: false,
                  payload: hasJson ? body : prev.payload,
                  error: null,
                  state: reported,
                  gaveUp: false,
                  attempts: decision.attempts,
                }));
              } else {
                setState({
                  loading: false,
                  payload: hasJson ? body : null,
                  error: decision.error || (body && body.error) || { code: 'MEM_E_NETWORK', message: `HTTP ${status}` },
                  state: 'failed',
                  gaveUp: decision.gaveUp === true,
                  attempts: decision.attempts,
                });
              }
              nextDelay = decision.delay;
            } catch (error) {
              if (!alive) return;
              const elapsedMs = Date.now() - bootAtRef.current;
              if (elapsedMs < BOOT_MAX_WAIT_MS) {
                miss += 1;
                setState((prev) => ({ ...prev, loading: false, state: 'pending', gaveUp: false, attempts: miss, error: null }));
                nextDelay = Math.min(1000 * 2 ** Math.min(miss - 1, 3), BACKOFF_CAP_MS);
              } else {
                setState({
                  loading: false,
                  payload: null,
                  error: { code: 'MEM_E_NETWORK', message: String((error && error.message) || error) },
                  state: 'failed',
                  gaveUp: true,
                  attempts: miss,
                });
                nextDelay = 0;
              }
            } finally {
              inFlight = false;
              if (alive && nextDelay > 0) schedule(nextDelay);
            }
          };

          const reconnect = () => {
            bootAtRef.current = Date.now();
            miss = 0;
            setState((prev) => ({ ...prev, gaveUp: false, attempts: 0, state: 'pending', error: null }));
            tick();
          };
          const onConfig = () => tick();

          tick();
          bus.addEventListener('config-changed', onConfig);
          bus.addEventListener('reconnect', reconnect);
          return () => {
            alive = false;
            if (timer) clearTimeout(timer);
            bus.removeEventListener('config-changed', onConfig);
            bus.removeEventListener('reconnect', reconnect);
          };
        }, [spaceId]);

        return state;
      }

      /**
       * Graph fetch keyed by the configured edge ceiling: when the setting
       * changes, the next render fetches with the new limit and redraws. A
       * `config-changed` event refetches immediately with the current limit.
       */
      function useGraph(limit, available, spaceId = DEFAULT_SPACE_ID) {
        const [state, setState] = React.useState({ graph: null, tagTree: null, error: null, limit: null });

        React.useEffect(() => {
          if (!available) return undefined;
          let alive = true;
          const load = () => {
            getJson(`${API.graph}?limit=${encodeURIComponent(limit)}&space=${encodeURIComponent(spaceId || DEFAULT_SPACE_ID)}`)
              .then(({ body }) => {
                if (!alive) return;
                if (body && body.ok && body.graph) {
                  setState({ graph: body.graph, tagTree: body.tagTree || null, error: null, limit });
                } else {
                  setState((prev) => ({ ...prev, error: (body && body.error) || { code: 'MEM_E_GRAPH', message: 'graph unavailable' }, limit }));
                }
              })
              .catch((error) => {
                if (alive) setState((prev) => ({ ...prev, error: { code: 'MEM_E_NETWORK', message: String(error) }, limit }));
              });
          };
          setState((prev) => ({ ...prev, error: null }));
          load();
          bus.addEventListener('config-changed', load);
          return () => {
            alive = false;
            bus.removeEventListener('config-changed', load);
          };
        }, [limit, available, spaceId]);

        return state;
      }

      /**
       * Recent-memory list for the panel's per-memory detail rows. This is the
       * HUMAN path: a person checks rows and uses 移动到… (the transfer dialog),
       * which talks straight to the transfer route and never asks the model; AI
       * self-initiated calls are blocked by the engine consent gate.
       */
      function useRecentMemories(available, spaceId = DEFAULT_SPACE_ID, supported = true) {
        const [state, setState] = React.useState({ items: [], error: null, unsupported: false });

        React.useEffect(() => {
          if (!available) return undefined;
          if (!supported) {
            // Capability handshake: an old host does not serve /memories. Do not
            // fire a request that would 404 — report "unsupported" so the panel
            // shows a version hint instead of a raw error code.
            setState({ items: [], error: null, unsupported: true });
            return undefined;
          }
          let alive = true;
          const load = () => {
            getJson(`${API.memories}?limit=20&space=${encodeURIComponent(spaceId || DEFAULT_SPACE_ID)}`)
              .then(({ body }) => {
                if (!alive) return;
                if (body && body.ok && Array.isArray(body.events)) {
                  setState({ items: body.events, error: null, unsupported: false });
                } else {
                  setState({ items: [], error: (body && body.error) || { code: 'MEM_E_MEMORIES', message: 'memories unavailable' }, unsupported: false });
                }
              })
              .catch((error) => {
                if (alive) setState({ items: [], error: { code: 'MEM_E_NETWORK', message: String(error) }, unsupported: false });
              });
          };
          load();
          bus.addEventListener('config-changed', load);
          bus.addEventListener('space-changed', load);
          return () => {
            alive = false;
            bus.removeEventListener('config-changed', load);
            bus.removeEventListener('space-changed', load);
          };
        }, [available, spaceId, supported]);

        return state;
      }

      /**
       * Config comes from its own route, not from /stats: GET /config answers
       * before READY, so the settings form is populated during startup while a
       * POST is still refused with MEM_E_NOT_READY.
       */
      function useConfig() {
        const [state, setState] = React.useState({ config: null, state: 'pending', error: null });

        React.useEffect(() => {
          let alive = true;
          const load = () => {
            getJson(API.config)
              .then(({ status, body }) => {
                if (!alive) return;
                if (body && body.config) {
                  setState({ config: body.config, state: body.state || 'pending', error: null });
                } else {
                  setState((prev) => ({
                    ...prev,
                    state: body && body.state ? body.state : prev.state,
                    error: (body && body.error) || { code: 'MEM_E_NETWORK', message: `HTTP ${status}` },
                  }));
                }
              })
              .catch((error) => {
                if (alive) setState((prev) => ({ ...prev, error: { code: 'MEM_E_NETWORK', message: String(error) } }));
              });
          };
          load();
          // A background migration swaps dataDir without a POST from this page;
          // poll so the form (address field, raw limits) converges on the truth.
          const timer = setInterval(load, 3000);
          bus.addEventListener('config-changed', load);
          return () => {
            alive = false;
            clearInterval(timer);
            bus.removeEventListener('config-changed', load);
          };
        }, []);

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

      // ---- pure session / graph / space helpers ------------------------------
      //
      // These are exported from the module object so the bundle-contract tests can
      // exercise them without a DOM. They are also the ONLY place the panel does
      // arithmetic: the render path formats, it does not compute.

      /**
       * Header status bar text.
       *
       * The subtraction is `nativeTokenLimit * threshold - tokens`, not
       * `context.maxTokens`: `maxTokens` is the layered budget, while the count
       * the operator needs is the distance to the *native* handoff point. Keeping
       * this pure means an older host half that sends no `panel.session` still
       * renders a truthful zero instead of blanking the bar.
       */
      function statusBarText(sessionPanel) {
        const session = sessionPanel && typeof sessionPanel === 'object' ? sessionPanel : {};
        // A handoff already happened: the summary lives in L1.5, so there is no
        // "trigger point" left to count down to.
        if (session.handoffActive === true || session.rolloverActive === true) {
          return '[当前: 已交接 | 摘要已存为 L1.5]';
        }
        const tokens = Number(session.tokens);
        const limit = Number(session.nativeTokenLimit);
        const threshold = Number(session.threshold);
        const fallback = (Number.isFinite(limit) ? limit : 0) * (Number.isFinite(threshold) ? threshold : 0) - (Number.isFinite(tokens) ? tokens : 0);
        const explicit = session.remainingTokens;
        const remaining = explicit === undefined || explicit === null || !Number.isFinite(Number(explicit)) ? fallback : Number(explicit);
        const n = Math.max(0, Math.round(remaining) || 0);
        // Two literal forms (not a shared template): the exact strings are part of
        // the operator-facing contract the tests lock.
        if (session.mode === 'layered') return `[当前: 分层折叠 | 剩余 ${n} Tokens 触发交接]`;
        return `[当前: 原生模式 | 剩余 ${n} Tokens 触发交接]`;
      }

      /**
       * Graph filtered by a tag/path query, purely on the client.
       *
       * With no query this returns the SAME node/edge arrays (only the wrapper is
       * new), so the force layout's identity-based memo is not invalidated just
       * because the search box exists. Edges survive only when BOTH endpoints
       * survive: a dangling line would be a lie about connectivity.
       */
      function filterGraphByQuery(graph, query) {
        const safeGraph = graph && typeof graph === 'object' ? graph : null;
        const nodes = Array.isArray(safeGraph?.nodes) ? safeGraph.nodes : [];
        const edges = Array.isArray(safeGraph?.edges) ? safeGraph.edges : [];
        const needle = String(query ?? '').trim().toLowerCase();
        if (needle === '') {
          return safeGraph ? { ...safeGraph, nodes, edges, totalEdges: edges.length } : { nodes: [], edges: [], totalEdges: 0 };
        }
        if (!safeGraph) return { nodes: [], edges: [], totalEdges: 0 };
        const matches = (node) => {
          if (!node || typeof node !== 'object') return false;
          for (const field of [node.label, node.path, node.id]) {
            if (typeof field === 'string' && field.toLowerCase().includes(needle)) return true;
          }
          return false;
        };
        const keptNodes = nodes.filter(matches);
        const keptIds = new Set(keptNodes.map((node) => node.id));
        const keptEdges = edges.filter((edge) => edge && keptIds.has(edge.source) && keptIds.has(edge.target));
        return {
          ...safeGraph,
          nodes: keptNodes,
          edges: keptEdges,
          nodeCount: keptNodes.length,
          edgeCount: keptEdges.length,
          totalEdges: keptEdges.length,
        };
      }

      /**
       * The displayed-space decision after a successful transfer.
       *
       * Soft follow is opt-in (`context.autoSpaceFollow`): a failed transfer or a
       * missing target must leave the view exactly where the operator put it.
       */
      function nextSpaceAfterTransfer(meta) {
        const options = meta && typeof meta === 'object' ? meta : {};
        if (
          options.autoSpaceFollow === true &&
          options.ok === true &&
          typeof options.targetSpaceId === 'string' &&
          options.targetSpaceId.trim() !== ''
        ) {
          return options.targetSpaceId;
        }
        return options.currentSpace;
      }

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
            // Retry asks the engine to re-run bootstrap; the reconnect event
            // re-arms the poll even if the Host half itself is not mounted yet.
            const { status, body } = await getJson(API.retry, { method: 'POST' });
            setResult({ ok: status === 202 && body && body.ok !== false, text: (body && (body.message || body.code)) || `HTTP ${status}` });
          } catch (error) {
            setResult({ ok: false, text: String((error && error.message) || error) });
          } finally {
            setBusy(false);
            announce('reconnect');
          }
        };

        const reconnect = () => {
          announce('reconnect');
        };

        return h(
          'div',
          { style: { ...cardStyle, borderColor: palette.danger, display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between' } },
          h(
            'div',
            null,
            h('div', { style: { fontWeight: 600, marginBottom: 4, color: palette.danger } }, '记忆库启动失败'),
            h('div', { style: { fontSize: 13 } }, `${failure.code || 'MEM_E_UNKNOWN'}: ${failure.message || '未知错误'}`),
            props.attempts ? h('div', { style: { ...labelStyle, marginTop: 4, marginBottom: 0 } }, `已自动重试 ${props.attempts} 次`) : null,
            result ? h('div', { style: { ...labelStyle, marginTop: 4, marginBottom: 0 } }, result.text) : null,
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 8 } },
            h(
              'button',
              {
                type: 'button',
                onClick: reconnect,
                style: {
                  padding: '6px 14px',
                  borderRadius: 8,
                  border: `1px solid ${palette.border}`,
                  background: 'transparent',
                  color: palette.text,
                  cursor: 'pointer',
                  fontSize: 13,
                  whiteSpace: 'nowrap',
                },
              },
              '重新连接',
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
            ),
          );
      }

      function PhaseCard(props) {
        const payload = props.payload;
        const shell = props.shellState || (payload && payload.state) || 'pending';
        if (shell === 'failed') {
          return h(FailureBanner, { error: payload?.error || props.error, attempts: props.attempts, gaveUp: props.gaveUp });
        }
        const spinning = shell === 'pending' || shell === 'in_progress' || props.loading;
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
                animation: spinning ? undefined : 'none',
              },
            }),
            shell === 'in_progress' ? '正在迁移/加载索引…' : '正在启动…',
          ),
          h('div', { style: { ...labelStyle, marginTop: 8 } }, '启动在后台进行，检索就绪后本卡片会自动刷新。'),
          props.error
            ? h('div', { style: { ...labelStyle, marginTop: 4, marginBottom: 0 } }, `${props.error.code || 'MEM_E_NETWORK'}: ${props.error.message || ''}`)
            : null,
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
        const budget = props.budget || DEFAULT_BUDGET_MB * 1024 * 1024;
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

      /**
       * v1.5.6: initial overlap separation. The force pass can leave a pair (or a
       * tight cluster) closer than a readable node, especially with equal weights.
       * One deterministic post-pass pushes every pair below `minDistance` apart
       * without re-running the simulation, so the first painted frame is already
       * readable instead of a pile of labels.
       */
      function separateOverlaps(positions, { minDistance = 56, passes = 14 } = {}) {
        for (let pass = 0; pass < passes; pass += 1) {
          let moved = false;
          for (let i = 0; i < positions.length; i += 1) {
            for (let j = i + 1; j < positions.length; j += 1) {
              const a = positions[i];
              const b = positions[j];
              const dx = a.x - b.x;
              const dy = a.y - b.y;
              const distance = Math.sqrt(dx * dx + dy * dy);
              if (distance >= minDistance) continue;
              const push = (minDistance - distance) / 2 + 0.5;
              const angle = distance > 0.001 ? Math.atan2(dy, dx) : ((i * 37 + j * 17) % 628) / 100;
              const ux = Math.cos(angle);
              const uy = Math.sin(angle);
              a.x += ux * push;
              a.y += uy * push;
              b.x -= ux * push;
              b.y -= uy * push;
              moved = true;
            }
          }
          if (!moved) break;
        }
        return positions;
      }

      /**
       * Force graph with drag.
       *
       * The layout is computed once and frozen into `layoutRef`; dragging then
       * mutates those frozen coordinates and paints the DOM directly through
       * refs. No `setState` runs during a drag: React re-renders (the 3s stats
       * poll) reuse the same mutated coordinates, so the picture cannot jump.
       * On release the node is unpinned and a short local alpha relaxation runs
       * over its 1-hop neighbourhood — again writing straight to the DOM.
       */
      /** Header pill button: the active/history switch. */
      const toggleStyle = (active) => ({
        padding: '2px 9px',
        borderRadius: 999,
        border: `1px solid ${active ? palette.accent : palette.border}`,
        background: active ? 'rgba(79,140,255,0.14)' : 'transparent',
        color: active ? palette.accent : palette.muted,
        fontSize: 11,
        cursor: 'pointer',
      });

      /**
       * Pure ghost-graph projection for the history view.
       *
       * `ghosts` is the tag tree's grace list (`{id, name, parentId, graceUntil}`).
       * Each ghost becomes a translucent node under a synthetic root anchor, so the
       * picture answers "this branch is fading" without touching the live graph.
       * Exported for the bundle-contract tests: the component itself cannot render
       * in Node, and this is the only geometry decision worth locking.
       */
      function ghostGraphParts(ghosts) {
        const rootNodes = new Map();
        const nodes = [];
        const edges = [];
        for (const ghost of Array.isArray(ghosts) ? ghosts : []) {
          if (!ghost || typeof ghost.name !== 'string') continue;
          const rootName = typeof ghost.parentId === 'string' ? ghost.parentId.replace(/^root:/, '') : 'history';
          const rootId = 'ghostroot:' + rootName;
          if (!rootNodes.has(rootId)) rootNodes.set(rootId, { id: rootId, label: rootName, ghostRoot: true, weight: 0.4, events: 0 });
          const ghostId = 'ghost:' + (typeof ghost.id === 'string' ? ghost.id : ghost.name);
          nodes.push({
            id: ghostId,
            label: ghost.name,
            ghost: true,
            weight: 0.2,
            events: 0,
            graceUntil: Number.isFinite(ghost.graceUntil) ? ghost.graceUntil : null,
            path: typeof ghost.parentId === 'string' ? rootName + '/' + ghost.name : ghost.name,
          });
          edges.push({ source: rootId, target: ghostId, weight: 0.5, ghost: true });
        }
        return { rootNodes: [...rootNodes.values()], nodes, edges };
      }

      /**
       * Tag search box above the graph.
       *
       * WHY no timer: the Host's native `Enter` keydown is the trigger. A delay
       * (or a `setTimeout` edge) would race the host — the query could paint after
       * a later keystroke already changed it, or the graph could re-layout while
       * the operator is still typing. One keydown, one committed query, no timer.
       * The input stays controlled locally so typing never touches the graph.
       */
      function TagSearch(props) {
        return h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h(
            'div',
            { style: { ...labelStyle, marginBottom: 0 } },
            '标签检索',
          ),
          h('input', {
            type: 'text',
            value: props.value,
            placeholder: '输入标签或路径后按回车（Enter）',
            onChange: (event) => props.onChange(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                // Native Enter is the ONLY trigger: no cached delay, no backoff.
                event.preventDefault?.();
                props.onSubmit(event.currentTarget?.value ?? props.value);
              }
            },
            style: {
              flex: '1 1 240px',
              maxWidth: 360,
              padding: '6px 10px',
              borderRadius: 8,
              border: `1px solid ${palette.border}`,
              background: 'transparent',
              color: palette.text,
              fontSize: 13,
            },
          }),
          props.value
            ? h(
                'button',
                {
                  type: 'button',
                  onClick: () => props.onChange(''),
                  style: { ...toggleStyle(false), fontSize: 12 },
                },
                '清空',
              )
            : null,
        );
      }

      function KnowledgeGraph(props) {
        const graph = props.graph;
        const width = 640;
        const height = 320;
        const nodes = (graph && graph.nodes) || [];
        const edges = (graph && graph.edges) || [];
        // Ghost nodes come from the tag tree's grace window (state/tag-tree.json via
        // the graph route). They are laid out WITH the live graph but painted with
        // opacity 0 until "历史全貌" is on — a fade, never a re-layout jump.
        const ghosts = Array.isArray(props.ghosts) ? props.ghosts : [];
        const [history, setHistory] = React.useState(false);
        const ghostParts = ghostGraphParts(ghosts);
        const ghostRootNodes = ghostParts.rootNodes;
        const ghostNodes = ghostParts.nodes;
        const ghostEdges = ghostParts.edges;
        const allNodes = [...nodes, ...ghostRootNodes, ...ghostNodes];
        const allEdges = [...edges, ...ghostEdges];

        const layoutRef = React.useRef(null);
        const layoutKey =
          allNodes.length + ':' + allEdges.length + ':' + (graph ? graph.generatedAt : 0) + ':' + ghostNodes.map((node) => node.id).join(',');
        if (!layoutRef.current || layoutRef.current.key !== layoutKey) {
          layoutRef.current = { key: layoutKey, positions: separateOverlaps(computeLayout(allNodes, allEdges, width, height)) };
        }
        const positions = layoutRef.current.positions;
        const byId = new Map(positions.map((position) => [position.id, position]));
        const indexOfId = new Map(positions.map((position, i) => [position.id, i]));

        // ---- DOM handles: dragging must not go through React -----------------
        const svgRef = React.useRef(null);
        const nodeEls = React.useRef([]);
        const lineEls = React.useRef([]);
        const dragRef = React.useRef(null);
        const rafRef = React.useRef(0);
        const aliveRef = React.useRef(true);
        // v1.5.6: viewport transform (Ctrl+drag pan / Ctrl+wheel zoom). Kept in a ref
        // and applied to a <g> imperatively, so panning never re-renders the graph.
        const groupRef = React.useRef(null);
        const viewRef = React.useRef({ x: 0, y: 0, k: 1 });
        const panRef = React.useRef(null);
        const applyView = () => {
          const g = groupRef.current;
          if (!g) return;
          const v = viewRef.current;
          g.setAttribute('transform', `translate(${v.x}, ${v.y}) scale(${v.k})`);
        };
        const resetView = () => {
          viewRef.current = { x: 0, y: 0, k: 1 };
          applyView();
        };

        React.useEffect(() => {
          aliveRef.current = true;
          // Fallback for engines where pointer capture on an SVG child fails:
          // releasing outside the SVG must still end the drag (and must never
          // leave a node pinned forever).
          const onWindowUp = (evt) => {
            if (panRef.current) panRef.current = null;
            const drag = dragRef.current;
            if (!drag || drag.pointerId !== evt.pointerId) return;
            dragRef.current = null;
            const position = positions[drag.index];
            if (position) position.pinned = false;
            if (drag.moved) relaxAround(drag.id);
          };
          if (typeof window !== 'undefined' && window.addEventListener) {
            window.addEventListener('pointerup', onWindowUp);
            window.addEventListener('pointercancel', onWindowUp);
          }
          return () => {
            aliveRef.current = false;
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            if (typeof window !== 'undefined' && window.removeEventListener) {
              window.removeEventListener('pointerup', onWindowUp);
              window.removeEventListener('pointercancel', onWindowUp);
            }
          };
        }, []);

        // v1.5.6: native wheel listener (passive:false) so Ctrl+wheel can zoom the
        // graph without the page scrolling. Plain wheel keeps the page behaviour.
        React.useEffect(() => {
          const svg = svgRef.current;
          if (!svg || typeof svg.addEventListener !== 'function') return undefined;
          const onWheel = (evt) => {
            if (!(evt.ctrlKey || evt.metaKey)) return;
            evt.preventDefault();
            zoomAt(evt);
          };
          svg.addEventListener('wheel', onWheel, { passive: false });
          return () => svg.removeEventListener('wheel', onWheel);
        }, []);

        // Progressive reveal paints frozen coordinates only; it never re-runs
        // the layout above, so the graph cannot jump back to the start.
        const [revealed, setRevealed] = React.useState(0);
        React.useEffect(() => {
          setRevealed(0);
          if (allNodes.length === 0) return undefined;
          let current = 0;
          const timer = setInterval(() => {
            current = Math.min(allNodes.length, current + Math.max(1, Math.ceil(allNodes.length / 24)));
            setRevealed(current);
            if (current >= allNodes.length) clearInterval(timer);
          }, 70);
          return () => clearInterval(timer);
        }, [layoutKey, allNodes.length]);

        const [focus, setFocus] = React.useState(null);
        const maxWeight = Math.max(1, ...allNodes.map((node) => node.weight || 0));

        /** Repaint node transforms + every rendered line from the frozen array. */
        const paint = () => {
          for (let i = 0; i < positions.length; i += 1) {
            const el = nodeEls.current[i];
            if (el) el.setAttribute('transform', `translate(${positions[i].x}, ${positions[i].y})`);
          }
          for (let i = 0; i < allEdges.length; i += 1) {
            const el = lineEls.current[i];
            if (!el) continue;
            const a = byId.get(allEdges[i].source);
            const b = byId.get(allEdges[i].target);
            if (!a || !b) continue;
            el.setAttribute('x1', a.x);
            el.setAttribute('y1', a.y);
            el.setAttribute('x2', b.x);
            el.setAttribute('y2', b.y);
          }
        };

        /** Client point -> viewBox point (before pan/zoom), so a drag tracks the cursor exactly. */
        const toView = (evt) => {
          const svg = svgRef.current;
          if (!svg) return { x: 0, y: 0 };
          const rect = svg.getBoundingClientRect();
          const scaleX = rect.width ? width / rect.width : 1;
          const scaleY = rect.height ? height / rect.height : 1;
          return { x: (evt.clientX - rect.left) * scaleX, y: (evt.clientY - rect.top) * scaleY };
        };

        /** Client point -> graph coordinates (viewBox point through the pan/zoom transform). */
        const toSvg = (evt) => {
          const raw = toView(evt);
          const view = viewRef.current;
          return { x: (raw.x - view.x) / view.k, y: (raw.y - view.y) / view.k };
        };

        // ---- v1.5.6 Ctrl interactions: pan by drag, zoom by wheel -----------------
        const startPan = (evt) => {
          if (evt.button !== undefined && evt.button !== 0) return;
          const view = viewRef.current;
          panRef.current = {
            pointerId: evt.pointerId,
            startX: evt.clientX,
            startY: evt.clientY,
            originX: view.x,
            originY: view.y,
          };
          try {
            svgRef.current?.setPointerCapture(evt.pointerId);
          } catch {
            /* pointer capture is best-effort */
          }
          evt.preventDefault?.();
        };

        const panMove = (evt) => {
          const pan = panRef.current;
          if (!pan || pan.pointerId !== evt.pointerId) return false;
          const svg = svgRef.current;
          if (!svg) return true;
          const rect = svg.getBoundingClientRect();
          const scaleX = rect.width ? width / rect.width : 1;
          const scaleY = rect.height ? height / rect.height : 1;
          viewRef.current = {
            ...viewRef.current,
            x: pan.originX + (evt.clientX - pan.startX) * scaleX,
            y: pan.originY + (evt.clientY - pan.startY) * scaleY,
          };
          applyView();
          return true;
        };

        const endPan = (evt) => {
          if (!panRef.current || panRef.current.pointerId !== evt.pointerId) return false;
          panRef.current = null;
          try {
            svgRef.current?.releasePointerCapture(evt.pointerId);
          } catch {
            /* already released */
          }
          return true;
        };

        /** Zoom around the cursor so the tag under the pointer stays put. */
        const zoomAt = (evt) => {
          const svg = svgRef.current;
          if (!svg) return;
          const view = viewRef.current;
          const raw = toView(evt);
          const gx = (raw.x - view.x) / view.k;
          const gy = (raw.y - view.y) / view.k;
          const factor = Math.exp(-Number(evt.deltaY || 0) * 0.0015);
          const k = Math.max(0.4, Math.min(3, view.k * factor));
          viewRef.current = { x: raw.x - gx * k, y: raw.y - gy * k, k };
          applyView();
        };

        /** Local relaxation: the dragged node and its neighbours only, alpha-decayed. */
        const relaxAround = (centerId) => {
          const centerIndex = indexOfId.get(centerId);
          if (centerIndex === undefined) return;
          const local = new Set([centerIndex]);
          for (const edge of allEdges) {
            if (edge.source === centerId) local.add(indexOfId.get(edge.target));
            else if (edge.target === centerId) local.add(indexOfId.get(edge.source));
          }
          const localIndexes = [...local].filter((index) => Number.isInteger(index));
          const localSet = new Set(localIndexes);
          const links = allEdges
            .map((edge) => ({ a: indexOfId.get(edge.source), b: indexOfId.get(edge.target), weight: edge.weight || 1 }))
            .filter((link) => link.a !== undefined && link.b !== undefined && (localSet.has(link.a) || localSet.has(link.b)));

          let alpha = 0.5;
          let frame = 0;
          const step = () => {
            if (!aliveRef.current) return;
            alpha *= 0.93;
            frame += 1;
            for (const i of localIndexes) {
              const node = positions[i];
              for (const j of localIndexes) {
                if (i === j) continue;
                const other = positions[j];
                const dx = node.x - other.x;
                const dy = node.y - other.y;
                const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy));
                const force = (220 / (distance * distance)) * alpha;
                node.vx += (dx / distance) * force;
                node.vy += (dy / distance) * force;
              }
            }
            for (const link of links) {
              const a = positions[link.a];
              const b = positions[link.b];
              const dx = b.x - a.x;
              const dy = b.y - a.y;
              const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy));
              const force = ((distance - 80) / distance) * 0.06 * alpha * Math.min(2, link.weight);
              a.vx += dx * force;
              a.vy += dy * force;
              b.vx -= dx * force;
              b.vy -= dy * force;
            }
            for (const i of localIndexes) {
              const node = positions[i];
              node.vx *= 0.7;
              node.vy *= 0.7;
              node.x = Math.max(24, Math.min(width - 24, node.x + node.vx));
              node.y = Math.max(24, Math.min(height - 24, node.y + node.vy));
              // The centre node is pinned only while the pointer is down; after
              // release it settles like the rest of the local neighbourhood.
            }
            paint();
            if (alpha > 0.03 && frame < 90) rafRef.current = requestAnimationFrame(step);
          };
          rafRef.current = requestAnimationFrame(step);
        };

        const onPointerDown = (node, index, evt) => {
          if (evt.button !== undefined && evt.button !== 0) return;
          // Ctrl/Cmd turns a node grab into canvas panning (prevents accidental moves).
          if (evt.ctrlKey || evt.metaKey) {
            startPan(evt);
            evt.stopPropagation?.();
            return;
          }
          const position = positions[index];
          if (!position) return;
          const point = toSvg(evt);
          dragRef.current = {
            id: node.id,
            index,
            pointerId: evt.pointerId,
            offsetX: position.x - point.x,
            offsetY: position.y - point.y,
            moved: false,
            startX: evt.clientX,
            startY: evt.clientY,
          };
          // Pinned for the duration of the drag: the force pass skips it, so the
          // pointer position always wins.
          position.pinned = true;
          position.vx = 0;
          position.vy = 0;
          try {
            evt.currentTarget.setPointerCapture(evt.pointerId);
          } catch {
            // Pointer capture is best-effort (older engines); the move handler
            // still works while the pointer stays over the SVG.
          }
          evt.preventDefault?.();
        };

        const onPointerMove = (evt) => {
          // v1.5.6: Ctrl+drag pans the canvas; plain drag moves a node.
          if (panMove(evt)) return;
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== evt.pointerId) return;
          if (!drag.moved) {
            const dx = evt.clientX - drag.startX;
            const dy = evt.clientY - drag.startY;
            if (dx * dx + dy * dy < 16) return; // < 4px: still a click, not a drag
            drag.moved = true;
          }
          const point = toSvg(evt);
          const position = positions[drag.index];
          position.x = Math.max(24, Math.min(width - 24, point.x + drag.offsetX));
          position.y = Math.max(24, Math.min(height - 24, point.y + drag.offsetY));
          position.vx = 0;
          position.vy = 0;
          paint();
        };

        const endDrag = (evt) => {
          if (endPan(evt)) return;
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== evt.pointerId) return;
          dragRef.current = null;
          const dragged = positions[drag.index];
          if (dragged) dragged.pinned = false;
          try {
            evt.currentTarget.releasePointerCapture(evt.pointerId);
          } catch {
            // already released
          }
          if (!drag.moved) {
            // A click selects/toggles the label; a drag never does.
            setFocus((prev) => (prev === drag.id ? null : drag.id));
            return;
          }
          relaxAround(drag.id);
        };

        if (allNodes.length === 0) {
          return h('div', { style: { ...cardStyle, color: palette.muted, fontSize: 13 } }, '暂无图谱：维护完成后由日志（去墓碑）离线生成。');
        }

        return h(
          'div',
          { style: cardStyle },
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 } },
            h('div', { style: { fontSize: 13, fontWeight: 600 } }, '知识图谱'),
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
              h(
                'div',
                { style: { ...labelStyle, marginBottom: 0 }, title: '按住 Ctrl（Mac 为 Cmd）拖拽画布平移；Ctrl + 滚轮缩放；双击空白处重置视图' },
                'Ctrl 拖拽平移 · Ctrl 滚轮缩放',
              ),
              h('div', { style: { ...labelStyle, marginBottom: 0 } }, `${fmtNumber(graph.nodeCount)} 节点 · ${fmtNumber(graph.edgeCount)} 边${graph.truncated ? '（已截断）' : ''}`),
              ghostNodes.length > 0
                ? h(
                    'div',
                    {
                      style: { display: 'flex', gap: 4 },
                      title: '仅活跃 = 只看当前图谱；历史全貌 = 叠加宽限期内的幽灵节点（半透明、虚线、挂在父 root 下）',
                    },
                    h(
                      'button',
                      { type: 'button', 'aria-pressed': history ? 'false' : 'true', onClick: () => setHistory(false), style: toggleStyle(!history) },
                      '仅活跃',
                    ),
                    h(
                      'button',
                      { type: 'button', 'aria-pressed': history ? 'true' : 'false', onClick: () => setHistory(true), style: toggleStyle(history) },
                      `历史全貌 · ${fmtNumber(ghostNodes.length)}`,
                    ),
                  )
                : null,
            ),
          ),
          h(
            'svg',
            {
              ref: svgRef,
              width: '100%',
              viewBox: `0 0 ${width} ${height}`,
              style: { display: 'block', touchAction: 'none' },
              onPointerDown: (evt) => {
                if ((evt.ctrlKey || evt.metaKey) && evt.target === evt.currentTarget) startPan(evt);
              },
              onPointerMove,
              onPointerUp: endDrag,
              onPointerCancel: endDrag,
              onDoubleClick: (evt) => {
                if (evt.target === evt.currentTarget) resetView();
              },
            },
            h('g', { ref: groupRef, transform: 'translate(0, 0) scale(1)' },
            // Edges first, and only when BOTH endpoints are painted: no dangling lines.
            allEdges.map((edge, i) => {
              const a = byId.get(edge.source);
              const b = byId.get(edge.target);
              if (!a || !b) return null;
              const ai = indexOfId.get(edge.source);
              const bi = indexOfId.get(edge.target);
              if (ai >= revealed || bi >= revealed) return null;
              return h('line', {
                key: `e${i}`,
                ref: (el) => {
                  lineEls.current[i] = el;
                },
                x1: a.x,
                y1: a.y,
                x2: b.x,
                y2: b.y,
                stroke: edge.ghost ? palette.warn : palette.border,
                strokeDasharray: edge.ghost ? '3 4' : undefined,
                strokeWidth: Math.min(2.5, 0.4 + (edge.weight || 1) * 0.25),
                opacity: edge.ghost ? 0.7 : 0.8,
                // Smooth fade in/out: the coordinate is already frozen, only alpha moves.
                style: edge.ghost ? { opacity: history ? 0.7 : 0, transition: 'opacity 420ms ease' } : undefined,
              });
            }),
            allNodes.map((node, i) => {
              if (i >= revealed) return null;
              const position = positions[i];
              if (!position) return null;
              const ghost = node.ghost === true;
              const ghostRoot = node.ghostRoot === true;
              const radius = ghost ? 4 : ghostRoot ? 6 : 3 + (Math.sqrt((node.weight || 0) / maxWeight) || 0) * 7;
              const core = !ghost && !ghostRoot && i < 5;
              const active = focus === node.id;
              return h(
                'g',
                {
                  key: node.id,
                  ref: (el) => {
                    nodeEls.current[i] = el;
                  },
                  transform: `translate(${position.x}, ${position.y})`,
                  style: {
                    cursor: 'grab',
                    touchAction: 'none',
                    opacity: ghost || ghostRoot ? (history ? 1 : 0) : 1,
                    transition: 'opacity 420ms ease',
                    pointerEvents: ghost || ghostRoot ? (history ? 'auto' : 'none') : 'auto',
                  },
                  onPointerDown: (evt) => onPointerDown(node, i, evt),
                  onPointerEnter: () => setFocus(node.id),
                  onPointerLeave: () => {
                    if (!dragRef.current) setFocus(null);
                  },
                },
                ghost
                  ? h('title', null, `幽灵节点 ${node.path}${node.graceUntil ? ' · 宽限期至 ' + fmtTime(node.graceUntil) : ''}：仅元数据，不注入正文`)
                  : null,
                h('circle', {
                  r: radius + 6,
                  fill: 'transparent', // larger hit target, invisible
                }),
                h('circle', {
                  r: radius,
                  fill: ghost ? 'rgba(217,155,43,0.22)' : ghostRoot ? 'transparent' : active ? palette.accent : 'rgba(79,140,255,0.55)',
                  stroke: ghost || ghostRoot ? palette.warn : palette.border,
                  strokeDasharray: ghost || ghostRoot ? '4 3' : undefined,
                  strokeWidth: 1,
                }),
                (core || active || (history && (ghost || ghostRoot))) &&
                  h(
                    'text',
                    { x: radius + 4, y: 4, fill: palette.text, style: { fontSize: 10, pointerEvents: 'none' } },
                    ghost ? `${node.label} · 幽灵` : node.label,
                  ),
              );
            }),
            ),
          ),
          h('div', { style: { ...labelStyle, marginTop: 6, marginBottom: 0 } }, 'Ctrl+拖拽平移 · Ctrl+滚轮缩放 · 双击空白重置视图；拖拽节点可移动；单击查看标签；核心节点常显。幽灵节点＝宽限期内的层级记忆，仅在"历史全貌"可见（半透明、虚线、挂在父 root 下）。'),
        );
      }

      // ---- panel -------------------------------------------------------------

      // Shared small-button style for the selector/transfer dialog.
      const smallButtonStyle = {
        padding: '4px 10px',
        borderRadius: 8,
        border: `1px solid ${palette.border}`,
        background: 'transparent',
        color: palette.text,
        cursor: 'pointer',
        fontSize: 12,
      };
      const compactInputStyle = {
        width: 120,
        padding: '4px 8px',
        borderRadius: 8,
        border: `1px solid ${palette.border}`,
        background: 'transparent',
        color: palette.text,
        fontSize: 12,
      };

      /** Live progress for a UI-triggered PHYSICAL dataDir migration (A/B copy). */
      function MigrationCard(props) {
        const migration = props.migration || {};
        const total = Number(migration.totalBytes) || 0;
        const copied = Number(migration.copiedBytes) || 0;
        const percent = total > 0 ? Math.min(100, Math.round((copied / total) * 100)) : 0;
        const failed = migration.status === 'failed';
        return h(
          'div',
          { style: { ...cardStyle, borderColor: failed ? palette.danger : palette.accent } },
          h('div', { style: { fontWeight: 600, marginBottom: 6, color: failed ? palette.danger : palette.text } }, failed ? '数据迁移失败（旧目录仍在使用）' : '正在迁移数据目录…'),
          h('div', { style: { ...labelStyle, marginBottom: 6 } }, `${migration.from ?? '—'} → ${migration.to ?? '—'}（${migration.phase ?? 'copying'}）`),
          h(
            'div',
            { style: { height: 8, borderRadius: 999, background: palette.border, overflow: 'hidden', marginBottom: 6 } },
            h('div', { style: { width: `${percent}%`, height: '100%', background: failed ? palette.danger : palette.accent, transition: 'width 400ms ease' } }),
          ),
          h(
            'div',
            { style: { ...labelStyle, marginBottom: 0 } },
            failed
              ? `${migration.error?.code ?? 'MEM_E_MIGRATION_IO'}: ${migration.error?.message ?? ''}`
              : `${percent}% · 迁移期间记忆写入暂停，完成后自动切换；旧目录保留为备份`,
          ),
        );
      }

      /**
       * SpaceSelector (UI_TASK_2): the global, header-mounted space switcher.
       *
       * Mount: MemoryPanel renders it in the panel header (the "main" slot is the
       * global surface a person sees for memory). Selection is app-global state
       * (spaceStore + 'space-changed' bus event), NOT a per-panel local: the
       * settings slot follows it too.
       *
       * Routing: every read hook appends `?space=<id>` (stats/graph/memories) and
       * the backend routes to that physical store, so memory list, graph and the
       * L1/L2/L3 counters are strictly isolated per space — never blended.
       *
       * Creating a space is EMPTY-store creation, never a copy: business-data
       * transfer remains the separate, double-consent flow below.
       */
      function SpaceSelector(props) {
        const entries = Array.isArray(props.spaces) && props.spaces.length > 0 ? props.spaces : [DEFAULT_SPACE_ID];
        const [creating, setCreating] = React.useState(false);
        const [name, setName] = React.useState('');
        const [status, setStatus] = React.useState(null);
        const [busy, setBusy] = React.useState(false);
        // Capability handshake: an old host that does not serve /spaces is detected
        // BEFORE a request is made, so the 404 incident cannot repeat.
        const handshake = props.payload || { capabilities: props.capabilities };
        const caps = (handshake && handshake.capabilities) || null;
        // v1.5.6: silently disappear when multi-space is not a live capability
        // (no dsh-orchestrator, or an old host). No empty selector, no disabled
        // button, no warning noise in the panel.
        if (!caps || caps.spaces !== true) return null;
        const availability = spaceCreateAvailable(handshake);
        const deleteAvailable = spaceDeleteAvailable(handshake);

        const create = async () => {
          // Defence #1: never call a route the host did not advertise.
          if (!availability.available) {
            setStatus({ tone: 'error', text: availability.reason });
            return;
          }
          const id = String(name).trim().toLowerCase();
          // Mirror of the server validator: format errors are shown as sentences,
          // and the server stays the authority for conflict/reserved names.
          if (!CLIENT_SPACE_PATTERN.test(id)) {
            setStatus({ tone: 'error', text: '创建失败：空间名称需以小写字母/数字开头，只能包含 a-z 0-9 . _ -（最长 64 个字符）' });
            return;
          }
          setBusy(true);
          try {
            const { status: httpStatus, body } = await getJson(API.spaces, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ space_id: id }),
            });
            if (body && body.ok === true) {
              setStatus({ tone: 'ok', text: `已创建空间 ${id}` });
              setName('');
              setCreating(false);
              if (typeof props.onCreate === 'function') props.onCreate(body.spaces || []);
              setActiveSpace(id);
            } else {
              // Defence #2: user-facing sentence, never `${code}: HTTP 404`.
              setStatus({ tone: 'error', text: describeSpaceError(body && body.error, httpStatus) });
            }
          } catch (error) {
            setStatus({ tone: 'error', text: describeSpaceError({ code: 'MEM_E_NETWORK', message: String((error && error.message) || error) }) });
          } finally {
            setBusy(false);
          }
        };

        /**
         * v1.5.6: DELETE the CURRENT named space. Destructive, so the human confirms
         * first; `default` has no delete button at all. After success the selector
         * returns to `default` and the caller refreshes the list.
         */
        const remove = async () => {
          const target = props.value;
          // Never call a delete route the host did not advertise: on a pre-delete
          // host this request used to be misread as CREATE ("空间已存在").
          if (!deleteAvailable) return;
          if (!target || target === DEFAULT_SPACE_ID) return;
          if (!availability.available) {
            setStatus({ tone: 'error', text: availability.reason });
            return;
          }
          const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
            ? window.confirm(`删除空间「${spaceLabel(target)}（${target}）」？该空间内的全部记忆会被永久删除，不可恢复。`)
            : true;
          if (!ok) return;
          setBusy(true);
          try {
            const { status: httpStatus, body } = await getJson(API.spaces, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action: 'delete', space_id: target, confirm: true }),
            });
            if (body && body.ok === true) {
              setStatus({ tone: 'ok', text: `已删除空间 ${target}` });
              if (typeof props.onCreate === 'function') props.onCreate(body.spaces || []);
              setActiveSpace(DEFAULT_SPACE_ID);
            } else {
              setStatus({ tone: 'error', text: describeSpaceError(body && body.error, httpStatus, 'delete') });
            }
          } catch (error) {
            setStatus({ tone: 'error', text: describeSpaceError({ code: 'MEM_E_NETWORK', message: String((error && error.message) || error) }, 0, 'delete') });
          } finally {
            setBusy(false);
          }
        };

        return h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: { ...labelStyle, marginBottom: 0 } }, '当前空间'),
          h(
            'select',
            {
              value: props.value,
              onChange: (event) => props.onChange(event.target.value),
              title: '全局空间选择器：切换后记忆列表、图谱与 L1/L2/L3 状态都跟随该空间（后端按 ?space= 路由隔离）',
              style: { padding: '4px 8px', borderRadius: 8, border: `1px solid ${palette.border}`, background: 'transparent', color: palette.text, fontSize: 12 },
            },
            entries.map((id) => h('option', { key: id, value: id }, `${spaceLabel(id)}（${id}）`)),
          ),
          availability.available && deleteAvailable && props.value !== DEFAULT_SPACE_ID
            ? h(
                'button',
                {
                  type: 'button',
                  style: { ...smallButtonStyle, color: palette.danger },
                  onClick: remove,
                  disabled: busy,
                  title: '删除当前空间（永久删除该空间内的记忆，需二次确认；默认空间不可删除）',
                },
                '🗑 删除空间',
              )
            : null,
          availability.available
            ? creating
              ? h(
                  'span',
                  { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                  h('input', {
                    type: 'text',
                    value: name,
                    placeholder: 'work / private',
                    onChange: (event) => setName(event.target.value),
                    style: compactInputStyle,
                  }),
                  h('button', { type: 'button', style: smallButtonStyle, onClick: create, disabled: busy }, busy ? '创建中…' : '创建'),
                  h(
                    'button',
                    {
                      type: 'button',
                      style: smallButtonStyle,
                      onClick: () => {
                        setCreating(false);
                        setStatus(null);
                      },
                    },
                    '取消',
                  ),
                )
              : h(
                  'button',
                  { type: 'button', style: smallButtonStyle, onClick: () => setCreating(true), title: '创建一个空的物理空间（不复制任何数据）' },
                  '＋ 新建空间',
                )
            : h(
                'button',
                {
                  type: 'button',
                  style: { ...smallButtonStyle, opacity: 0.7, cursor: 'not-allowed' },
                  title: availability.reason,
                  onClick: () => setStatus({ tone: 'error', text: availability.reason }),
                },
                '＋ 新建空间',
              ),
          status
            ? h(
                'span',
                { style: { fontSize: 11, color: status.tone === 'error' ? palette.danger : palette.accent, maxWidth: 420 } },
                status.text,
              )
            : null,
        );
      }

      /**
       * CrossSpaceTransferUI (UI_TASK_3): the ONLY business-data transfer flow.
       *
       * User checks rows in the current space -> "移动到…" -> this dialog.
       *   STEP 1 states the intent: "即将向 [目标空间] 发起迁移请求".
       *   STEP 2 is the SECOND explicit confirmation required by
       *          context.requireExplicitConsentForTransfer; only then does the
       *          request carry `user_approved: true`.
       *
       * There is deliberately NO free-text `target_space_id` input: the target is
       * a dropdown of known spaces created by the SpaceSelector.
       *
       * The engine gate is the backstop: even if this dialog were bypassed, a call
       * without user_approved gets MEM_E_REQUIRE_USER_CONSENT (agent tools and a
       * raw POST both), so a bottom-level API cannot move memories by itself.
       */
      function CrossSpaceTransferUI(props) {
        const targets = (Array.isArray(props.spaces) ? props.spaces : []).filter((id) => id !== props.sourceSpace);
        const [target, setTarget] = React.useState(targets[0] || '');
        const [mode, setMode] = React.useState('copy');
        const [step, setStep] = React.useState(1);
        const [busy, setBusy] = React.useState(false);
        const [status, setStatus] = React.useState(null);
        const count = Array.isArray(props.eventIds) ? props.eventIds.length : 0;

        const submit = async () => {
          if (!target) {
            setStatus({ tone: 'error', text: '请先选择一个目标空间（可在顶部 ＋ 新建空间）' });
            return;
          }
          setBusy(true);
          setStatus(null);
          try {
            // STEP 2 happened in the UI; `user_approved:true` is the explicit human
            // grant the engine requires. No other path in this component can send it.
            const { status: httpStatus, body } = await getJson(API.transfer, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                event_ids: props.eventIds,
                target_space_id: target,
                transfer_mode: mode,
                source_space_id: props.sourceSpace,
                user_approved: true,
              }),
            });
            if (body && body.ok === true) {
              setStatus({ tone: 'ok', text: `已完成${mode === 'move' ? '剪切' : '复制'}迁移：${count} 条 → ${target}` });
              if (typeof props.onDone === 'function') props.onDone(body, { target, mode });
            } else {
              const error = (body && body.error) || {};
              setStatus({ tone: 'error', text: `${error.code || 'MEM_E_TRANSFER'}: ${error.message || `HTTP ${httpStatus}`}` });
            }
          } catch (error) {
            setStatus({ tone: 'error', text: String((error && error.message) || error) });
          } finally {
            setBusy(false);
          }
        };

        return h(
          'div',
          {
            style: {
              marginTop: 8,
              padding: 12,
              border: `1px solid ${step === 2 ? palette.warn : palette.border}`,
              borderRadius: 10,
              background: 'rgba(127,127,127,0.04)',
            },
          },
          h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, step === 1 ? '移动到其他空间' : '二次确认 · 安全红线'),
          h(
            'div',
            { style: { ...labelStyle, marginBottom: 8 } },
            step === 1
              ? `即将向 [${target || '未选择'}] 发起迁移请求（${count} 条记忆，来源 ${props.sourceSpace}）。`
              : `再次确认：将把 ${count} 条记忆从 [${props.sourceSpace}] 迁移到 [${target}]。这会触发 requireExplicitConsentForTransfer 的显式用户授权，确认后不可由 AI 撤销。`,
          ),
          step === 1
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                targets.length === 0
                  ? h('div', { style: { ...labelStyle, marginBottom: 0 } }, '没有其他空间可迁移：请先在顶部「＋ 新建空间」。')
                  : h(
                      'label',
                      { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 } },
                      '目标空间',
                      h(
                        'select',
                        {
                          value: target,
                          onChange: (event) => setTarget(event.target.value),
                          style: { padding: '4px 8px', borderRadius: 8, border: `1px solid ${palette.border}`, background: 'transparent', color: palette.text, fontSize: 12 },
                        },
                        targets.map((id) => h('option', { key: id, value: id }, `${spaceLabel(id)}（${id}）`)),
                      ),
                    ),
                h(
                  'div',
                  { style: { display: 'flex', gap: 8 } },
                  ['copy', 'move'].map((entry) =>
                    h(
                      'button',
                      {
                        key: entry,
                        type: 'button',
                        onClick: () => setMode(entry),
                        style: mode === entry ? { ...smallButtonStyle, borderColor: palette.accent, color: palette.accent } : smallButtonStyle,
                      },
                      entry === 'copy' ? '复制' : '剪切',
                    ),
                  ),
                ),
                h(
                  'div',
                  { style: { display: 'flex', gap: 8 } },
                  h('button', { type: 'button', style: smallButtonStyle, onClick: () => props.onClose() }, '取消'),
                  h(
                    'button',
                    { type: 'button', style: smallButtonStyle, onClick: () => setStep(2), disabled: !target || count === 0 },
                    '下一步',
                  ),
                ),
              )
            : h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                // Destructive mode gets its own second warning INSIDE the second
                // confirmation step: cut parks the source in the two-phase
                // pending-delete queue (restore is possible until the deadline).
                mode === 'move'
                  ? h(
                      'div',
                      { style: { fontSize: 12, color: palette.warn } },
                      '剪切会使源空间数据进入两阶段待删队列（宽限期后可 restore），确定继续？',
                    )
                  : null,
                h(
                  'div',
                  { style: { display: 'flex', gap: 8 } },
                  h('button', { type: 'button', style: smallButtonStyle, onClick: () => setStep(1), disabled: busy }, '返回'),
                  h(
                    'button',
                    { type: 'button', style: { ...smallButtonStyle, borderColor: palette.warn }, onClick: submit, disabled: busy },
                    busy ? '迁移中…' : '确认并授权迁移',
                  ),
                ),
              ),
          status
            ? h('div', { style: { marginTop: 8, fontSize: 12, color: status.tone === 'error' ? palette.danger : palette.accent } }, status.text)
            : null,
        );
      }

      function MemoryPanel() {
        // GLOBAL selection: one active space drives every read on this surface.
        const activeSpace = useActiveSpace();
        const state = useMemoryStats(activeSpace);
        const payload = state.payload;
        // The handshake decides, not HTTP and not `ok`: `state` is the protocol.
        const ready = state.state === 'ready';
        const limit = (payload && payload.config && payload.config.graphMaxEdges) || 500;
        const graphState = useGraph(limit, ready, activeSpace);
        // Search state is declared BEFORE the early returns: hooks must run in the
        // same order on every render (ready -> pending -> ready must not shift them).
        const [searchInput, setSearchInput] = React.useState('');
        const [searchQuery, setSearchQuery] = React.useState('');
        // Space-isolated memory list + selection for the regulated transfer flow.
        // Capability handshake (old host vs new client): only fetch /memories when
        // the host advertises it; otherwise show a version hint, never a 404.
        const capabilities = (payload && payload.capabilities) || null;
        const memoriesSupported = Boolean(capabilities && capabilities.memories === true);
        const recent = useRecentMemories(ready, activeSpace, memoriesSupported);
        const [selectedIds, setSelectedIds] = React.useState([]);
        const [transferOpen, setTransferOpen] = React.useState(false);
        const [spaceList, setSpaceList] = React.useState(null);

        if (state.state === 'migrating') {
          return h('div', { style: { padding: 16 } }, h(MigrationCard, { migration: payload?.migration ?? state.migration }));
        }
        if (!ready) {
          return h(
            'div',
            { style: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12 } },
            h(PhaseCard, { payload, error: state.error, shellState: state.state, attempts: state.attempts, gaveUp: state.gaveUp }),
          );
        }

        const panel = payload.panel || {};
        const global = panel.global || {};
        const tokens = panel.tokens || {};
        const storage = panel.storage || {};
        const maintenance = panel.maintenance || {};
        const generations = panel.generations || {};
        const graphInfo = panel.graph || {};
        const tagTreeInfo = panel.tagTree || {};
        const session = panel.session || null;
        const spaces = panel.spaces || null;
        const spaceIds = spaceList || (spaces && Array.isArray(spaces.ids) ? spaces.ids : [activeSpace]);
        const currentSpace = (spaces && spaces.current) || activeSpace;
        // The graph rendered is the FILTERED projection; with an empty query this
        // keeps the very same node/edge arrays, so no forced re-layout.
        const shownGraph = filterGraphByQuery(graphState.graph, searchQuery);
        const smallBtn = smallButtonStyle;
        const toggleSelected = (eventId) => {
          setSelectedIds((prev) => (prev.includes(eventId) ? prev.filter((id) => id !== eventId) : prev.concat(eventId)));
        };

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
          // UI_TASK_2: the global selector lives in the panel header. Every card
          // below is rendered from the payload of THIS space (backend ?space=).
          h(SpaceSelector, {
            value: activeSpace,
            spaces: spaceIds,
            // Handshake payload: the selector checks capabilities.spaces BEFORE any
            // POST, so a new client on an old host degrades instead of 404-ing.
            payload,
            onChange: (id) => {
              setTransferOpen(false);
              setSelectedIds([]);
              setActiveSpace(id);
            },
            onCreate: (ids) => setSpaceList(ids),
          }),
          // Status bar: physical session line + selected space chip.
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
            h(
              'div',
              {
                style: {
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                  fontSize: 12,
                  color: palette.muted,
                  background: 'rgba(127,127,127,0.08)',
                  border: `1px solid ${palette.border}`,
                  borderRadius: 8,
                  padding: '4px 10px',
                  fontVariantNumeric: 'tabular-nums',
                },
              },
              statusBarText(session),
            ),
            // v1.5.6: when multi-space is not a live capability the whole space UI
            // silently disappears — the chip would still imply a selector exists.
            payload?.capabilities?.spaces === true
              ? h(
                  'span',
                  {
                    style: {
                      fontSize: 11,
                      color: palette.muted,
                      border: `1px dashed ${palette.border}`,
                      borderRadius: 999,
                      padding: '2px 9px',
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                    },
                    title: '当前空间（spaces.current）',
                  },
                  `${spaceLabel(currentSpace)} · ${currentSpace}`,
                )
              : null,
            // v1.5.4: a degraded handoff is surfaced, never a silent lock.
            session && session.handoffDegraded
              ? h(
                  'span',
                  { style: { fontSize: 11, color: palette.warn } },
                  `交接已降级：${session.handoffErrorCode || 'MEM_E_HANDOFF_FAILED'}（状态机已放行新会话；可在设置页使用逃生舱重置）`,
                )
              : null,
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 12, flexWrap: 'wrap' } },
            h(StorageRing, {
              used: storage.diskBytes || 0,
              budget: (payload.config && payload.config.storageBudgetMb ? payload.config.storageBudgetMb : DEFAULT_BUDGET_MB) * 1024 * 1024,
            }),
            h(
              'div',
              { style: { display: 'flex', flexWrap: 'wrap', gap: 10, flex: '1 1 320px', alignContent: 'flex-start' } },
              h(StatCard, { label: '总记忆数', value: fmtNumber(global.events), hint: '当前空间日志内事件' }),
              h(StatCard, { label: '活跃标签', value: fmtNumber(global.activeTags), hint: '当前空间常驻集合' }),
              h(StatCard, { label: '累计节省 Token', value: fmtNumber(tokens.cumulativeSavedTokens), hint: `${fmtNumber(tokens.evictedBlocks)} 块已驱逐` }),
              h(StatCard, { label: '图谱', value: `${fmtNumber(graphInfo.nodeCount)} / ${fmtNumber(graphInfo.edgeCount)}`, hint: `上限 ${fmtNumber(graphInfo.limit)} 边` }),
              h(StatCard, {
                label: '标签树',
                value: `${fmtNumber(tagTreeInfo.nodeCount)} 节点`,
                hint: `幽灵 ${fmtNumber(tagTreeInfo.ghostCount)} · 待修剪 ${fmtNumber(tagTreeInfo.pendingQueue)}`,
              }),
            ),
          ),
          // Tag search above the graph: native Enter commits the query, and the
          // graph below receives the filtered projection (filterGraphByQuery).
          h(TagSearch, {
            value: searchInput,
            onChange: (value) => setSearchInput(value),
            onSubmit: (value) => setSearchQuery(String(value ?? '').trim()),
          }),
          searchQuery
            ? h('div', { style: { ...labelStyle, marginBottom: 0 } }, `检索：${searchQuery}（命中 ${shownGraph.nodes.length} 个标签）`)
            : null,
          graphState.graph
            ? h(KnowledgeGraph, { graph: shownGraph, ghosts: (graphState.tagTree && graphState.tagTree.ghosts) || [] })
            : h('div', { style: { ...cardStyle, color: palette.muted, fontSize: 13 } }, graphState.error ? `图谱不可用：${graphState.error.code}` : '正在读取图谱缓存…'),
          // UI_TASK_1/3: business rows are CHECKBOXES for the regulated mover. The
          // old per-row transfer button and the raw event_ids text box are gone.
          h(
            'div',
            { style: cardStyle },
            h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 4 } }, `记忆详情 · 当前空间（${spaceLabel(currentSpace)}）`),
            h(
              'div',
              { style: { ...labelStyle, marginBottom: 6 } },
              '勾选记忆后点「移动到…」：先确认目标空间，再做二次显式授权（requireExplicitConsentForTransfer）；AI 自行调用会被引擎拦截（MEM_E_REQUIRE_USER_CONSENT）。',
            ),
            recent.items.length === 0
              ? h(
                  'div',
                  { style: { ...labelStyle, marginBottom: 0 } },
                  recent.unsupported
                    ? '当前宿主版本不支持记忆列表（旧版本或未重载插件）。请重启 DSH 后重试。'
                    : recent.error
                      ? '记忆列表暂不可用，请稍后重试或联系架构师'
                      : '当前空间暂无记忆',
                )
              : recent.items.map((item) =>
                  h(
                    'label',
                    {
                      key: item.eventId,
                      style: { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderTop: `1px solid ${palette.border}`, cursor: 'pointer' },
                    },
                    h('input', {
                      type: 'checkbox',
                      checked: selectedIds.includes(item.eventId),
                      onChange: () => toggleSelected(item.eventId),
                    }),
                    h(
                      'div',
                      { style: { flex: '1 1 auto', minWidth: 0 } },
                      h('div', { style: { fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.snippet),
                      h(
                        'div',
                        { style: { ...labelStyle, marginBottom: 0, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' } },
                        `${String(item.eventId).slice(0, 12)}… · ${item.day || '—'} · ${(item.tags || []).join(', ') || '无标签'}`,
                      ),
                    ),
                  ),
                ),
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 } },
              h('span', { style: { ...labelStyle, marginBottom: 0 } }, `已勾选 ${selectedIds.length} 条`),
              h(
                'button',
                {
                  type: 'button',
                  style: smallBtn,
                  disabled: selectedIds.length === 0,
                  onClick: () => setTransferOpen(true),
                  title: '进入跨空间迁移流程（需要二次显式确认）',
                },
                '移动到…',
              ),
              selectedIds.length > 0
                ? h('button', { type: 'button', style: smallBtn, onClick: () => setSelectedIds([]) }, '清空选择')
                : null,
            ),
            transferOpen
              ? h(CrossSpaceTransferUI, {
                  eventIds: selectedIds,
                  sourceSpace: currentSpace,
                  spaces: spaceIds,
                  onClose: () => setTransferOpen(false),
                  onDone: (body, meta) => {
                    // The moved ids left this space (move) or were copied; refresh the
                    // selected space's list and clear the selection either way.
                    setSelectedIds([]);
                    // Soft follow (context.autoSpaceFollow) is the only automatic
                    // space switch, and it is operator-opt-in: a human just moved
                    // data to the target, so following it is a convenience, not AI
                    // initiative. The consent gate still ran before this point.
                    const autoFollow = payload.config && payload.config.context && payload.config.context.autoSpaceFollow === true;
                    if (autoFollow && meta && meta.target) {
                      setActiveSpace(meta.target);
                      setTransferOpen(false);
                    } else {
                      announce('space-changed');
                    }
                  },
                })
              : null,
          ),
          h(
            'div',
            { style: cardStyle },
            h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } }, '维护'),
            h(Row, { label: '上次成功', value: fmtTime(maintenance.lastSuccessAt) }),
            h(Row, { label: '下次预计', value: fmtTime(maintenance.nextRunAt) }),
            h(Row, { label: 'Cron', value: maintenance.maintenanceCron || '—' }),
            h(Row, { label: '图谱生成于', value: fmtTime(graphInfo.generatedAt) }),
            h(Row, { label: '标签树生成于', value: fmtTime(tagTreeInfo.generatedAt) }),
          ),
          h('div', { style: { ...labelStyle, marginTop: 2 } }, '数据每 3 秒自动刷新；空间切换在顶部空间选择器；配置请到 设置 → 海马体记忆。'),
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

      function Select(props) {
        return h(
          'label',
          { style: { display: 'block', padding: '8px 0' } },
          h('div', { style: { fontSize: 13, marginBottom: 4 } }, props.label),
          h(
            'select',
            {
              value: props.value,
              disabled: Boolean(props.disabled),
              onChange: (event) => props.onChange(event.target.value),
              style: { width: 220, padding: '6px 8px', borderRadius: 8, border: `1px solid ${palette.border}`, background: 'transparent', color: palette.text },
            },
            (props.options || []).map((option) => h('option', { key: option.value, value: option.value }, option.label)),
          ),
          props.hint ? h('div', { style: { ...labelStyle, marginTop: 4, marginBottom: 0 } }, props.hint) : null,
        );
      }

      function TextInput(props) {
        return h(
          'label',
          { style: { display: 'block', padding: '8px 0' } },
          h('div', { style: { fontSize: 13, marginBottom: 4 } }, props.label),
          h('input', {
            type: 'text',
            value: props.value,
            disabled: Boolean(props.disabled),
            onChange: (event) => props.onChange(event.target.value),
            style: { width: 220, padding: '6px 8px', borderRadius: 8, border: `1px solid ${palette.border}`, background: 'transparent', color: palette.text },
          }),
          props.hint ? h('div', { style: { ...labelStyle, marginTop: 4, marginBottom: 0 } }, props.hint) : null,
        );
      }

      /**
       * Slider + numeric box for the L1.5 lifetime knobs. The label carries a
       * `title` tooltip (hover) with the scenario hint, and the hint is also
       * rendered below so it is readable on touch devices.
       */
      function Slider(props) {
        const value = Number(props.value);
        const boxStyle = {
          width: 88,
          marginLeft: 10,
          padding: '4px 6px',
          borderRadius: 8,
          border: `1px solid ${palette.border}`,
          background: 'transparent',
          color: palette.text,
        };
        return h(
          'label',
          { style: { display: 'block', padding: '8px 0' }, title: props.hint || '' },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 4 } },
            h('span', { style: { fontSize: 13 } }, props.label),
            h('span', { style: { ...labelStyle, marginBottom: 0, fontVariantNumeric: 'tabular-nums' } }, `${value}${props.suffix || ''}`),
          ),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center' } },
            h('input', {
              type: 'range',
              value,
              min: props.min,
              max: props.max,
              step: props.step,
              disabled: Boolean(props.disabled),
              onChange: (event) => props.onChange(Number(event.target.value)),
              style: { flex: '1 1 180px', maxWidth: 260, accentColor: palette.accent },
            }),
            h('input', {
              type: 'number',
              value,
              min: props.min,
              max: props.max,
              step: props.step,
              disabled: Boolean(props.disabled),
              onChange: (event) => props.onChange(Number(event.target.value)),
              style: boxStyle,
            }),
          ),
          props.hint ? h('div', { style: { ...labelStyle, marginTop: 4, marginBottom: 0 } }, props.hint) : null,
        );
      }

      function Section(props) {
        return h(
          'div',
          { style: cardStyle },
          h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 4 } }, props.title),
          props.hint ? h('div', { style: { ...labelStyle, marginBottom: 6 } }, props.hint) : null,
          props.children,
        );
      }

      const EVENT_TIME_OPTIONS = [
        { value: 'content', label: 'content — 由内容推导（默认）' },
        { value: 'explicit', label: 'explicit — 调用方必须给时间' },
        { value: 'ingest', label: 'ingest — 用写入时刻' },
      ];

      /** Server config -> form draft (nested groups kept separate). */
      function draftFromConfig(config) {
        return {
          maintenanceCron: config.maintenanceCron,
          briefing: Boolean(config.briefing),
          promptSection: Boolean(config.promptSection),
          autoMaintainOnBoot: Boolean(config.autoMaintainOnBoot),
          enableDream: Boolean(config.enableDream),
          enableReflection: Boolean(config.enableReflection),
          dreamIdleMinutes: Number(config.dreamIdleMinutes),
          graphMaxEdges: Number(config.graphMaxEdges),
          storageBudgetMb: Number(config.storageBudgetMb),
          // L1.5 tag-tree lifecycle. Defaults mirror config.js; the form sends the
          // four dotted keys back in the same patch as every other setting.
          tagTree: {
            midHalfLifeMultiplier: Number((config.tagTree && config.tagTree.midHalfLifeMultiplier) ?? 3),
            midGracePeriodDays: Number((config.tagTree && config.tagTree.midGracePeriodDays) ?? 30),
            pruneBatchSize: Number((config.tagTree && config.tagTree.pruneBatchSize) ?? 100),
            leafDecayFloor: Number((config.tagTree && config.tagTree.leafDecayFloor) ?? 0),
          },
          // Tool schema pruning: suffixes only (no toolPrefix). Core tools are never
          // persisted as disabled; validation rejects them server-side anyway.
          tools: {
            disabled: Array.isArray(config.tools && config.tools.disabled) ? [...config.tools.disabled] : [],
          },
          // Pre-ingest tagging (v1.5.6): model tags win; this only fills in anchors
          // for untagged writes.
          tagging: {
            autoTag: (config.tagging && config.tagging.autoTag) !== false,
            maxTags: Number((config.tagging && config.tagging.maxTags) ?? 2),
          },
          // v1.5.6 capability flags: off => space tools/routes disappear.
          features: {
            multiSpace: (config.features && config.features.multiSpace) !== false,
            crossSpaceTransfer: (config.features && config.features.crossSpaceTransfer) !== false,
            crossSpaceRecall: (config.features && config.features.crossSpaceRecall) === true,
          },
          // v1.5.6 offline Dream tunables (safe subset; llm credentials are never
          // sent to the browser).
          dream: {
            useLlm: (config.dream && config.dream.useLlm) !== false,
            minGroupSize: Number((config.dream && config.dream.minGroupSize) ?? 3),
            maxGroupsPerRun: Number((config.dream && config.dream.maxGroupsPerRun) ?? 5),
            maxSummaryChars: Number((config.dream && config.dream.maxSummaryChars) ?? 200),
            maxSourceChars: Number((config.dream && config.dream.maxSourceChars) ?? 400),
            maxEventsPerGroup: Number((config.dream && config.dream.maxEventsPerGroup) ?? 8),
            llmTimeoutMs: Number((config.dream && config.dream.llmTimeoutMs) ?? 15000),
            failureThreshold: Number((config.dream && config.dream.failureThreshold) ?? 3),
            cooldownMinutes: Number((config.dream && config.dream.cooldownMinutes) ?? 60),
            compensateAfterHours: Number((config.dream && config.dream.compensateAfterHours) ?? 24),
            onlyLowValley: (config.dream && config.dream.onlyLowValley) !== false,
          },
          // v1.5.6 L2 multi-merge tunables (offline maintain phase).
          l2Merge: {
            enabled: (config.l2Merge && config.l2Merge.enabled) !== false,
            minGroupSize: Number((config.l2Merge && config.l2Merge.minGroupSize) ?? 2),
            maxGroupsPerRun: Number((config.l2Merge && config.l2Merge.maxGroupsPerRun) ?? 5),
            maxSummaryChars: Number((config.l2Merge && config.l2Merge.maxSummaryChars) ?? 400),
          },
          decayHalfLifeDays: Number((config.decay && config.decay.halfLifeDays) ?? 30),
          activeSetCap: Number((config.activeSet && config.activeSet.cap) ?? 200),
          maxRecallTopK: Number(config.maxRecallTopK),
          retrievalTopK: Number((config.retrieval && config.retrieval.topK) ?? config.retrievalTopK),
          rawMode: (config.raw && config.raw.mode) ?? 'salience',
          rawMinSalience: Number((config.raw && config.raw.minSalience) ?? 0.6),
          rawMaxTotalMb: Number((config.raw && config.raw.maxTotalMb) ?? 256),
          rawRetentionDays: Number((config.raw && config.raw.retentionDays) ?? 30),
          rawMaxScanTurns: Number((config.raw && config.raw.maxScanTurns) ?? 5000),
          deleteGraceHours: Number((config.delete && config.delete.graceHours) ?? 24),
          reviewEnabled: (config.review && config.review.enabled) !== false,
          context: {
            maxTokens: Number(config.context.maxTokens),
            // v1.5.6: the per-recall response ceiling (older hosts omit it).
            maxInjectTokens: Number((config.context && config.context.maxInjectTokens) ?? 4000),
            threshold: Number(config.context.threshold),
            target: Number(config.context.target),
            injectPrompt: Boolean(config.context.injectPrompt),
            // v1.5.0 physical routing + session handoff. Read with defaults so an
            // older Host half that has not learned these keys yet still renders.
            autoSpaceFollow: Boolean((config.context && config.context.autoSpaceFollow) ?? false),
            autoRolloverEnabled: (config.context && config.context.autoRolloverEnabled) !== false,
            autoRolloverThreshold: Number((config.context && config.context.autoRolloverThreshold) ?? 0.85),
            nativeTokenLimit: Number((config.context && config.context.nativeTokenLimit) ?? 8000),
            // Security red line (v1.5.1): default TRUE, only an explicit operator
            // choice may turn the engine-level consent gate off.
            requireExplicitConsentForTransfer: (config.context && config.context.requireExplicitConsentForTransfer) !== false,
          },
          // Inverted-index physical limit: bounds read-model memory, never the log.
          index: {
            maxPostingsPerTag: Number((config.index && config.index.maxPostingsPerTag) ?? 500),
          },
          temp: {
            ttlDays: Number(config.temp.ttlDays),
            promotionWindowDays: Number(config.temp.promotionWindowDays),
          },
          eventTimePolicy: config.identity ? config.identity.eventTimePolicy : config.eventTimePolicy,
        };
      }

      /** Every numeric field with its accepted range; the client pre-checks these. */
      const NUMBER_RULES = [
        { key: 'dreamIdleMinutes', label: '空闲判定', min: 1, max: 525600 },
        { key: 'graphMaxEdges', label: '图谱最大边数', min: 100, max: 2000 },
        { key: 'storageBudgetMb', label: '存储预算', min: 10, max: 1000 },
        { key: 'decayHalfLifeDays', label: '记忆半衰期', min: 7, max: 365 },
        { key: 'activeSetCap', label: '活跃标签上限', min: 100, max: 1000 },
        { key: 'maxRecallTopK', label: '检索上限', min: 1, max: 1000 },
        { key: 'retrievalTopK', label: '默认 topK', min: 1, max: 1000 },
        { key: 'context.maxTokens', label: '上下文预算', min: 256, max: 1000000 },
        { key: 'context.maxInjectTokens', label: '单次召回注入上限', min: 256, max: 100000 },
        { key: 'context.threshold', label: '淘汰阈值', min: 0.01, max: 0.99 },
        { key: 'context.target', label: '收敛目标', min: 0, max: 0.98 },
        { key: 'temp.ttlDays', label: 'L2.5 隔离期', min: 1, max: 3650 },
        { key: 'temp.promotionWindowDays', label: '晋升窗口', min: 0, max: 3650 },
        { key: 'rawMinSalience', label: 'raw 最小显著度', min: 0, max: 1 },
        { key: 'rawMaxTotalMb', label: 'raw 总量', min: 16, max: 4096 },
        { key: 'rawRetentionDays', label: 'raw 保留期', min: 1, max: 365 },
        { key: 'deleteGraceHours', label: '删除宽限期', min: 0, max: 168 },
        { key: 'rawMaxScanTurns', label: 'deep_raw 扫描回合上限', min: 500, max: 50000 },
        { key: 'tagTree.midHalfLifeMultiplier', label: 'mid 半衰期倍率', min: 1, max: 10 },
        { key: 'tagTree.midGracePeriodDays', label: 'mid 宽限天数', min: 7, max: 180 },
        { key: 'tagTree.pruneBatchSize', label: '标签树批大小', min: 10, max: 500 },
        { key: 'tagTree.leafDecayFloor', label: 'leaf 衰减地板', min: 0, max: 1 },
        { key: 'context.nativeTokenLimit', label: '原生窗口', min: 512, max: 1000000 },
        { key: 'context.autoRolloverThreshold', label: '交接触发比例', min: 0.5, max: 0.99 },
        { key: 'index.maxPostingsPerTag', label: '单标签索引上限', min: 1, max: 100000 },
        { key: 'tagging.maxTags', label: '自动打标数量', min: 1, max: 5 },
        { key: 'dream.minGroupSize', label: 'Dream 成组最少条数', min: 2, max: 50 },
        { key: 'dream.maxGroupsPerRun', label: 'Dream 单次组数', min: 1, max: 50 },
        { key: 'dream.maxSummaryChars', label: 'Dream 摘要字数', min: 40, max: 2000 },
        { key: 'dream.maxSourceChars', label: 'Dream 来源字数', min: 80, max: 4000 },
        { key: 'dream.maxEventsPerGroup', label: 'Dream 每组条数', min: 2, max: 50 },
        { key: 'dream.llmTimeoutMs', label: 'Dream LLM 超时', min: 500, max: 120000 },
        { key: 'dream.failureThreshold', label: 'Dream 熔断阈值', min: 1, max: 20 },
        { key: 'dream.cooldownMinutes', label: 'Dream 冷却分钟', min: 1, max: 1440 },
        { key: 'dream.compensateAfterHours', label: 'Dream 补偿阈值', min: 1, max: 720 },
        { key: 'l2Merge.minGroupSize', label: 'L2 合并成组条数', min: 2, max: 20 },
        { key: 'l2Merge.maxGroupsPerRun', label: 'L2 合并单次组数', min: 1, max: 50 },
        { key: 'l2Merge.maxSummaryChars', label: 'L2 合并字数上限', min: 100, max: 2000 },
      ];

      /**
       * Tool schema pruning catalog (mirrors src/config.js TOOL_SUFFIXES +
       * CORE_TOOL_SUFFIXES). `core: true` tools are shown checked+disabled: the
       * server rejects disabling them with MEM_E_INVALID_TOOL_NAME, and without
       * remember/recall/admin the plugin cannot be operated at all.
       */
      const TOOL_CATALOG = [
        { name: 'remember', core: true, hint: '核心：写入记忆。关闭后系统无法记录任何事实，因此不可关闭。' },
        { name: 'recall', core: true, hint: '核心：检索记忆。关闭后模型无法召回任何历史，因此不可关闭。' },
        { name: 'admin', core: true, hint: '核心：状态/维护/管理入口。关闭后无法观测或修复存储，因此不可关闭。' },
        { name: 'checkpoint', core: false, hint: '低频：记录单一进行中的重任务快照。需要任务续跑时再打开。' },
        { name: 'capture', core: false, hint: '低频：手动写入一条原始回合取证。raw 自动捕获不依赖它，可安全关闭。' },
        { name: 'bulk_ingest', core: false, hint: '低频：批量导入。只在一次性迁移/建库时使用，日常可关闭。' },
        { name: 'reinforce', core: false, hint: '低频：强化/复习一条记忆并推进间隔重复。不做间隔重复可关闭。' },
        { name: 'forget', core: false, hint: '低频：两阶段删除。需要模型自主遗忘时保留；保留人工删除可关闭。' },
        { name: 'space_transfer', core: false, hint: '低频：跨空间迁移（需用户显式授权）。只在多空间协作时需要。' },
        { name: 'transfer_to_global', core: false, hint: '低频：迁移到 global 空间（需用户显式授权）。不用全局空间可关闭。' },
      ];

      const readPath = (object, dotted) => dotted.split('.').reduce((cursor, part) => (cursor == null ? cursor : cursor[part]), object);

      /**
       * StorageMigratorUI (UI_TASK_1): PHYSICAL dataDir migration only.
       *
       * This is SYSTEM/DATA MANAGEMENT, not business memory transfer. It owns the
       * A/B double-buffer copy: POST { dataDir } -> 202 state=migrating -> the
       * panel/phase card renders progress -> verified swap. The OLD directory is
       * kept as a backup.
       *
       * Fail-Fast: empty / relative / same-as-current / inside-current / disk-root
       * targets are rejected here AND by the backend
       * (MEM_E_MIGRATION_PATH, non-empty target -> MEM_E_MIGRATION_TARGET_BUSY)
       * before any background job starts; a rejected request never touches either
       * directory.
       */
      function StorageMigratorUI(props) {
        const currentDataDir = (props.config && props.config.dataDir) || '';
        const [target, setTarget] = React.useState('');
        const [busy, setBusy] = React.useState(false);
        const [status, setStatus] = React.useState(null);

        const start = async () => {
          const problem = migrationPathProblem({ from: currentDataDir, to: target });
          if (problem) {
            setStatus({ tone: 'error', text: problem });
            return;
          }
          setBusy(true);
          setStatus(null);
          try {
            // dataDir travels ALONE: it is a migration request, not a config patch.
            const { status: httpStatus, body } = await getJson(API.config, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ patch: { dataDir: target.trim() } }),
            });
            if (body && body.ok === true) {
              setStatus({ tone: 'warn', text: `迁移已启动（state=migrating）：${body.migration?.to ?? target.trim()}；旧目录保留为备份` });
              announce('reconnect');
            } else {
              const error = (body && body.error) || {};
              setStatus({ tone: 'error', text: `${error.code || 'MEM_E_MIGRATION'}: ${error.message || `HTTP ${httpStatus}`}` });
            }
          } catch (error) {
            setStatus({ tone: 'error', text: String((error && error.message) || error) });
          } finally {
            setBusy(false);
          }
        };

        return h(
          Section,
          {
            title: '系统级 · 存储位置迁移（dataDir / A-B 双缓冲）',
            hint: '仅搬迁物理存储目录，与业务记忆的跨空间转移完全无关。后台复制 + 校验通过后才切换；迁移期间 state=migrating，写入暂停；旧目录保留为备份（可手动删除）。',
          },
          h('div', { style: { ...labelStyle, marginBottom: 6 } }, `当前目录：${currentDataDir || '—'}`),
          h(TextInput, {
            label: '目标目录（绝对路径，必须为空）',
            hint: '严格校验：绝对路径、不能等于当前目录、不能是当前目录的子目录、不能是磁盘根、目标必须为空或不存在；非法即 fail-fast，旧目录不动。',
            value: target,
            onChange: (value) => setTarget(value),
            disabled: busy || props.disabled === true,
          }),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 4, flexWrap: 'wrap' } },
            h(
              'button',
              {
                type: 'button',
                onClick: start,
                disabled: busy || props.disabled === true,
                style: {
                  padding: '6px 14px',
                  borderRadius: 8,
                  border: `1px solid ${palette.accent}`,
                  background: 'transparent',
                  color: palette.accent,
                  cursor: busy ? 'default' : 'pointer',
                  fontSize: 13,
                },
              },
              busy ? '启动中…' : '启动迁移',
            ),
            status ? h('span', { style: { fontSize: 12, color: status.tone === 'error' ? palette.danger : palette.warn } }, status.text) : null,
          ),
        );
      }

      function MemorySettings() {
        const activeSpace = useActiveSpace();
        const state = useMemoryStats(activeSpace);
        const configState = useConfig();
        const serverConfig = configState.config;
        const shellState = state.state;
        const [draft, setDraft] = React.useState(null);
        const [status, setStatus] = React.useState(null);
        const [saving, setSaving] = React.useState(false);
        // v1.5.4 escape hatch: reset a wedged rollover/handoff state from the UI.
        const [escapeStatus, setEscapeStatus] = React.useState(null);
        const [escapeBusy, setEscapeBusy] = React.useState(false);

        React.useEffect(() => {
          if (serverConfig && draft === null) setDraft(draftFromConfig(serverConfig));
        }, [serverConfig, draft]);

        if (shellState === 'failed') {
          return h(
            'div',
            { style: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12 } },
            h(FailureBanner, { error: state.error || configState.error, attempts: state.attempts, gaveUp: state.gaveUp }),
          );
        }
        if (!serverConfig) return h('div', { style: { padding: 16 } }, h(PhaseCard, { payload: state.payload, error: configState.error, shellState }));
        if (!draft) return h('div', { style: { padding: 16, color: palette.muted } }, '读取配置…');

        // The settings page follows the SAME global selector as the panel: its
        // status bar and space line describe the selected space, not a hard-coded
        // default. Switching in the panel updates this slot through the bus.
        const statsPayload = state.payload;
        const sessionPanel = statsPayload && statsPayload.panel ? statsPayload.panel.session : null;
        const reportedSpace = statsPayload && statsPayload.panel && statsPayload.panel.spaces ? statsPayload.panel.spaces.current : null;
        const displayedSpace = activeSpace || reportedSpace || 'default';

        const edit = (path, value) => {
          setStatus(null);
          setDraft((prev) => {
            const next = {
              ...prev,
              context: { ...(prev.context || {}) },
              // index joins the shallow-clone list so an 'index.maxPostingsPerTag'
              // edit never mutates the previous draft object (the class of bug that
              // makes a cancelled edit silently stick around).
              index: { ...(prev.index || {}) },
              temp: { ...(prev.temp || {}) },
              tagTree: { ...(prev.tagTree || {}) },
              // tools.disabled is an ARRAY: clone it so a cancelled edit cannot
              // mutate the previous draft's array in place.
              tools: {
                ...(prev.tools || {}),
                disabled: Array.isArray(prev.tools && prev.tools.disabled) ? [...prev.tools.disabled] : [],
              },
              tagging: { ...(prev.tagging || {}) },
              features: { ...(prev.features || {}) },
              dream: { ...(prev.dream || {}) },
              l2Merge: { ...(prev.l2Merge || {}) },
            };
            if (path.indexOf('.') >= 0) {
              const [group, leaf] = path.split('.');
              next[group] = { ...(next[group] || {}), [leaf]: value };
            } else {
              next[path] = value;
            }
            return next;
          });
        };

        /** Client pre-check mirrors the server ranges; the server stays the authority. */
        const validateDraft = () => {
          for (const rule of NUMBER_RULES) {
            const value = readPath(draft, rule.key);
            const number = Number(value);
            if (!Number.isFinite(number)) return `${rule.label} 必须是数字`;
            if (number < rule.min || number > rule.max) return `${rule.label} 必须在 ${rule.min} – ${rule.max} 之间（当前 ${number}）`;
          }
          if (!String(draft.maintenanceCron || '').trim()) return 'Cron 表达式不能为空';
          return null;
        };

        const save = async () => {
          setStatus(null);
          const problem = validateDraft();
          if (problem) {
            setStatus({ tone: 'error', text: problem });
            return;
          }
          setSaving(true);
          // NOTE: dataDir is NOT part of this save. Physical storage migration
          // (A/B copy, state=migrating, old dir kept as backup) lives in the
          // separate system-level StorageMigratorUI and is submitted on its own.
          const patch = {
            maintenanceCron: String(draft.maintenanceCron).trim(),
            briefing: Boolean(draft.briefing),
            promptSection: Boolean(draft.promptSection),
            autoMaintainOnBoot: Boolean(draft.autoMaintainOnBoot),
            enableDream: Boolean(draft.enableDream),
            enableReflection: Boolean(draft.enableReflection),
            dreamIdleMinutes: Number(draft.dreamIdleMinutes),
            graphMaxEdges: Number(draft.graphMaxEdges),
            storageBudgetMb: Number(draft.storageBudgetMb),
            'decay.halfLifeDays': Number(draft.decayHalfLifeDays),
            'activeSet.cap': Number(draft.activeSetCap),
            maxRecallTopK: Number(draft.maxRecallTopK),
            'retrieval.topK': Number(draft.retrievalTopK),
            'context.maxTokens': Number(draft.context.maxTokens),
            'context.maxInjectTokens': Number(draft.context.maxInjectTokens),
            'context.threshold': Number(draft.context.threshold),
            'context.target': Number(draft.context.target),
            'context.injectPrompt': Boolean(draft.context.injectPrompt),
            'context.autoSpaceFollow': Boolean(draft.context.autoSpaceFollow),
            'context.autoRolloverEnabled': Boolean(draft.context.autoRolloverEnabled),
            'context.autoRolloverThreshold': Number(draft.context.autoRolloverThreshold),
            'context.nativeTokenLimit': Number(draft.context.nativeTokenLimit),
            'context.requireExplicitConsentForTransfer': Boolean(draft.context.requireExplicitConsentForTransfer),
            'index.maxPostingsPerTag': Number(draft.index.maxPostingsPerTag),
            'tools.disabled': Array.isArray(draft.tools.disabled) ? [...draft.tools.disabled] : [],
            'tagging.autoTag': Boolean(draft.tagging.autoTag),
            'tagging.maxTags': Number(draft.tagging.maxTags),
            'features.multiSpace': Boolean(draft.features.multiSpace),
            'features.crossSpaceTransfer': Boolean(draft.features.crossSpaceTransfer),
            'features.crossSpaceRecall': Boolean(draft.features.crossSpaceRecall),
            'dream.useLlm': Boolean(draft.dream.useLlm),
            'dream.minGroupSize': Number(draft.dream.minGroupSize),
            'dream.maxGroupsPerRun': Number(draft.dream.maxGroupsPerRun),
            'dream.maxSummaryChars': Number(draft.dream.maxSummaryChars),
            'dream.maxSourceChars': Number(draft.dream.maxSourceChars),
            'dream.maxEventsPerGroup': Number(draft.dream.maxEventsPerGroup),
            'dream.llmTimeoutMs': Number(draft.dream.llmTimeoutMs),
            'dream.failureThreshold': Number(draft.dream.failureThreshold),
            'dream.cooldownMinutes': Number(draft.dream.cooldownMinutes),
            'dream.compensateAfterHours': Number(draft.dream.compensateAfterHours),
            'dream.onlyLowValley': Boolean(draft.dream.onlyLowValley),
            'l2Merge.enabled': Boolean(draft.l2Merge.enabled),
            'l2Merge.minGroupSize': Number(draft.l2Merge.minGroupSize),
            'l2Merge.maxGroupsPerRun': Number(draft.l2Merge.maxGroupsPerRun),
            'l2Merge.maxSummaryChars': Number(draft.l2Merge.maxSummaryChars),
            'temp.ttlDays': Number(draft.temp.ttlDays),
            'temp.promotionWindowDays': Number(draft.temp.promotionWindowDays),
            'raw.mode': String(draft.rawMode),
            'raw.minSalience': Number(draft.rawMinSalience),
            'raw.maxTotalMb': Number(draft.rawMaxTotalMb),
            'raw.retentionDays': Number(draft.rawRetentionDays),
            'raw.maxScanTurns': Number(draft.rawMaxScanTurns),
            'delete.graceHours': Number(draft.deleteGraceHours),
            'review.enabled': Boolean(draft.reviewEnabled),
            'tagTree.midHalfLifeMultiplier': Number(draft.tagTree.midHalfLifeMultiplier),
            'tagTree.midGracePeriodDays': Number(draft.tagTree.midGracePeriodDays),
            'tagTree.pruneBatchSize': Number(draft.tagTree.pruneBatchSize),
            'tagTree.leafDecayFloor': Number(draft.tagTree.leafDecayFloor),
            'identity.eventTimePolicy': draft.eventTimePolicy,
          };
          try {
            const { body } = await getJson(API.config, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ patch }),
            });
            if (body && body.ok === true) {
              setDraft(draftFromConfig(body.config));
              setStatus({ tone: body.persisted ? 'ok' : 'warn', text: body.persisted ? '已保存并生效' : `已生效（未持久化）：${body.note || ''}` });
              // The panel listens for this: it refetches stats + graph right away
              // instead of waiting for the next 3s poll.
              announce('config-changed');
            } else {
              const error = (body && body.error) || {};
              setStatus({ tone: 'error', text: `${error.code || 'MEM_E_UNKNOWN'}: ${error.message || '保存失败'}` });
            }
          } catch (error) {
            setStatus({ tone: 'error', text: String((error && error.message) || error) });
          } finally {
            setSaving(false);
          }
        };

        const disabled = saving || shellState !== 'ready';

        // Escape hatch handler: clear session baseline + in-flight guard + marker.
        // It never deletes memories; if it fails the panel reports the code plainly.
        const resetHandoffState = async () => {
          setEscapeBusy(true);
          setEscapeStatus(null);
          try {
            const { status: httpStatus, body } = await getJson(API.sessionReset, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ reason: 'ui_escape_hatch' }),
            });
            if (body && body.ok === true) {
              setEscapeStatus({ tone: 'ok', text: '已重置交接状态：会话基线清零、handoff 标记已消费' });
              announce('config-changed');
            } else {
              const error = (body && body.error) || {};
              setEscapeStatus({ tone: 'error', text: `重置失败：${error.code || 'MEM_E_UNKNOWN'} ${error.message || `HTTP ${httpStatus}`}` });
            }
          } catch (error) {
            setEscapeStatus({ tone: 'error', text: `重置失败：${(error && error.message) || error}` });
          } finally {
            setEscapeBusy(false);
          }
        };

        return h(
          'div',
          { style: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 720 } },
          h('div', { style: { fontSize: 16, fontWeight: 600 } }, '海马体记忆'),
          h('div', { style: labelStyle }, '保存后立即作用于运行时（fail-fast 校验，越界会被拒绝），并在可持久化时写回 Loader 配置。'),
          shellState !== 'ready'
            ? h(
                'div',
                {
                  style: {
                    padding: '8px 12px',
                    borderRadius: 10,
                    border: `1px solid ${palette.warn}`,
                    color: palette.warn,
                    fontSize: 12,
                  },
                },
                `当前状态：${shellState}。可以查看配置，但写入要等记忆库就绪（写入会被 MEM_E_NOT_READY 拒绝，不会静默丢失）。`,
              )
            : null,
          status && status.tone === 'error'
            ? h(
                'div',
                {
                  style: {
                    padding: '10px 12px',
                    borderRadius: 10,
                    border: `1px solid ${palette.danger}`,
                    background: 'rgba(217,83,79,0.12)',
                    color: palette.danger,
                    fontSize: 13,
                  },
                },
                status.text,
              )
            : null,
          h(
            Section,
            { title: '行为' },
            h(Toggle, {
              label: '空闲时自动整理（Dream）',
              hint: `连续 ${draft.dreamIdleMinutes} 分钟没有记忆工具调用后跑一次维护（与 Cron 共用同一入口）。`,
              checked: draft.enableDream,
              onChange: (value) => edit('enableDream', value),
              disabled,
            }),
            h(Toggle, {
              label: '反思提示（Reflection）',
              hint: '连续工具调用达到阈值后，在提示里追加自我检查。',
              checked: draft.enableReflection,
              onChange: (value) => edit('enableReflection', value),
              disabled,
            }),
            h(Toggle, {
              label: '提示词简报（briefing）',
              hint: '在系统提示里放入一行记忆状态摘要。',
              checked: draft.briefing,
              onChange: (value) => edit('briefing', value),
              disabled,
            }),
            h(Toggle, {
              label: '提示注入（promptSection）',
              hint: '注册 memory 提示段，教模型何时写、何时读。',
              checked: draft.promptSection,
              onChange: (value) => edit('promptSection', value),
              disabled,
            }),
            h(Toggle, {
              label: '启动后立即维护（autoMaintainOnBoot）',
              checked: draft.autoMaintainOnBoot,
              onChange: (value) => edit('autoMaintainOnBoot', value),
              disabled,
            }),
          ),
          // Tool schema pruning (v1.5.3): every enabled tool pays its JSON schema
          // in prompt tokens on every turn. Disabled entries are validated server
          // side (unknown/core names abort activation), so the save cannot lie.
          h(
            Section,
            {
              title: '工具 schema 裁剪（tools.disabled）',
              hint: '每个工具定义都会在每轮提示中占用固定 schema token。裁剪低频工具可降低底座税；核心工具 remember / recall / admin 不可关闭。保存后写回配置，下次宿主启动（或重载插件）时真正跳过注册。',
            },
            h(
              'div',
              { style: { ...labelStyle, marginBottom: 6 } },
              `已裁剪 ${Array.isArray(draft.tools.disabled) ? draft.tools.disabled.length : 0} 个 · 下次启动注册 ${TOOL_CATALOG.length - (Array.isArray(draft.tools.disabled) ? draft.tools.disabled.length : 0)} 个（核心 3 个始终保留）`,
            ),
            TOOL_CATALOG.map((tool) => {
              const disabledList = Array.isArray(draft.tools.disabled) ? draft.tools.disabled : [];
              const enabled = tool.core || !disabledList.includes(tool.name);
              return h(Toggle, {
                key: tool.name,
                label: `${tool.name}（${tool.core ? '核心 · 不可关闭' : '低频 · 可裁剪'}）`,
                hint: `${tool.hint}${tool.core ? '' : ' 关闭后该工具不注册、提示词也不再宣传它。'}`,
                checked: enabled,
                disabled: tool.core || disabled,
                onChange: (value) => {
                  const next = new Set(Array.isArray(draft.tools.disabled) ? draft.tools.disabled : []);
                  if (value) next.delete(tool.name);
                  else next.add(tool.name);
                  edit('tools.disabled', [...next]);
                },
              });
            }),
          ),
          h(
            Section,
            {
              title: '入库自动打标（Pre-Ingest Tagging）',
              hint: '模型手传 tags 优先；未传 tags 时由引擎从内容形态提取 1–2 个锚点（错误类型 / errno / 代码块语言 / HTTP 状态 / 文件路径 / 任务语句）。raw 保持纯净，锚点直接进 L1.5 索引；提取不到只记 MEM_E_AUTO_TAG_MISS 警告，不阻断写入。',
            },
            h(Toggle, {
              label: '启用引擎侧自动打标（tagging.autoTag）',
              checked: draft.tagging.autoTag,
              onChange: (value) => edit('tagging.autoTag', value),
              disabled,
            }),
            h(Field, {
              label: '最多自动标签数（tagging.maxTags）',
              hint: '1 – 5，默认 2。只影响未手传 tags 的写入。',
              value: draft.tagging.maxTags,
              min: 1,
              max: 5,
              step: 1,
              onChange: (value) => edit('tagging.maxTags', value),
              disabled,
            }),
          ),
          h(
            Section,
            {
              title: '可选能力（微内核边界）',
              hint: '关闭多空间后，本体退化为严格单空间核心：targetSpaceId 只能是 default，空间工具与 /spaces、/transfer 路由返回 MEM_E_FEATURE_DISABLED。跨空间迁移必须同时启用多空间。保存后立即生效；工具注册在下次宿主启动/重载时真正移除。',
            },
            h(Toggle, {
              label: '启用多空间路由（features.multiSpace）',
              checked: draft.features.multiSpace,
              onChange: (value) => edit('features.multiSpace', value),
              disabled,
            }),
            h(Toggle, {
              label: '允许跨空间迁移（features.crossSpaceTransfer）',
              hint: '关闭后 space_transfer / transfer_to_global 工具不再注册，迁移路由直接拒绝。',
              checked: draft.features.crossSpaceTransfer,
              onChange: (value) => edit('features.crossSpaceTransfer', value),
              disabled: disabled || !draft.features.multiSpace,
            }),
            h(Toggle, {
              label: '跨空间召回聚合（features.crossSpaceRecall，默认关）',
              hint: '开启后每次 recall 会查询所有已打开空间并合并命中（月记可遮住它拥有的其他空间事件）；代价是每次召回多查 N 个空间。',
              checked: draft.features.crossSpaceRecall,
              onChange: (value) => edit('features.crossSpaceRecall', value),
              disabled: disabled || !draft.features.multiSpace,
            }),
          ),
          h(
            Section,
            {
              title: '离线 Dream（LLM 蒸馏）',
              hint: 'Dream 在空闲/补偿时蒸馏同标签经验；失败会本地降级并记 MEM_E_DREAM_LLM_FALLBACK。Endpoint / Model / API Key 只从 profile 配置或 DSH_DREAM_LLM_* 环境变量注入，绝不会下发到浏览器，也不能在此页填写。',
            },
            h(Toggle, {
              label: '启用 LLM 提炼（dream.useLlm）',
              hint: '关闭后只用本地启发式合并（时间范围 + 去重文本），不发任何网络请求。',
              checked: draft.dream.useLlm,
              onChange: (value) => edit('dream.useLlm', value),
              disabled,
            }),
            h(Field, {
              label: '成组最少条数（dream.minGroupSize）',
              value: draft.dream.minGroupSize,
              min: 2,
              max: 50,
              step: 1,
              onChange: (value) => edit('dream.minGroupSize', value),
              disabled,
            }),
            h(Field, {
              label: '单次最多蒸馏组数（dream.maxGroupsPerRun）',
              value: draft.dream.maxGroupsPerRun,
              min: 1,
              max: 50,
              step: 1,
              onChange: (value) => edit('dream.maxGroupsPerRun', value),
              disabled,
            }),
            h(Field, {
              label: '摘要字数上限（dream.maxSummaryChars）',
              value: draft.dream.maxSummaryChars,
              min: 40,
              max: 2000,
              step: 20,
              onChange: (value) => edit('dream.maxSummaryChars', value),
              disabled,
            }),
            h(Field, {
              label: '单条来源字数上限（dream.maxSourceChars）',
              value: draft.dream.maxSourceChars,
              min: 80,
              max: 4000,
              step: 40,
              onChange: (value) => edit('dream.maxSourceChars', value),
              disabled,
            }),
            h(Field, {
              label: '每组最多来源条数（dream.maxEventsPerGroup）',
              value: draft.dream.maxEventsPerGroup,
              min: 2,
              max: 50,
              step: 1,
              onChange: (value) => edit('dream.maxEventsPerGroup', value),
              disabled,
            }),
            h(Field, {
              label: 'LLM 超时（毫秒，dream.llmTimeoutMs）',
              value: draft.dream.llmTimeoutMs,
              min: 500,
              max: 120000,
              step: 500,
              onChange: (value) => edit('dream.llmTimeoutMs', value),
              disabled,
            }),
            h(Field, {
              label: '熔断阈值（dream.failureThreshold）',
              hint: '连续失败达到该次数即熔断 LLM，冷却期内只本地降级。',
              value: draft.dream.failureThreshold,
              min: 1,
              max: 20,
              step: 1,
              onChange: (value) => edit('dream.failureThreshold', value),
              disabled,
            }),
            h(Field, {
              label: '熔断冷却（分钟，dream.cooldownMinutes）',
              value: draft.dream.cooldownMinutes,
              min: 1,
              max: 1440,
              step: 1,
              onChange: (value) => edit('dream.cooldownMinutes', value),
              disabled,
            }),
            h(Field, {
              label: '会话开始时补偿阈值（小时，dream.compensateAfterHours）',
              hint: '超过该时长没有 Dream 且价格窗口允许时，会话开始会补跑一次。',
              value: draft.dream.compensateAfterHours,
              min: 1,
              max: 720,
              step: 1,
              onChange: (value) => edit('dream.compensateAfterHours', value),
              disabled,
            }),
            h(Toggle, {
              label: '只在低谷窗口跑 LLM Dream（dream.onlyLowValley）',
              hint: '北京时间工作日 09–12、14–18 为高峰；其余时段与周末才发起 LLM 调用。关闭后任何时段都可能调用。',
              checked: draft.dream.onlyLowValley,
              onChange: (value) => edit('dream.onlyLowValley', value),
              disabled,
            }),
          ),
          h(
            Section,
            {
              title: 'L2 多合一蒸馏',
              hint: '维护时把同一标签下的重复经验合并成一条：pinned 只与 pinned 合并、普通只与普通合并，永不混组；全局大标签只保留为 meta.global_tags，不写入倒排索引。原始记录标记为已合并（state/l2-merge.json），仍可追溯。',
            },
            h(Toggle, {
              label: '启用 L2 合并（l2Merge.enabled）',
              checked: draft.l2Merge.enabled,
              onChange: (value) => edit('l2Merge.enabled', value),
              disabled,
            }),
            h(Field, {
              label: '成组最少条数（l2Merge.minGroupSize）',
              value: draft.l2Merge.minGroupSize,
              min: 2,
              max: 20,
              step: 1,
              onChange: (value) => edit('l2Merge.minGroupSize', value),
              disabled,
            }),
            h(Field, {
              label: '单次最多合并组数（l2Merge.maxGroupsPerRun）',
              value: draft.l2Merge.maxGroupsPerRun,
              min: 1,
              max: 50,
              step: 1,
              onChange: (value) => edit('l2Merge.maxGroupsPerRun', value),
              disabled,
            }),
            h(Field, {
              label: '合并文本字数上限（l2Merge.maxSummaryChars）',
              value: draft.l2Merge.maxSummaryChars,
              min: 100,
              max: 2000,
              step: 20,
              onChange: (value) => edit('l2Merge.maxSummaryChars', value),
              disabled,
            }),
          ),
          h(
            Section,
            { title: '调度' },
            h(TextInput, {
              label: '维护 Cron（5 段）',
              hint: '例：0 */6 * * *（每 6 小时）。非法表达式会被后端拒绝。',
              value: draft.maintenanceCron,
              onChange: (value) => edit('maintenanceCron', value),
              disabled,
            }),
            h(Field, {
              label: '空闲判定（分钟）',
              value: draft.dreamIdleMinutes,
              min: 1,
              max: 525600,
              step: 1,
              onChange: (value) => edit('dreamIdleMinutes', value),
              disabled,
            }),
          ),
          h(
            Section,
            { title: '检索', hint: '默认 topK 不得超过检索上限。' },
            h(Field, {
              label: '默认 topK（retrieval.topK）',
              value: draft.retrievalTopK,
              min: 1,
              max: 1000,
              step: 1,
              onChange: (value) => edit('retrievalTopK', value),
              disabled,
            }),
            h(Field, {
              label: '检索上限（maxRecallTopK）',
              value: draft.maxRecallTopK,
              min: 1,
              max: 1000,
              step: 1,
              onChange: (value) => edit('maxRecallTopK', value),
              disabled,
            }),
          ),
          h(
            Section,
            { title: '上下文窗口' },
            h(Field, {
              label: '预算（token）',
              hint: '日常 4000；长视频或重构时建议 8000 - 12000。',
              value: draft.context.maxTokens,
              min: 256,
              max: 1000000,
              step: 256,
              onChange: (value) => edit('context.maxTokens', value),
              disabled,
            }),
            h(Field, {
              label: '单次召回注入上限（token）',
              hint: '一次 recall 返回 JSON 的硬上限（默认 4000，256 – 100000）。超限会截断并带 truncated:true，绝不静默超发。',
              value: draft.context.maxInjectTokens,
              min: 256,
              max: 100000,
              step: 256,
              onChange: (value) => edit('context.maxInjectTokens', value),
              disabled,
            }),
            h(Field, {
              label: '淘汰阈值',
              hint: '占用超过该比例即开始淘汰，必须大于收敛目标。',
              value: draft.context.threshold,
              min: 0.1,
              max: 0.99,
              step: 0.01,
              onChange: (value) => edit('context.threshold', value),
              disabled,
            }),
            h(Field, {
              label: '收敛目标',
              value: draft.context.target,
              min: 0.05,
              max: 0.98,
              step: 0.01,
              onChange: (value) => edit('context.target', value),
              disabled,
            }),
            h(Toggle, {
              label: '注入上下文预算段（context.injectPrompt）',
              checked: draft.context.injectPrompt,
              onChange: (value) => edit('context.injectPrompt', value),
              disabled,
            }),
          ),
          h(
            Section,
            {
              title: '空间与会话交接（纯物理层）',
              hint: '空间切换在面板顶部 SpaceSelector（全局，本页也会跟随）；本区只调路由相关开关与会话窗口记账。业务记忆迁移走面板勾选 + 移动到…（二次授权）。',
            },
            // The same status bar as the panel, fed by the stats payload's
            // panel.session — the operator sees the handoff countdown while tuning
            // the threshold that produces it.
            h(
              'div',
              {
                style: {
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                  fontSize: 12,
                  color: palette.muted,
                  marginBottom: 6,
                  fontVariantNumeric: 'tabular-nums',
                },
              },
              statusBarText(sessionPanel),
            ),
            h('div', { style: { ...labelStyle, marginBottom: 4 } }, `当前空间：${displayedSpace}`),
            // v1.5.4 ESCAPE HATCH: the recovery path for a stuck handoff. Only
            // state/ is rewritten (baseline + in-flight guard + marker); memories
            // are never touched, so it is always safe to click.
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '2px 0 8px' } },
              h(
                'button',
                { type: 'button', onClick: resetHandoffState, disabled: escapeBusy, style: smallButtonStyle },
                escapeBusy ? '重置中…' : '强制重置交接状态（逃生舱）',
              ),
              h(
                'span',
                { style: { ...labelStyle, marginBottom: 0 } },
                '当交接卡死/无法开新会话时使用：清零会话 token 基线、释放 in-flight 锁并消费 handoff.json，不删除任何记忆。',
              ),
              escapeStatus
                ? h(
                    'span',
                    { style: { fontSize: 12, color: escapeStatus.tone === 'error' ? palette.danger : palette.accent } },
                    escapeStatus.text,
                  )
                : null,
            ),
            h(Toggle, {
              label: '强制用户授权（context.requireExplicitConsentForTransfer）',
              hint: '默认开启：AI 直接调用迁移工具会被引擎拦截并返回 MEM_E_REQUIRE_USER_CONSENT；只有你（人类）在面板里手动点选才放行。除非明确知道风险，不要关闭。',
              checked: draft.context.requireExplicitConsentForTransfer,
              onChange: (value) => edit('context.requireExplicitConsentForTransfer', value),
              disabled,
            }),
            h(Toggle, {
              label: '空间软跟随（context.autoSpaceFollow）',
              hint: '开启后跨空间操作完成，UI 自动切换到目标空间',
              checked: draft.context.autoSpaceFollow,
              onChange: (value) => edit('context.autoSpaceFollow', value),
              disabled,
            }),
            h(Toggle, {
              label: '自动交接（context.autoRolloverEnabled）',
              hint: '达到触发比例时提炼末尾摘要存为 L1.5 并设置交接标记；关闭则在 95% 时强制驱逐',
              checked: draft.context.autoRolloverEnabled,
              onChange: (value) => edit('context.autoRolloverEnabled', value),
              disabled,
            }),
            h(Slider, {
              label: '交接触发比例（context.autoRolloverThreshold）',
              hint: '占原生窗口的比例，默认 0.85（85%）：达到后触发自动交接。调低→更早交班、原生窗口用得更短；调高→更晚交班、更接近窗口上限。',
              value: draft.context.autoRolloverThreshold,
              min: 0.5,
              max: 0.99,
              step: 0.01,
              onChange: (value) => edit('context.autoRolloverThreshold', value),
              disabled,
            }),
            h(Field, {
              label: '原生窗口（context.nativeTokenLimit）',
              hint: '低于该 Token 数绝不折叠（Qwen 原生模式）；超过则走 L1.5 分层折叠',
              value: draft.context.nativeTokenLimit,
              min: 512,
              max: 1000000,
              step: 512,
              disabled,
              onChange: (value) => edit('context.nativeTokenLimit', value),
            }),
            h(Slider, {
              label: '单标签索引上限（index.maxPostingsPerTag）',
              hint: '每个标签最多保留的最新且显著度最高的指针数，默认 500；超出部分只移出内存索引，JSONL 完整保留',
              value: draft.index.maxPostingsPerTag,
              min: 1,
              max: 100000,
              step: 1,
              onChange: (value) => edit('index.maxPostingsPerTag', value),
              disabled,
            }),
            // UI_TASK_1/3: manual event_ids + target_space_id inputs are REMOVED.
            // Business-data transfer exists only in the panel checkbox flow
            // (勾选记忆 → 移动到… → 二次显式授权).
            h(
              'div',
              { style: { ...labelStyle, marginBottom: 0 } },
              '业务记忆的跨空间迁移请到「面板 → 勾选记忆 → 移动到…」完成：目标空间由空间选择器提供，且需要二次显式授权（requireExplicitConsentForTransfer）。此处不再提供 event_ids / target_space_id 手动输入。',
            ),
          ),
          // UI_TASK_1: physical dataDir migration is a SYSTEM-LEVEL tool, fully
          // decoupled from business-data transfer (no event ids, no spaces here).
          h(StorageMigratorUI, { config: serverConfig, disabled }),
          h(
            Section,
            { title: '原始回合留存（raw）', hint: '只做取证，不参与索引；高价值/代码/报错/工具输出才会留，且有日/总量/保留期上限。' },
            h(Select, {
              label: 'raw.mode',
              hint: 'salience：只留高价值轮次；all：全留（仍受上限）；off：关闭 deep_raw。',
              value: draft.rawMode,
              options: [
                { value: 'salience', label: 'salience — 只留高价值（默认）' },
                { value: 'all', label: 'all — 全量（受预算限制）' },
                { value: 'off', label: 'off — 不留 raw' },
              ],
              onChange: (value) => edit('rawMode', value),
              disabled,
            }),
            h(Field, {
              label: 'raw 最小显著度',
              value: draft.rawMinSalience,
              min: 0,
              max: 1,
              step: 0.05,
              onChange: (value) => edit('rawMinSalience', value),
              disabled,
            }),
            h(Field, {
              label: 'raw 总量上限（MB）',
              value: draft.rawMaxTotalMb,
              min: 16,
              max: 4096,
              step: 16,
              suffix: 'MB',
              onChange: (value) => edit('rawMaxTotalMb', value),
              disabled,
            }),
            h(Field, {
              label: 'raw 保留期（天）',
              value: draft.rawRetentionDays,
              min: 1,
              max: 365,
              step: 1,
              suffix: '天',
              onChange: (value) => edit('rawRetentionDays', value),
              disabled,
            }),
            h(Field, {
              label: 'deep_raw 扫描回合上限（raw.maxScanTurns）',
              hint: 'deep_raw 从最新记录倒序最多扫描的回合数（默认 5000，下次 deep_raw 即生效）。调大可回溯更久但更慢；超出上限会 truncated=true 并在 notes 说明。',
              value: draft.rawMaxScanTurns,
              min: 500,
              max: 50000,
              step: 500,
              onChange: (value) => edit('rawMaxScanTurns', value),
              disabled,
            }),
          ),
          h(
            Section,
            { title: '删除与复习', hint: '两阶段删除先挂起，宽限期内 restore 可取消；复习排期由引擎推进。' },
            h(Field, {
              label: '删除宽限期（小时）',
              hint: '0 = 立即执行（旧行为）；默认 24 小时。',
              value: draft.deleteGraceHours,
              min: 0,
              max: 168,
              step: 1,
              suffix: '小时',
              onChange: (value) => edit('deleteGraceHours', value),
              disabled,
            }),
            h(Toggle, {
              label: '启用间隔重复复习（1,2,4,7,15,30 天）',
              hint: 'reinforce 会让事件进入下一档；到期项由 maintain 汇总到 memory_admin action=reviews。',
              checked: draft.reviewEnabled,
              onChange: (value) => edit('reviewEnabled', value),
              disabled,
            }),
          ),
          h(
            Section,
            { title: '存储与图谱', hint: '存储预算只影响左上角环形图的阈值，不会删除任何数据。' },
            h(Field, {
              label: '存储预算上限（MB）',
              hint: '普通用户 50MB；重度用户可调至 200MB+。软上限：超限只在环形图标红，不删档。',
              value: draft.storageBudgetMb,
              min: 10,
              max: 1000,
              step: 10,
              suffix: 'MB',
              onChange: (value) => edit('storageBudgetMb', value),
              disabled,
            }),
            h(Field, {
              label: '图谱最大边数（graphMaxEdges）',
              hint: '保存后立即按新上限重新拉取 /api/hippocampus/graph 并重绘。',
              value: draft.graphMaxEdges,
              min: 100,
              max: 2000,
              step: 100,
              onChange: (value) => edit('graphMaxEdges', value),
              disabled,
            }),
          ),
          h(
            Section,
            {
              title: '标签树（L1.5 幽灵宽限）',
              hint: '层级标签的生死节奏：root 永生、leaf 引用归零即死、mid 在宽限期内变"幽灵"（recall 只给元数据、引导 deep_raw），过期未复活才消亡。四个值都在下一次维护生效。',
            },
            h(Slider, {
              label: 'mid 半衰期倍率（tagTree.midHalfLifeMultiplier）',
              hint: 'mid 半衰期 = 倍率 × leaf 半衰期（1 天）。默认 3：mid 比叶子多活 3 倍。调大→幽灵留存更久，历史更完整；调小→层级更快被清理。',
              value: draft.tagTree.midHalfLifeMultiplier,
              min: 1,
              max: 10,
              step: 0.5,
              onChange: (value) => edit('tagTree.midHalfLifeMultiplier', value),
              disabled,
            }),
            h(Slider, {
              label: 'mid 宽限期（tagTree.midGracePeriodDays）',
              hint: 'mid 失去最后一个叶子后的宽限天数（默认 30）。期内新叶子可立即复活它；期内召回只返回"存在模糊记忆"的元数据，绝不注入正文。',
              value: draft.tagTree.midGracePeriodDays,
              min: 7,
              max: 180,
              step: 1,
              suffix: '天',
              onChange: (value) => edit('tagTree.midGracePeriodDays', value),
              disabled,
            }),
            h(Slider, {
              label: '剪枝批大小（tagTree.pruneBatchSize）',
              hint: '每次维护最多消费的待修剪叶子数（默认 100）。调小→死叶分批消失、队列落盘跨重启排空，避免一次维护风暴。',
              value: draft.tagTree.pruneBatchSize,
              min: 10,
              max: 500,
              step: 10,
              onChange: (value) => edit('tagTree.pruneBatchSize', value),
              disabled,
            }),
            h(Slider, {
              label: 'leaf 衰减地板（tagTree.leafDecayFloor）',
              hint: '0 = 只按引用归零死亡（严格 forget 驱动）；>0 时衰减低于该分数、又被排队的叶子会被修剪。0.05 ≈ 5 个叶子寿命后进入历史视图。',
              value: draft.tagTree.leafDecayFloor,
              min: 0,
              max: 1,
              step: 0.01,
              onChange: (value) => edit('tagTree.leafDecayFloor', value),
              disabled,
            }),
          ),
          h(
            Section,
            { title: '老化与活跃集合', hint: '这两个值同时是策略参数：写入 config 即进入 policy，下一次维护生效。' },
            h(Field, {
              label: '记忆半衰期（decay.halfLifeDays）',
              hint: '默认 30 天。调大能记住更久。',
              value: draft.decayHalfLifeDays,
              min: 7,
              max: 365,
              step: 1,
              suffix: '天',
              onChange: (value) => edit('decayHalfLifeDays', value),
              disabled,
            }),
            h(Field, {
              label: '活跃标签上限（activeSet.cap）',
              hint: '默认 200。多项目并行可调至 500（下次维护生效）。',
              value: draft.activeSetCap,
              min: 100,
              max: 1000,
              step: 50,
              onChange: (value) => edit('activeSetCap', value),
              disabled,
            }),
          ),
          h(
            Section,
            { title: 'L2.5 趋势隔离' },
            h(Field, {
              label: '隔离期（天）',
              value: draft.temp.ttlDays,
              min: 1,
              max: 3650,
              step: 1,
              suffix: '天',
              onChange: (value) => edit('temp.ttlDays', value),
              disabled,
            }),
            h(Field, {
              label: '晋升窗口（天）',
              hint: '必须不大于隔离期。',
              value: draft.temp.promotionWindowDays,
              min: 0,
              max: 3650,
              step: 1,
              suffix: '天',
              onChange: (value) => edit('temp.promotionWindowDays', value),
              disabled,
            }),
          ),
          h(
            Section,
            { title: '身份' },
            h(Select, {
              label: '事件时间策略（identity.eventTimePolicy）',
              hint: 'content：由内容推导；explicit：调用方必须提供；ingest：使用写入时刻。',
              value: draft.eventTimePolicy,
              options: EVENT_TIME_OPTIONS,
              onChange: (value) => edit('eventTimePolicy', value),
              disabled,
            }),
          ),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 12, position: 'sticky', bottom: 0, padding: '8px 0', background: 'transparent' } },
            h(
              'button',
              {
                type: 'button',
                onClick: save,
                disabled: saving,
                style: {
                  padding: '7px 18px',
                  borderRadius: 8,
                  border: `1px solid ${palette.accent}`,
                  background: saving ? 'transparent' : palette.accent,
                  color: '#fff',
                  cursor: saving ? 'default' : 'pointer',
                  fontSize: 13,
                },
              },
              saving ? '保存中…' : '保存全部',
            ),
            status && status.tone !== 'error' ? h('span', { style: { fontSize: 12, color: status.tone === 'warn' ? palette.warn : palette.accent } }, status.text) : null,
          ),
          // The very bottom of the settings content (after the save row): the
          // promise the engine can actually keep. Sessions die; the persona does not.
          h(
            'div',
            { style: { paddingTop: 10, borderTop: `1px solid ${palette.border}`, fontSize: 12, fontWeight: 600, color: palette.muted } },
            '本插件不能保证一个会话永生不死，只能保证人格不死。',
          ),
        );
      }
      return {
        inject: ['slots'],
        // Exported for the bundle-contract tests: the pure retry decision is the
        // piece the P0 fix depends on, so it must be testable without a browser.
        retryPolicy: decideRetry,
        // Pure geometry for the history view: testable without a DOM.
        ghostGraphParts,
        // v1.5.0 pure helpers. The panel/settings can only be exercised in a
        // browser, but these three carry every decision worth locking: the session
        // status line, query filtering (edge consistency) and soft space-follow.
        statusBarText,
        filterGraphByQuery,
        nextSpaceAfterTransfer,
        // v1.5.3 route-drift defences, exported so the bundle-contract tests can
        // lock them without a browser: capability handshake + human error mapper.
        spaceCreateAvailable,
        describeSpaceError,
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
