/* global React */
/* Phase 2: drag-resize splits, CLI popover, settings, edit/delete,
   search overlay, error states, skeletons, onboarding, win menu, tooltip, toasts */
const { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect } = React;

// ─────────────── Extra icons ───────────────
const IconWarn   = (p) => <Icon {...p} d={<><path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></>}/>;
const IconErr    = (p) => <Icon {...p} d={<><circle cx="12" cy="12" r="9"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></>}/>;
const IconInfo   = (p) => <Icon {...p} d={<><circle cx="12" cy="12" r="9"/><path d="M12 16v-4"/><path d="M12 8h.01"/></>}/>;
const IconCheck2 = (p) => <Icon {...p} d={<><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></>}/>;
const IconRefresh= (p) => <Icon {...p} d={<><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></>}/>;
const IconPencil = (p) => <Icon {...p} d={<><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></>}/>;
const IconBack   = (p) => <Icon {...p} d={<><path d="m15 18-6-6 6-6"/></>}/>;
const IconHam    = (p) => <Icon {...p} d={<><path d="M3 6h18"/><path d="M3 12h18"/><path d="M3 18h18"/></>}/>;
const IconChevDn = (p) => <Icon {...p} d={<><path d="m6 9 6 6 6-6"/></>}/>;
const IconArrUp  = (p) => <Icon {...p} d={<><path d="m18 15-6-6-6 6"/></>}/>;
const IconArrDn  = (p) => <Icon {...p} d={<><path d="m6 9 6 6 6-6"/></>}/>;

// ─────────────── Tooltip ───────────────
function Tip({ label, keys, children, side = 'up' }) {
  const [show, setShow] = useState(false);
  const tRef = useRef(null);
  const onEnter = () => { tRef.current = setTimeout(() => setShow(true), 600); };
  const onLeave = () => { clearTimeout(tRef.current); setShow(false); };
  useEffect(() => () => clearTimeout(tRef.current), []);
  return (
    <span className="tt-host" onMouseEnter={onEnter} onMouseLeave={onLeave} onMouseDown={onLeave}>
      {children}
      {show && (
        <span className={`tt ${side === 'down' ? 'tt-down' : ''}`}>
          {label}
          {keys && <span style={{ display: 'inline-flex', gap: 2 }}>{keys.map((k,i) => <Kbd key={i}>{k}</Kbd>)}</span>}
        </span>
      )}
    </span>
  );
}

// ─────────────── Drag-resize splits ───────────────
function ResizableLayout({ node, panes, focusedPaneId, onFocusPane, cliMap, onLayoutChange,
                          searchQuery, searchPaneId, currentMatch, onMatchCountChange }) {
  // Decision: store ratios in node tree, mutate via path. Live preview during drag.
  // Min 200px per child enforced against container size.
  const setRatio = (path, ratio) => {
    const next = JSON.parse(JSON.stringify(node));
    let cur = next;
    for (const p of path.slice(0, -1)) cur = cur[p];
    cur[path[path.length - 1]] = ratio;
    onLayoutChange(next);
  };
  return <NodeView node={node} path={[]} setRatio={setRatio}
                   panes={panes} focusedPaneId={focusedPaneId}
                   onFocusPane={onFocusPane} cliMap={cliMap}
                   searchQuery={searchQuery} searchPaneId={searchPaneId}
                   currentMatch={currentMatch}
                   onMatchCountChange={onMatchCountChange}/>;
}

function NodeView({ node, path, setRatio, panes, focusedPaneId, onFocusPane, cliMap,
                    searchQuery, searchPaneId, currentMatch, onMatchCountChange }) {
  const containerRef = useRef(null);
  const handleRef = useRef(null);
  const [drag, setDrag] = useState(null);
  const [snap, setSnap] = useState(false);

  if (node.kind === 'pane') {
    const p = panes[node.paneId];
    if (!p) return null;
    return (
      <Pane2 pane={p}
             paneId={node.paneId}
             focused={node.paneId === focusedPaneId}
             onFocus={() => onFocusPane(node.paneId)}
             cliMap={cliMap}
             searchQuery={searchPaneId === node.paneId ? searchQuery : ''}
             currentMatch={searchPaneId === node.paneId ? currentMatch : 0}
             onMatchCountChange={(n) => searchPaneId === node.paneId && onMatchCountChange(n)}/>
    );
  }
  const isH = node.dir === 'h';
  const ratio = node.ratio ?? 0.5;
  const liveRatio = drag ? drag.ratio : ratio;
  const style = isH
    ? { display: 'grid', gridTemplateColumns: `${liveRatio}fr 6px ${1-liveRatio}fr`, height: '100%', minHeight: 0 }
    : { display: 'grid', gridTemplateRows:    `${liveRatio}fr 6px ${1-liveRatio}fr`, height: '100%', minHeight: 0 };

  const onDown = (e) => {
    e.preventDefault();
    const rect = containerRef.current.getBoundingClientRect();
    const total = isH ? rect.width : rect.height;
    setDrag({ ratio });
    const move = (ev) => {
      const pos = isH ? ev.clientX - rect.left : ev.clientY - rect.top;
      let r = pos / total;
      const minR = 200 / total;
      r = Math.max(minR, Math.min(1 - minR, r));
      setDrag({ ratio: r });
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setDrag(d => {
        if (d) {
          const r = d.ratio;
          setRatio([...path, 'ratio'], r);
          if (r > 0.48 && r < 0.52) {
            setSnap(true); setTimeout(() => setSnap(false), 200);
          }
        }
        return null;
      });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const onDouble = () => {
    setRatio([...path, 'ratio'], 0.5);
    setSnap(true); setTimeout(() => setSnap(false), 200);
  };

  return (
    <div ref={containerRef} style={style}>
      <NodeView node={node.a} path={[...path, 'a']} setRatio={setRatio}
                panes={panes} focusedPaneId={focusedPaneId}
                onFocusPane={onFocusPane} cliMap={cliMap}
                searchQuery={searchQuery} searchPaneId={searchPaneId}
                currentMatch={currentMatch} onMatchCountChange={onMatchCountChange}/>
      <div ref={handleRef}
           className={`${isH ? 'split-h' : 'split-v'} ${drag ? 'dragging' : ''} ${snap ? 'snap-pulse' : ''}`}
           onMouseDown={onDown}
           onDoubleClick={onDouble}/>
      <NodeView node={node.b} path={[...path, 'b']} setRatio={setRatio}
                panes={panes} focusedPaneId={focusedPaneId}
                onFocusPane={onFocusPane} cliMap={cliMap}
                searchQuery={searchQuery} searchPaneId={searchPaneId}
                currentMatch={currentMatch} onMatchCountChange={onMatchCountChange}/>
    </div>
  );
}

// ─────────────── Pane v2 (with search highlighting + error variant) ───────────────
function escapeReg(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function highlightLine(text, query, paneOffset, currentIdx) {
  if (!query) return text;
  const re = new RegExp(escapeReg(query), 'gi');
  const out = []; let last = 0; let m; let i = paneOffset.i;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const isCur = i === currentIdx;
    out.push(<mark key={`m${i}`} className={`m ${isCur ? 'cur' : ''}`}>{m[0]}</mark>);
    last = m.index + m[0].length;
    i += 1;
  }
  if (last < text.length) out.push(text.slice(last));
  paneOffset.i = i;
  return out;
}

function Pane2({ pane, paneId, focused, onFocus, cliMap, error, searchQuery, currentMatch, onMatchCountChange }) {
  const cli = cliMap[pane.cli] || { badge: '··', color: '#888', name: pane.cli };
  const termRef = useRef(null);
  useEffect(() => { if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight; }, [pane]);

  // Match count emit
  useEffect(() => {
    if (!searchQuery) { onMatchCountChange && onMatchCountChange(0); return; }
    const re = new RegExp(escapeReg(searchQuery), 'gi');
    let n = 0; pane.lines.forEach(l => { if (l.s) { const m = l.s.match(re); if (m) n += m.length; } });
    onMatchCountChange && onMatchCountChange(n);
  }, [searchQuery, pane]);

  const status = error
    ? <span className="pane-status" style={{ color: 'var(--error)' }}><span className="pulse" style={{ background: 'var(--error)', animation: 'none' }}/>error</span>
    : pane.status === 'live'
    ? <span className="pane-status"><span className="pulse"/>live</span>
    : pane.status === 'thinking'
    ? <span className="pane-status" style={{ color: 'var(--accent)' }}><span className="pulse" style={{ background: 'var(--accent)' }}/>working</span>
    : <span className="pane-status">idle</span>;

  // Track running offset for matches across lines
  const offset = { i: 0 };

  return (
    <div className={`pane ${focused ? 'focused' : ''}`} onMouseDown={onFocus}>
      <div className="pane-head">
        <span className="cli-badge">
          <span className="cli-dot" style={{ background: cli.color }}/>
          {cli.name}
        </span>
        <span className="cwd">{pane.cwd}</span>
        {status}
        <Tip label="Spawn CLI" keys={['⌘','T']}>
          <button className="pane-menu" onClick={(e) => e.stopPropagation()}><IconPlus size={12}/></button>
        </Tip>
        <Tip label="Pane menu">
          <button className="pane-menu"><IconMore size={13}/></button>
        </Tip>
      </div>
      {error ? (
        <PaneError error={error}/>
      ) : (
        <div className="term" ref={termRef}>
          {pane.lines.map((l, i) => {
            if (!l.s || !searchQuery) return renderLine(l, i);
            // Wrap rendered line with highlighted spans
            const className =
              l.t === 'prompt' ? 'ln' :
              l.t === 'cmd' ? 'ln' :
              l.t === 'sys' ? 'ln dim' :
              l.t === 'tool' ? 'ln accent' :
              l.t === 'thinking' ? 'ln dim' :
              l.t === 'ok' ? 'ln ok' :
              l.t === 'err' ? 'ln err' :
              l.t === 'warn' ? 'ln warn' :
              l.t === 'info' ? 'ln info' :
              l.t === 'dim' ? 'ln dim' :
              'ln';
            const parts = highlightLine(l.s, searchQuery, offset, currentMatch);
            const style =
              l.t === 'diff-add' ? { color: 'oklch(0.78 0.12 155)' } :
              l.t === 'diff-rm'  ? { color: 'oklch(0.74 0.16 25)' } :
              l.t === 'cmd' ? { fontWeight: 600, color: '#f0eee4' } :
              l.t === 'user' ? { color: '#e6e7e9' } :
              null;
            return <span key={i} className={className} style={style}>{parts}</span>;
          })}
        </div>
      )}
    </div>
  );
}

function PaneError({ error }) {
  return (
    <div className="pane-err">
      <div className="pane-err-card">
        <div className="pane-err-icon"><IconWarn size={18} sw={1.8}/></div>
        <div className="pane-err-h">Couldn't start CLI</div>
        <div className="pane-err-msg">{error.message}</div>
        <div className="pane-err-body">
          The CLI may not be installed, or your project's PATH may be missing the entry.
        </div>
        <div className="pane-err-acts">
          <button className="btn">Retry</button>
          <button className="btn">Pick another CLI</button>
        </div>
        <a className="pane-err-link">View install instructions ↗</a>
      </div>
    </div>
  );
}

// ─────────────── CLI launch popover ───────────────
function CliPopover({ clis, anchor, onPick, onClose, position = 'bottom-start' }) {
  const [sel, setSel] = useState(0);
  const ref = useRef(null);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s + 1, clis.length - 1)); }
      else if (e.key === 'ArrowUp')   { e.preventDefault(); setSel(s => Math.max(s - 1, 0)); }
      else if (e.key === 'Enter')     { e.preventDefault(); onPick(clis[sel]); }
      else if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        const i = parseInt(e.key, 10) - 1;
        if (clis[i]) onPick(clis[i]);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [clis, sel, onClose, onPick]);
  useEffect(() => {
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    setTimeout(() => window.addEventListener('mousedown', onClick), 0);
    return () => window.removeEventListener('mousedown', onClick);
  }, [onClose]);

  const style = anchor || {};
  return (
    <div ref={ref} className="cli-pop" style={style}>
      <div className="cli-pop-head"><span>Spawn in pane</span><span style={{ display: 'inline-flex', gap: 2 }}><Kbd>⌘</Kbd><Kbd>T</Kbd></span></div>
      {clis.map((c, i) => (
        <div key={c.id}
             className={`cli-pop-row ${i === sel ? 'sel' : ''}`}
             onMouseEnter={() => setSel(i)}
             onClick={() => onPick(c)}>
          <span className="cli-dot" style={{ background: c.color }}/>
          <span>{c.name}</span>
          <span className="ver">v{c.version}</span>
          {i < 3 ? <span className="sk"><Kbd>⌘</Kbd><Kbd>{i+1}</Kbd></span> : <span/>}
        </div>
      ))}
      <div className="cli-pop-foot">
        <IconPlus size={12}/> Add custom CLI…
        <span className="ver-tag">v0.2</span>
      </div>
    </div>
  );
}

// ─────────────── Settings page ───────────────
const SETTINGS_NAV = [
  { id: 'general',    label: 'General' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'keys',       label: 'Keybindings' },
  { id: 'clis',       label: 'CLIs' },
  { id: 'privacy',    label: 'Privacy' },
  { id: 'about',      label: 'About' },
];

function SettingsPage({ projectName, onBack, settings, setSettings, hotkeys, clis }) {
  const [section, setSection] = useState('general');
  return (
    <div className="settings">
      <div className="settings-head">
        <button className="back-btn" onClick={onBack}><IconBack size={13}/> Back to {projectName}</button>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-tertiary)' }}>Settings</span>
      </div>
      <div className="settings-body">
        <div className="settings-rail">
          {SETTINGS_NAV.map(n => (
            <div key={n.id}
                 className={`nav ${section === n.id ? 'active' : ''}`}
                 onClick={() => setSection(n.id)}>{n.label}</div>
          ))}
        </div>
        <div className="settings-content">
          <div className="settings-inner">
            {section === 'general'    && <SettingsGeneral    s={settings} set={setSettings} clis={clis}/>}
            {section === 'appearance' && <SettingsAppearance s={settings} set={setSettings}/>}
            {section === 'keys'       && <SettingsKeys hotkeys={hotkeys}/>}
            {section === 'clis'       && <SettingsClis clis={clis}/>}
            {section === 'privacy'    && <SettingsPrivacy s={settings} set={setSettings}/>}
            {section === 'about'      && <SettingsAbout/>}
          </div>
        </div>
      </div>
    </div>
  );
}

const Toggle = ({ on, onChange }) => (
  <div className={`tg ${on ? 'on' : ''}`} onClick={() => onChange(!on)}/>
);
const Seg = ({ value, options, onChange }) => (
  <div className="seg">
    {options.map(o => {
      const v = typeof o === 'string' ? o : o.value;
      const lbl = typeof o === 'string' ? o : o.label;
      return <button key={v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>{lbl}</button>;
    })}
  </div>
);

function SettingsGeneral({ s, set, clis }) {
  return (
    <>
      <h2 className="settings-section-title">General</h2>
      <div className="settings-group">
        <div className="settings-row">
          <div>
            <div className="lbl">Send anonymous metrics</div>
            <div className="hint">Helps optimize cold start and memory usage. No command or output content is ever sent.</div>
          </div>
          <Toggle on={s.telemetry} onChange={(v) => set({ telemetry: v })}/>
        </div>
      </div>
      <div className="settings-group">
        <div className="settings-row">
          <div>
            <div className="lbl">Default fallback CLI</div>
            <div className="hint">Used when a project's default CLI isn't found.</div>
          </div>
          <Seg value={s.fallbackCli} options={clis.slice(3, 6).map(c => ({ value: c.id, label: c.name }))} onChange={(v) => set({ fallbackCli: v })}/>
        </div>
      </div>
      <div className="settings-group">
        <div className="settings-row">
          <div>
            <div className="lbl">Scrollback per session</div>
            <div className="hint">Larger means more history, more memory.</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input type="range" className="sld" min={1} max={16} step={1}
                   value={s.scrollbackMb} onChange={(e) => set({ scrollbackMb: +e.target.value })}/>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-secondary)', minWidth: 40 }}>
              {s.scrollbackMb} MB
            </span>
          </div>
        </div>
      </div>
      <div className="settings-group">
        <div className="settings-row">
          <div>
            <div className="lbl">Open at login <span className="badge-soon">v0.2</span></div>
            <div className="hint">Launch Work Station when you sign in.</div>
          </div>
          <Toggle on={false} onChange={() => {}}/>
        </div>
      </div>
    </>
  );
}

function SettingsAppearance({ s, set }) {
  const accents = [
    { v: 'teal',   c: 'oklch(0.74 0.11 200)' },
    { v: 'lime',   c: 'oklch(0.82 0.18 130)' },
    { v: 'violet', c: 'oklch(0.68 0.16 295)' },
    { v: 'amber',  c: 'oklch(0.78 0.12 75)' },
  ];
  return (
    <>
      <h2 className="settings-section-title">Appearance</h2>
      <div className="settings-group">
        <div className="settings-row">
          <div className="lbl">Theme</div>
          <Seg value={s.theme} options={['dark','light','system']} onChange={(v) => set({ theme: v === 'system' ? 'dark' : v })}/>
        </div>
        <div className="settings-row">
          <div className="lbl">Accent</div>
          <div style={{ display: 'inline-flex', gap: 6 }}>
            {accents.map(a => (
              <button key={a.v} onClick={() => set({ accent: a.v })}
                      className={`swatch ${s.accent === a.v ? 'sel' : ''}`}
                      style={{ background: a.c }}/>
            ))}
          </div>
        </div>
      </div>
      <div className="settings-group">
        <div className="settings-row">
          <div className="lbl">UI font</div>
          <Seg value={s.uiFont} options={['Geist','Inter','System']} onChange={(v) => set({ uiFont: v })}/>
        </div>
        <div className="settings-row">
          <div className="lbl">Mono font</div>
          <Seg value={s.monoFont} options={['JetBrains Mono','Geist Mono','Berkeley Mono','System']} onChange={(v) => set({ monoFont: v })}/>
        </div>
        <div className="settings-row">
          <div className="lbl">UI font size</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input type="range" className="sld" min={12} max={16} step={1}
                   value={s.uiSize} onChange={(e) => set({ uiSize: +e.target.value })}/>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-secondary)', minWidth: 40 }}>
              {s.uiSize} px
            </span>
          </div>
        </div>
        <div className="settings-row">
          <div className="lbl">Density</div>
          <Seg value={s.density} options={['compact','comfortable']} onChange={(v) => set({ density: v })}/>
        </div>
      </div>
    </>
  );
}

function SettingsKeys({ hotkeys }) {
  const [q, setQ] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [pending, setPending] = useState([]);
  const filtered = hotkeys.filter(h => !q || h.label.toLowerCase().includes(q.toLowerCase()));
  // Demo: pretend ⌘+W conflicts when binding new-tab
  const conflict = editingId === 'new-tab' && pending.join('+') === '⌘+W' ? 'Close pane' : null;
  return (
    <>
      <h2 className="settings-section-title">Keybindings</h2>
      <input className="input hk-search" placeholder="Search actions…"
             value={q} onChange={(e) => setQ(e.target.value)}/>
      <div className="hk-table">
        {filtered.map(h => {
          const editing = editingId === h.id;
          return (
            <div key={h.id} className={`hk-row ${editing ? 'editing' : ''}`}>
              <div>{h.label}</div>
              {editing ? (
                <div>
                  <span className="pending">
                    {pending.length ? pending.join(' + ') : 'Press keys…'}
                  </span>
                  {conflict && <div className="hk-warn">⚠ Used by '{conflict}'</div>}
                </div>
              ) : (
                <div className="hk-keys">{h.binding.map((k,i) => <Kbd key={i}>{k}</Kbd>)}</div>
              )}
              {editing ? (
                <div style={{ display: 'inline-flex', gap: 4 }}>
                  <button className="btn ghost" style={{ height: 24, padding: '0 8px' }}
                          onClick={() => { setEditingId(null); setPending([]); }}>Cancel</button>
                  <button className="btn primary" style={{ height: 24, padding: '0 10px' }}
                          disabled={!pending.length || conflict}
                          onClick={() => { setEditingId(null); setPending([]); }}>Save</button>
                </div>
              ) : (
                <button className="hk-edit" onClick={() => { setEditingId(h.id); setPending(['⌘','W']); }}>
                  <IconPencil size={12}/>
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button className="btn ghost" style={{ alignSelf: 'flex-start', height: 26, padding: '0 10px' }}>
        Reset to defaults
      </button>
    </>
  );
}

function SettingsClis({ clis }) {
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 className="settings-section-title">CLIs</h2>
        <button className="btn"><IconRefresh size={12}/> Refresh</button>
      </div>
      <div className="hk-table">
        {clis.map(c => (
          <div key={c.id} className="hk-row" style={{ gridTemplateColumns: '14px 1fr auto auto' }}>
            <span className="cli-dot" style={{ background: c.color, width: 8, height: 8, borderRadius: '50%' }}/>
            <div>
              <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>{c.name}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-tertiary)' }}>{c.path}</div>
            </div>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-tertiary)' }}>v{c.version}</span>
            <span/>
          </div>
        ))}
      </div>
      <div className="settings-row">
        <div className="lbl">Add custom CLI… <span className="badge-soon">v0.2</span></div>
        <button className="btn" disabled style={{ opacity: 0.5 }}>+ Add</button>
      </div>
    </>
  );
}

function SettingsPrivacy({ s, set }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <h2 className="settings-section-title">Privacy</h2>
      <div className="settings-group">
        <div className="settings-row">
          <div>
            <div className="lbl">Send anonymous metrics</div>
            <div className="hint">Aggregate performance and feature-usage data. No commands, paths, or output.</div>
          </div>
          <Toggle on={s.telemetry} onChange={(v) => set({ telemetry: v })}/>
        </div>
        <div className="settings-row">
          <div>
            <div className="lbl">Crash reports</div>
            <div className="hint">Send stack traces when Work Station crashes.</div>
          </div>
          <Toggle on={s.crashReports} onChange={(v) => set({ crashReports: v })}/>
        </div>
      </div>
      <div className="settings-group">
        <div className="settings-row" onClick={() => setOpen(o => !o)} style={{ cursor: 'default' }}>
          <div>
            <div className="lbl" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              View what we collect
              <span style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 150ms', display: 'inline-flex' }}>
                <IconChevDn size={12}/>
              </span>
            </div>
          </div>
          <span/>
        </div>
        {open && (
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-secondary)', background: 'var(--bg-surface)', padding: 12, borderRadius: 6, border: '1px solid var(--border-subtle)' }}>
            <div>app.launch  · cold-start time</div>
            <div>app.crash   · stack hash</div>
            <div>pane.spawn  · CLI id, success/fail</div>
            <div>session.heartbeat · session count, uptime</div>
            <div style={{ marginTop: 8, color: 'var(--text-tertiary)' }}>— never collected —</div>
            <div>command text, output, file paths, project names</div>
          </div>
        )}
        <a className="hint" style={{ color: 'var(--text-secondary)', textDecoration: 'underline', cursor: 'default' }}>Privacy policy ↗</a>
      </div>
    </>
  );
}

function SettingsAbout() {
  return (
    <>
      <div className="about-card">
        <div className="about-icon">W</div>
        <div style={{ fontSize: 18, fontWeight: 600 }}>Work Station 0.1.0</div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-tertiary)' }}>
          build 1a4c92f · electron 30.0.7 · node 20.13
        </div>
        <div style={{ display: 'inline-flex', gap: 6, marginTop: 8 }}>
          <button className="btn">Check for updates</button>
          <button className="btn">Open GitHub</button>
          <button className="btn">Open logs folder</button>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 8 }}>
          MIT License · <a style={{ color: 'inherit', textDecoration: 'underline', cursor: 'default' }}>workstation.dev ↗</a>
        </div>
      </div>
    </>
  );
}

// ─────────────── Edit Project + Delete confirm ───────────────
function EditProjectModal({ project, onSave, onDelete, onClose, clis }) {
  const [name, setName]     = useState(project.name);
  const [folder, setFolder] = useState(project.cwd);
  const [color, setColor]   = useState(project.color);
  const [glyph, setGlyph]   = useState(project.glyph);
  const [cli, setCli]       = useState(project.tabs[0]?.cli ?? 'claude');
  const dirty = name !== project.name || folder !== project.cwd || color !== project.color || glyph !== project.glyph;

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">Edit project</div>
          <button className="tb-icon-btn" onClick={onClose}><IconX size={13}/></button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label className="field-label">Name</label>
            <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)}/>
          </div>
          <div className="field">
            <label className="field-label">Folder</label>
            <div className="input-wrap">
              <span className="input-icon"><IconFolder size={14}/></span>
              <input className="input has-icon" value={folder} onChange={(e) => setFolder(e.target.value)}/>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div className="field">
              <label className="field-label">Color</label>
              <div className="swatches">
                {window.WS_SWATCHES.map(c => (
                  <button key={c} className={`swatch ${c === color ? 'sel' : ''}`}
                          style={{ background: c }} onClick={() => setColor(c)}/>
                ))}
              </div>
            </div>
            <div className="field">
              <label className="field-label">Default CLI</label>
              <Seg value={cli} options={clis.slice(0,3).map(c => ({ value: c.id, label: c.name }))} onChange={setCli}/>
            </div>
          </div>
          <div className="field">
            <label className="field-label">Icon glyph</label>
            <div className="icon-grid">
              {window.WS_ICONS.map(g => (
                <button key={g} className={`icon-pick ${g === glyph ? 'sel' : ''}`} onClick={() => setGlyph(g)}>{g}</button>
              ))}
            </div>
          </div>
        </div>
        <div className="modal-foot split">
          <button className="btn danger-text" onClick={onDelete}>Delete project</button>
          <div style={{ display: 'inline-flex', gap: 8 }}>
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={!dirty} style={!dirty ? { opacity: 0.5 } : null}
                    onClick={() => dirty && onSave({ name, cwd: folder, color, glyph })}>Save changes</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function DeleteConfirmModal({ project, onCancel, onConfirm }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setArmed(true), 500);
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel();
      else if (e.key === 'Enter' && armed) onConfirm();
    };
    window.addEventListener('keydown', onKey);
    return () => { clearTimeout(t); window.removeEventListener('keydown', onKey); };
  }, [armed, onCancel, onConfirm]);
  return (
    <div className="scrim" style={{ paddingTop: '20vh' }} onClick={onCancel}>
      <div className="modal sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-body">
          <div className="modal-title-lg">Delete "{project.name}"?</div>
          <div className="danger-msg">
            {project.sessions > 0
              ? <>This project has <b>{project.sessions} running session{project.sessions === 1 ? '' : 's'}</b>. They will be killed.</>
              : <>This project has no running sessions.</>}
            <br/>This cannot be undone.
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onCancel}>Cancel</button>
          <button className={`btn danger`} disabled={!armed}
                  onClick={() => armed && onConfirm()}>
            <span className="danger-fill" style={{ width: armed ? '100%' : '0%' }}/>
            <span style={{ position: 'relative' }}>Delete</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────── Search overlay ───────────────
function TermSearch({ query, setQuery, count, currentIdx, setCurrentIdx, onClose }) {
  const [caseS, setCaseS] = useState(false);
  const [regex, setRegex] = useState(false);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current && inputRef.current.focus(); }, []);
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (count > 0) setCurrentIdx(e.shiftKey ? (currentIdx - 1 + count) % count : (currentIdx + 1) % count);
    }
  };
  return (
    <div className="term-search" onMouseDown={(e) => e.stopPropagation()}>
      <IconSearch size={13}/>
      <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)}
             onKeyDown={onKey} placeholder="Find in pane…"/>
      <span className="ts-count">{count > 0 ? `${currentIdx + 1} of ${count}` : query ? 'no matches' : ''}</span>
      <button className="ts-btn" disabled={!count} onClick={() => count && setCurrentIdx((currentIdx - 1 + count) % count)}><IconArrUp size={12}/></button>
      <button className="ts-btn" disabled={!count} onClick={() => count && setCurrentIdx((currentIdx + 1) % count)}><IconArrDn size={12}/></button>
      <button className={`ts-btn ${caseS ? 'on' : ''}`} onClick={() => setCaseS(c => !c)}>Aa</button>
      <button className={`ts-btn ${regex ? 'on' : ''}`} onClick={() => setRegex(r => !r)}>.*</button>
      <button className="ts-btn" onClick={onClose}><IconX size={12}/></button>
    </div>
  );
}

// ─────────────── Crash banner & toasts ───────────────
function CrashBanner({ onClose }) {
  return (
    <div className="crash-banner">
      <span className="cb-icon"><IconRefresh size={14}/></span>
      <span>Recovered from previous session. <b>3 sessions</b> were re-spawned.</span>
      <span className="cb-link">View report</span>
      <button className="cb-x" onClick={onClose}><IconX size={11}/></button>
    </div>
  );
}

function Toast({ toast, onDismiss }) {
  useEffect(() => {
    if (!toast.action) {
      const t = setTimeout(() => onDismiss(toast.id), 5000);
      return () => clearTimeout(t);
    }
  }, [toast, onDismiss]);
  const Ico = toast.type === 'error' ? IconErr
            : toast.type === 'warning' ? IconWarn
            : toast.type === 'success' ? IconCheck2
            : IconInfo;
  return (
    <div className={`toast ${toast.type}`}>
      <span className="t-icon"><Ico size={16}/></span>
      <div>
        <div className="t-title">{toast.title}</div>
        <div className="t-body">{toast.body}</div>
      </div>
      <div className="t-acts">
        {toast.action && <button className="btn ghost" style={{ height: 24, padding: '0 8px' }}>{toast.action}</button>}
        <button className="tb-icon-btn" style={{ width: 22, height: 22 }} onClick={() => onDismiss(toast.id)}>
          <IconX size={11}/>
        </button>
      </div>
    </div>
  );
}

// ─────────────── Skeleton ───────────────
function SidebarSkeleton() {
  return (
    <div className="sidebar">
      <div className="sb-section"><span>Projects</span></div>
      <div className="sb-list">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="skel-row">
            <div className="skel skel-icon"/>
            <div className="skel skel-block" style={{ width: '70%' }}/>
            <div className="skel skel-block" style={{ width: 14 }}/>
          </div>
        ))}
      </div>
    </div>
  );
}
function WorkspaceSkeleton() {
  return <div style={{ display: 'grid', placeItems: 'center', height: '100%', color: 'var(--text-tertiary)' }}>
    <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--text-tertiary)', animation: 'pulse 1.4s var(--ease) infinite' }}/>
  </div>;
}
function PaneSpawnSkeleton() {
  const [d, setD] = useState('⠋');
  useEffect(() => {
    const seq = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
    let i = 0;
    const t = setInterval(() => { i = (i + 1) % seq.length; setD(seq[i]); }, 80);
    return () => clearInterval(t);
  }, []);
  return <div className="pane-spawn"><span>{d} spawning…</span></div>;
}

// ─────────────── Onboarding ───────────────
function Onboarding({ onClose, onCreateProject, clis }) {
  const [step, setStep] = useState(0);
  const [tel, setTel] = useState(false);
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('~/code/');
  const [color, setColor] = useState(window.WS_SWATCHES[0]);
  const [glyph, setGlyph] = useState('NB');
  const next = () => setStep(s => Math.min(s + 1, 2));
  const back = () => setStep(s => Math.max(s - 1, 0));

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="onb-scrim">
      <div className="onb-card">
        <div className="onb-body">
          {step === 0 && (
            <div className="onb-step">
              <div className="about-icon" style={{ width: 64, height: 64, fontSize: 26 }}>W</div>
              <div className="onb-h">Work Station</div>
              <div className="onb-sub">A workspace for the terminals you actually use.</div>
            </div>
          )}
          {step === 1 && (
            <div className="onb-step left" style={{ maxWidth: 420 }}>
              <div className="onb-h" style={{ fontSize: 22 }}>Help improve Work Station</div>
              <div className="onb-sub">
                We collect aggregate performance and crash data to keep the app fast and stable.
              </div>
              <div className="onb-sub" style={{ color: 'var(--text-tertiary)' }}>
                <b style={{ color: 'var(--text-secondary)' }}>Never collected:</b> command text, output, file paths, project names.
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px', border: '1px solid var(--border-subtle)', borderRadius: 6, background: 'var(--bg-surface)' }}>
                <span style={{ fontSize: 13 }}>Send anonymous metrics</span>
                <Toggle on={tel} onChange={setTel}/>
              </div>
            </div>
          )}
          {step === 2 && (
            <div className="onb-step left" style={{ maxWidth: 460 }}>
              <div className="onb-h" style={{ fontSize: 22 }}>Add your first project</div>
              <div className="field">
                <label className="field-label">Name</label>
                <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="my-project"/>
              </div>
              <div className="field">
                <label className="field-label">Folder</label>
                <div className="input-wrap">
                  <span className="input-icon"><IconFolder size={14}/></span>
                  <input className="input has-icon" value={folder} onChange={(e) => setFolder(e.target.value)}/>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 12 }}>
                <div className="field" style={{ flex: 1 }}>
                  <label className="field-label">Color</label>
                  <div className="swatches">
                    {window.WS_SWATCHES.slice(0,6).map(c => (
                      <button key={c} className={`swatch ${c === color ? 'sel' : ''}`}
                              style={{ background: c }} onClick={() => setColor(c)}/>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="onb-foot">
          <div className="onb-dots">
            {[0,1,2].map(i => <span key={i} className={i === step ? 'on' : ''}/>)}
          </div>
          <div className="onb-actions">
            {step > 0 && <button className="btn ghost" onClick={back}>Back</button>}
            {step < 2 ? (
              <>
                <button className="btn ghost" onClick={onClose}>Skip</button>
                <button className="btn primary" onClick={next}>{step === 0 ? 'Get started →' : 'Continue'}</button>
              </>
            ) : (
              <>
                <button className="btn ghost" onClick={onClose}>Maybe later</button>
                <button className="btn primary" disabled={!name}
                        style={!name ? { opacity: 0.5 } : null}
                        onClick={() => { onCreateProject({ name, folder, color, glyph, cli: 'claude' }); onClose(); }}>
                  Create project
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────── Windows menu ───────────────
function WinMenu({ onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    setTimeout(() => window.addEventListener('mousedown', onClick), 0);
    return () => window.removeEventListener('mousedown', onClick);
  }, [onClose]);
  return (
    <div ref={ref} className="win-menu">
      {window.WS_WIN_MENU.map((sec, i) => (
        <div key={sec.label}>
          <div className="wm-section">{sec.label}</div>
          {sec.items.map((it, j) => it.divider
            ? <div key={j} className="wm-divider"/>
            : (
              <div key={j} className="wm-item">
                <span>{it.label}</span>
                {it.keys && <span className="wm-keys">{it.keys.map((k,n) => <Kbd key={n}>{k}</Kbd>)}</span>}
              </div>
            ))}
          {i < window.WS_WIN_MENU.length - 1 && <div className="wm-divider"/>}
        </div>
      ))}
    </div>
  );
}

// ─────────────── Context menu (sidebar) ───────────────
function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    setTimeout(() => window.addEventListener('mousedown', onClick), 0);
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onClick); window.removeEventListener('keydown', onKey); };
  }, [onClose]);
  return (
    <div ref={ref} className="ctx-menu" style={{ left: x, top: y }}>
      {items.map((it, i) => (
        <div key={i} className={`ctx-item ${it.danger ? 'danger' : ''}`}
             onClick={() => { it.onClick(); onClose(); }}>{it.label}</div>
      ))}
    </div>
  );
}

Object.assign(window, {
  Tip, ResizableLayout, Pane2, PaneError, CliPopover,
  SettingsPage, EditProjectModal, DeleteConfirmModal,
  TermSearch, CrashBanner, Toast,
  SidebarSkeleton, WorkspaceSkeleton, PaneSpawnSkeleton,
  Onboarding, WinMenu, ContextMenu,
  IconWarn, IconErr, IconInfo, IconCheck2, IconRefresh, IconPencil, IconBack, IconHam, IconChevDn, IconArrUp, IconArrDn,
});
