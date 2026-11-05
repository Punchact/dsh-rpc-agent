// @punchact/dsh-rpc-agent — Settings page.
//
// A browser module: the Host loads it into the Web UI and we register one entry
// in `settings.section`, so the bridge's live state is visible where a person
// looks for settings rather than only from a terminal.
//
// Rules that shaped this file (see the harness `ui-plugin.md`):
//  * no side effects at factory time — everything happens inside `apply`, and
//    everything registered there returns its own disposer;
//  * React comes from the browser module table, never a second copy;
//  * colours and fonts come from the Host theme variables, so light and dark
//    both work without a second palette;
//  * the payload we read carries no token and no prompt text, and the route is
//    loopback-only, so this page cannot become a way to read someone's session.

window.__ModuleLoader__.load({
  id: "@punchact/dsh-rpc-agent",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    const NS = "dsh-rpc";
    const SLOT = "settings.section";
    // Static browser code cannot read `endpoint.json`; the Host mounts this path
    // as an alias whenever the configured base differs from the default.
    const STATUS_URL = "/dsh-rpc/status";
    const POLL_MS = 2000;

    const DICTS = {
      zh: {
        sectionLabel: "RPC 桥接",
        title: "RPC 桥接状态",
        subtitle: "本机的其他 AI agent 通过这里驱动 DSH。",
        online: "运行中",
        offline: "连不上",
        loading: "读取中…",
        endpoint: "端点",
        tokenSource: "令牌来源",
        tokenPaths: { config: "配置项", env: "环境变量", file: "文件", unknown: "未知" },
        servedFor: "已服务",
        pid: "进程号",
        node: "Node",
        protocol: "协议版本",
        allowRemote: "允许远程",
        yes: "是",
        no: "否",
        activeRuns: "正在跑的轮次",
        noRuns: "现在没有轮次在跑。",
        runPrompt: "带提问",
        runWait: "仅等待",
        runAge: "已跑 {s}",
        recent: "最近调用",
        noCalls: "还没有调用记录。",
        colTime: "时间",
        colMethod: "方法",
        colCost: "耗时",
        colResult: "结果",
        ok: "成功",
        fail: "失败",
        methods: "方法用量",
        quickstart: "怎么接",
        configCard: "配置片段",
        configHint:
          "这是此刻生效的配置。贴进 profile 的 cordis.patch.yml，只留想改的键——删掉的那些会回到默认值。令牌永远不会出现在这里。",
        configCopy: "cordis.patch.yml",
        copy: "复制",
        copied: "已复制",
        refresh: "每 2 秒自动刷新",
        readError: "读取状态失败：",
        updated: "更新于",
        note: "令牌不在本页显示；它保存在",
      },
      en: {
        sectionLabel: "RPC bridge",
        title: "RPC bridge status",
        subtitle: "Other local AI agents drive DSH through here.",
        online: "Serving",
        offline: "Unreachable",
        loading: "Reading…",
        endpoint: "Endpoint",
        tokenSource: "Token source",
        tokenPaths: { config: "config", env: "environment", file: "file", unknown: "unknown" },
        servedFor: "Served for",
        pid: "PID",
        node: "Node",
        protocol: "Protocol",
        allowRemote: "Remote access",
        yes: "yes",
        no: "no",
        activeRuns: "Runs in flight",
        noRuns: "Nothing is running right now.",
        runPrompt: "asked",
        runWait: "wait only",
        runAge: "for {s}",
        recent: "Recent calls",
        noCalls: "No calls recorded yet.",
        colTime: "Time",
        colMethod: "Method",
        colCost: "Took",
        colResult: "Result",
        ok: "ok",
        fail: "failed",
        methods: "Method usage",
        quickstart: "How to call it",
        configCard: "Configuration snippet",
        configHint:
          "The values in effect right now. Paste into the profile's cordis.patch.yml and keep only the keys you mean to change — anything you drop falls back to its default. The token never appears here.",
        configCopy: "cordis.patch.yml",
        copy: "Copy",
        copied: "Copied",
        refresh: "refreshes every 2s",
        readError: "Could not read status: ",
        updated: "updated",
        note: "The token is never shown here; it lives at",
      },
    };

    function pickLang() {
      const raw = typeof navigator === "object" && navigator ? String(navigator.language || "") : "";
      return raw.toLowerCase().startsWith("en") ? "en" : "zh";
    }

    /** Static fallback: a missing or different Client locale service must not blank the page. */
    function makeTranslator(ctx) {
      const lang = pickLang();
      const table = DICTS[lang];
      try {
        const locale = typeof ctx.get === "function" ? ctx.get("locale") : undefined;
        if (locale && typeof locale.register === "function" && typeof locale.bind === "function") {
          const dispose = locale.register(NS, DICTS);
          const bound = locale.bind(NS);
          if (typeof bound === "function") {
            return {
              lang,
              dispose: typeof dispose === "function" ? dispose : () => {},
              t(key) {
                try {
                  const value = bound(key);
                  if (typeof value === "string" && value.length > 0) return value;
                } catch {
                  // fall through to the bundled table
                }
                return table[key] ?? key;
              },
            };
          }
        }
      } catch {
        // fall through
      }
      return { lang, dispose: () => {}, t: (key) => table[key] ?? key };
    }

    // ------------------------------------------------------------------ style --

    const COLORS = {
      label: "var(--dsw-alias-label-primary, inherit)",
      muted: "var(--dsw-alias-label-secondary, #6b7280)",
      faint: "var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, #9ca3af))",
      line: "var(--dsw-alias-border-l2, rgba(128,128,128,.28))",
      panel: "var(--dsw-alias-bg-layer-1, transparent)",
      panelAlt: "var(--dsw-alias-bg-layer-2, rgba(128,128,128,.06))",
      good: "var(--dsw-alias-state-success-primary, #16a34a)",
      bad: "var(--dsw-alias-state-error-primary, #dc2626)",
      brand: "var(--dsw-alias-brand-primary, #4d6bfe)",
      mono: "var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)",
    };

    const S = {
      root: { display: "flex", flexDirection: "column", gap: 14, color: COLORS.label, fontSize: 13, lineHeight: 1.6 },
      head: { display: "flex", alignItems: "flex-start", gap: 10, flexWrap: "wrap" },
      dot: (on) => ({ width: 9, height: 9, borderRadius: "50%", marginTop: 7, flex: "none", background: on ? COLORS.good : COLORS.bad }),
      title: { fontSize: 15, fontWeight: 650, margin: 0 },
      sub: { margin: "2px 0 0", color: COLORS.muted, fontSize: 12 },
      right: { marginLeft: "auto", textAlign: "right", color: COLORS.faint, fontSize: 11, lineHeight: 1.5 },
      card: { border: `1px solid ${COLORS.line}`, borderRadius: 10, background: COLORS.panel, padding: "10px 12px" },
      cardTitle: { fontSize: 12, fontWeight: 650, color: COLORS.muted, margin: "0 0 8px", display: "flex", alignItems: "baseline", gap: 8 },
      badge: { borderRadius: 999, padding: "0 7px", fontSize: 11, fontWeight: 600, background: COLORS.panelAlt, color: COLORS.muted },
      grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: "6px 18px" },
      kv: { display: "flex", gap: 8, alignItems: "baseline", minWidth: 0 },
      k: { color: COLORS.muted, flex: "none", fontSize: 12 },
      v: { fontFamily: COLORS.mono, fontSize: 12, overflowWrap: "anywhere", minWidth: 0 },
      runRow: { display: "flex", gap: 8, alignItems: "baseline", padding: "3px 0", borderTop: `1px dashed ${COLORS.line}` },
      table: { width: "100%", borderCollapse: "collapse", fontSize: 12 },
      th: { textAlign: "left", color: COLORS.muted, fontWeight: 600, padding: "0 8px 4px 0", fontSize: 11 },
      td: { padding: "3px 8px 3px 0", fontFamily: COLORS.mono, borderTop: `1px dashed ${COLORS.line}` },
      mono: { fontFamily: COLORS.mono, fontSize: 12 },
      chipRow: { display: "flex", flexWrap: "wrap", gap: 6 },
      code: {
        display: "block",
        margin: "0 0 6px",
        padding: "7px 9px",
        borderRadius: 8,
        background: COLORS.panelAlt,
        border: `1px solid ${COLORS.line}`,
        fontFamily: COLORS.mono,
        fontSize: 11.5,
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      },
      btn: {
        font: "inherit",
        fontSize: 11.5,
        color: COLORS.brand,
        background: "transparent",
        border: `1px solid ${COLORS.line}`,
        borderRadius: 999,
        padding: "1px 9px",
        cursor: "pointer",
      },
      err: { color: COLORS.bad, fontSize: 12 },
      empty: { color: COLORS.faint, fontSize: 12, margin: 0 },
    };

    // ---------------------------------------------------------------- helpers --

    function pad(value) {
      return String(value).padStart(2, "0");
    }

    function clock(iso) {
      if (typeof iso !== "string" || iso.length < 19) return "—";
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return "—";
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    function duration(ms) {
      if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
      if (ms < 1000) return `${Math.round(ms)}ms`;
      const seconds = ms / 1000;
      if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours}h ${minutes % 60}m`;
      return `${Math.floor(hours / 24)}d ${hours % 24}h`;
    }

    function useStatus() {
      const [snapshot, setSnapshot] = React.useState({ loading: true, data: null, error: null, at: 0 });

      React.useEffect(() => {
        let alive = true;
        let timer = null;

        const tick = () => {
          fetch(STATUS_URL, { cache: "no-store", headers: { accept: "application/json" } })
            .then((response) => {
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              return response.json();
            })
            .then((data) => {
              if (alive) setSnapshot({ loading: false, data, error: null, at: Date.now() });
            })
            .catch((error) => {
              if (alive) {
                setSnapshot((prev) => ({
                  loading: false,
                  data: prev.data,
                  error: error?.message ?? String(error),
                  at: Date.now(),
                }));
              }
            })
            .finally(() => {
              if (alive) timer = setTimeout(tick, POLL_MS);
            });
        };

        tick();
        return () => {
          alive = false;
          if (timer) clearTimeout(timer);
        };
      }, []);

      return snapshot;
    }

    function Row({ k, v }) {
      return h("div", { style: S.kv }, h("span", { style: S.k }, k), h("span", { style: S.v }, v));
    }

    function Card({ title, badge, children }) {
      return h(
        "section",
        { style: S.card },
        h("h4", { style: S.cardTitle }, title, badge === undefined ? null : h("span", { style: S.badge }, badge)),
        children,
      );
    }

    function CopyLine({ label, text, t }) {
      const [copied, setCopied] = React.useState(false);
      const stamp = React.useRef(null);

      React.useEffect(() => () => {
        if (stamp.current) clearTimeout(stamp.current);
      }, []);

      const copy = () => {
        const done = () => {
          setCopied(true);
          if (stamp.current) clearTimeout(stamp.current);
          stamp.current = setTimeout(() => setCopied(false), 1500);
        };
        if (typeof navigator !== "object" || !navigator.clipboard || typeof navigator.clipboard.writeText !== "function") return;
        navigator.clipboard.writeText(text).then(done, () => {});
      };

      return h(
        "div",
        { style: { marginBottom: 8 } },
        h(
          "div",
          { style: { display: "flex", alignItems: "baseline", gap: 8, marginBottom: 3 } },
          h("span", { style: { color: COLORS.muted, fontSize: 12 } }, label),
          h("button", { type: "button", style: S.btn, onClick: copy }, copied ? t("copied") : t("copy")),
        ),
        h("code", { style: S.code }, text),
      );
    }

    // A paste-ready row for the profile's patch layer, built from the values the
    // Host reports as live. Unset keys are dropped so the snippet stays readable
    // (anything omitted falls back to its default), and `token` is never emitted —
    // this page reads state back, it must not become a way to read a secret out of
    // the process.
    function patchSnippet(config) {
      const rows = [
        ["enabled", config?.enabled],
        ["path", config?.path],
        ["allowRemote", config?.allowRemote],
        ["defaultCwd", config?.defaultCwd],
        ["defaultAgentPreset", config?.defaultAgentPreset],
        ["defaultTimeoutMs", config?.defaultTimeoutMs],
        ["maxBodyBytes", config?.maxBodyBytes],
        ["maxSessions", config?.maxSessions],
        ["logRequests", config?.logRequests],
        ["tokenFile", config?.tokenFile],
      ].filter(([, value]) => value !== undefined && value !== null && value !== "");
      const body = rows
        .map(([key, value]) => `        ${key}: ${typeof value === "string" ? JSON.stringify(value) : value}`)
        .join("\n");
      return `- insert:\n    - id: dsh-rpc-bridge\n      name: '@punchact/dsh-rpc-agent'\n      config:\n${body}`;
    }

    // -------------------------------------------------------------- component --

    function makePage(t, lang) {
      const tokenPaths = (DICTS[lang] ?? DICTS.zh).tokenPaths;
      const sourceLabel = (source) => tokenPaths?.[source] ?? source ?? "—";

      return function BridgeStatusPage() {
      const { loading, data, error } = useStatus();
      const on = Boolean(data?.ok) && !error;
      const calls = data?.calls ?? {};
      const runs = Array.isArray(data?.activeRuns) ? data.activeRuns : [];
      const recent = Array.isArray(calls.recent) ? calls.recent : [];
      const byMethod = calls.byMethod && typeof calls.byMethod === "object" ? Object.entries(calls.byMethod) : [];
      const origin = data?.origin ?? null;
      const path = data?.path ?? "/dsh-rpc";

      const state = loading && !data ? t("loading") : on ? t("online") : t("offline");

      return h(
        "div",
        { style: S.root },
        h(
          "header",
          { style: S.head },
          h("span", { style: S.dot(on), "aria-hidden": "true" }),
          h(
            "div",
            { style: { minWidth: 0 } },
            h("h3", { style: S.title }, t("title")),
            h("p", { style: S.sub }, t("subtitle")),
          ),
          h(
            "div",
            { style: S.right },
            h("div", null, state, data?.version ? ` · v${data.version}` : ""),
            h("div", null, t("refresh")),
            data ? h("div", null, `${t("updated")} ${clock(new Date(Date.now()).toISOString())}`) : null,
          ),
        ),

        error ? h("p", { style: S.err }, `${t("readError")}${error}`) : null,

        h(
          Card,
          { title: t("endpoint") },
          h(
            "div",
            { style: S.grid },
            h(Row, { k: t("endpoint"), v: origin ? `${origin}${path}` : `${path}（${state}）` }),
            h(Row, { k: t("protocol"), v: data?.protocol ?? "—" }),
            h(Row, { k: t("tokenSource"), v: sourceLabel(data?.tokenSource) }),
            h(Row, { k: t("servedFor"), v: duration(data?.servedForMs) }),
            h(Row, { k: t("pid"), v: data?.pid ?? "—" }),
            h(Row, { k: t("node"), v: data?.node ?? "—" }),
            h(Row, { k: t("allowRemote"), v: data?.config?.allowRemote ? t("yes") : t("no") }),
            h(Row, { k: "calls", v: `${calls.total ?? 0}${calls.errors ? ` · ${calls.errors} ${t("fail")}` : ""}` }),
          ),
        ),

        h(
          Card,
          { title: t("activeRuns"), badge: String(runs.length) },
          runs.length === 0
            ? h("p", { style: S.empty }, t("noRuns"))
            : runs.map((run, index) =>
                h(
                  "div",
                  { style: index === 0 ? { ...S.runRow, borderTop: "none" } : S.runRow, key: run.run ?? index },
                  h("span", { style: S.mono }, run.run ?? "—"),
                  h("span", { style: { color: COLORS.muted, fontSize: 12 } }, run.prompt ? t("runPrompt") : t("runWait")),
                  h("span", { style: { marginLeft: "auto", color: COLORS.faint, fontSize: 12 } }, t("runAge").replace("{s}", duration(run.ageMs))),
                ),
              ),
        ),

        h(
          Card,
          { title: t("recent"), badge: String(recent.length) },
          recent.length === 0
            ? h("p", { style: S.empty }, t("noCalls"))
            : h(
                "table",
                { style: S.table },
                h(
                  "thead",
                  null,
                  h(
                    "tr",
                    null,
                    h("th", { style: S.th }, t("colTime")),
                    h("th", { style: S.th }, t("colMethod")),
                    h("th", { style: S.th }, t("colCost")),
                    h("th", { style: S.th }, t("colResult")),
                  ),
                ),
                h(
                  "tbody",
                  null,
                  recent.map((call, index) =>
                    h(
                      "tr",
                      { key: `${call.at ?? ""}-${index}` },
                      h("td", { style: S.td }, clock(call.at)),
                      h("td", { style: S.td }, call.method ?? "—"),
                      h("td", { style: S.td }, duration(call.ms)),
                      h(
                        "td",
                        { style: { ...S.td, color: call.ok ? COLORS.good : COLORS.bad } },
                        call.ok ? t("ok") : `${t("fail")} ${call.code ?? ""}`.trim(),
                      ),
                    ),
                  ),
                ),
              ),
        ),

        byMethod.length
          ? h(
              Card,
              { title: t("methods") },
              h(
                "div",
                { style: S.chipRow },
                byMethod.map(([method, entry]) =>
                  h("span", { key: method, style: { ...S.badge, fontFamily: COLORS.mono } }, `${method} × ${entry?.count ?? 0}`),
                ),
              ),
            )
          : null,

        h(
          Card,
          { title: t("quickstart") },
          h(CopyLine, { t, label: "CLI", text: "node bin/dsh-rpc.mjs ask \"总结一下这个仓库\" --cwd <你的目录>" }),
          h(CopyLine, { t, label: "MCP", text: `claude mcp add dsh-rpc -- node <path-to-your-clone>/bin/dsh-rpc-mcp.mjs` }),
          h("p", { style: { ...S.empty, marginTop: 6 } }, t("note"), " ", h("code", { style: S.mono }, data?.endpointPath ?? "~/.dsh/dsh-rpc/endpoint.json")),
        ),

        // Editable from here only as text: the row's config lives in the profile's
        // patch layer, so the useful thing to hand a person is the exact row to paste.
        h(
          Card,
          { title: t("configCard") },
          h("p", { style: { ...S.empty, marginBottom: 8 } }, t("configHint")),
          h(CopyLine, { t, label: t("configCopy"), text: patchSnippet(data?.config) }),
        ),
      );
      };
    }

    // ------------------------------------------------------------------ apply --

    return {
      name: NS,
      inject: ["slots"],
      apply(ctx) {
        const translator = makeTranslator(ctx);
        ctx.effect(() => translator.dispose, "dsh-rpc: locale");
        const Page = makePage(translator.t, translator.lang);

        ctx.slots.inject(SLOT, () =>
          ctx.slots.register(
            {
              name: SLOT,
              id: "dsh-rpc-status",
              order: 60,
              label: translator.t("sectionLabel"),
            },
            Page,
          ),
        );
      },
    };
  },
});
