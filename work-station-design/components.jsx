/* global React, ReactDOM */
const { useState, useEffect, useRef, useMemo, useCallback } = React;

// ─────────────────────────────────────────────────────────────────────────────
// Icons (inline SVG, lucide-style)
// ─────────────────────────────────────────────────────────────────────────────
const Icon = ({ d, size = 14, sw = 1.6, fill = 'none' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke="currentColor"
       strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">{d}</svg>
);
const IconSearch  = (p) => <Icon {...p} d={<><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></>}/>;
const IconPlus    = (p) => <Icon {...p} d={<><path d="M12 5v14"/><path d="M5 12h14"/></>}/>;
const IconX       = (p) => <Icon {...p} d={<><path d="M18 6 6 18"/><path d="m6 6 12 12"/></>}/>;
const IconMore    = (p) => <Icon {...p} d={<><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>}/>;
const IconCog     = (p) => <Icon {...p} d={<><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.8.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.4-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></>}/>;
const IconBranch  = (p) => <Icon {...p} d={<><circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M6 8v4a2 2 0 0 0 2 2h2"/><path d="M18 8v0a4 4 0 0 1-4 4h-4"/></>}/>;
const IconChev    = (p) => <Icon {...p} d={<><path d="m9 18 6-6-6-6"/></>}/>;
const IconFolder  = (p) => <Icon {...p} d={<><path d="M4 7a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/></>}/>;
const IconCheck   = (p) => <Icon {...p} d={<><path d="m5 12 5 5L20 7"/></>}/>;
const IconReturn  = (p) => <Icon {...p} d={<><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 5 5v6"/></>}/>;
const IconArrows  = (p) => <Icon {...p} d={<><path d="m7 6-3 3 3 3"/><path d="m17 6 3 3-3 3"/><path d="M4 9h16"/></>}/>;
const IconCmd     = (p) => <Icon {...p} d={<><path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3Z"/></>}/>;

// keycap
const Kbd = ({ children }) => <span className="kbd">{children}</span>;

// macOS / windows chrome
const MacTraffic = () => (
  <div className="tb-traffic">
    <span className="light close"/><span className="light min"/><span className="light max"/>
  </div>
);
const WinControls = () => (
  <div className="tb-win-controls">
    <button>—</button>
    <button>▢</button>
    <button className="close"><IconX size={11} sw={1.4}/></button>
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// Title bar
// ─────────────────────────────────────────────────────────────────────────────
function TitleBar({ os, project, onCmdK }) {
  return (
    <div className="titlebar">
      {os === 'mac' && <MacTraffic/>}
      <div className="tb-spacer"/>
      <div className="tb-title">
        <span className="tb-dot" style={{ background: project.color }}/>
        <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{project.name}</span>
        <span className="tb-sep">·</span>
        <span className="tb-branch"><IconBranch size={11}/> {project.branch}</span>
      </div>
      <div className="tb-spacer"/>
      <div className="tb-actions">
        <button className="tb-icon-btn" onClick={onCmdK} title="Quick switcher (⌘K)">
          <IconSearch size={13}/>
        </button>
        <button className="tb-icon-btn" title="Settings"><IconCog size={13}/></button>
      </div>
      {os === 'win' && <WinControls/>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tab strip
// ─────────────────────────────────────────────────────────────────────────────
function TabStrip({ tabs, activeId, onActivate, onClose, onAdd, cliMap }) {
  return (
    <div className="tabstrip">
      <div className="tab-scroll">
        {tabs.map((t) => {
          const cli = cliMap[t.cli] || { badge: '··', color: '#888' };
          const active = t.id === activeId;
          return (
            <div key={t.id}
                 className={`tab ${active ? 'active' : ''}`}
                 onClick={() => onActivate(t.id)}>
              <span className="tab-icon" style={ active ? {} : { color: cli.color, background: 'transparent' }}>
                {cli.badge}
              </span>
              <span className="tab-label">{t.label}</span>
              {t.dirty && <span className="tab-dirty"/>}
              <button className="tab-close"
                      onClick={(e) => { e.stopPropagation(); onClose(t.id); }}>
                <IconX size={11} sw={1.5}/>
              </button>
            </div>
          );
        })}
        <button className="tab-new" onClick={onAdd}><IconPlus size={13}/></button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Terminal output renderer
// ─────────────────────────────────────────────────────────────────────────────
function renderLine(line, key) {
  switch (line.t) {
    case 'prompt':
      return <span key={key} className="ln"><span className="prompt">❯</span> <span className="dim">{line.s}</span> </span>;
    case 'cmd':
      return <span key={key} className="ln" style={{ marginLeft: 0 }}><span className="b">{line.s}</span></span>;
    case 'sys':       return <span key={key} className="ln dim">{line.s}</span>;
    case 'user':      return <span key={key} className="ln" style={{ color: '#e6e7e9' }}>{line.s}</span>;
    case 'assistant': return <span key={key} className="ln">{line.s}</span>;
    case 'tool':      return <span key={key} className="ln accent">{line.s}</span>;
    case 'thinking':  return <span key={key} className="ln dim"><i>{line.s}</i></span>;
    case 'ok':        return <span key={key} className="ln ok">{line.s}</span>;
    case 'err':       return <span key={key} className="ln err">{line.s}</span>;
    case 'warn':      return <span key={key} className="ln warn">{line.s}</span>;
    case 'info':      return <span key={key} className="ln info">{line.s}</span>;
    case 'dim':       return <span key={key} className="ln dim">{line.s}</span>;
    case 'diff-add':  return <span key={key} className="ln" style={{ color: 'oklch(0.78 0.12 155)' }}>{line.s}</span>;
    case 'diff-rm':   return <span key={key} className="ln" style={{ color: 'oklch(0.74 0.16 25)' }}>{line.s}</span>;
    case 'cur':       return <span key={key} className="ln"><span className="prompt">❯</span> <span className="cursor"/></span>;
    case 'blank':     return <span key={key} className="ln">{'\u00a0'}</span>;
    default:          return <span key={key} className="ln">{line.s}</span>;
  }
}

function Pane({ pane, focused, onFocus, cliMap, onClose }) {
  const cli = cliMap[pane.cli] || { badge: '··', color: '#888', name: pane.cli };
  const termRef = useRef(null);
  // Autoscroll on mount
  useEffect(() => { if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight; }, [pane]);

  const status = pane.status === 'live'
    ? <span className="pane-status"><span className="pulse"/>live</span>
    : pane.status === 'thinking'
    ? <span className="pane-status" style={{ color: 'var(--accent)' }}><span className="pulse" style={{ background: 'var(--accent)' }}/>working</span>
    : <span className="pane-status">idle</span>;

  return (
    <div className={`pane ${focused ? 'focused' : ''}`} onMouseDown={onFocus}>
      <div className="pane-head">
        <span className="cli-badge">
          <span className="cli-dot" style={{ background: cli.color }}/>
          {cli.name}
        </span>
        <span className="cwd">{pane.cwd}</span>
        {status}
        <button className="pane-menu" onClick={(e) => { e.stopPropagation(); onClose && onClose(); }}>
          <IconMore size={13}/>
        </button>
      </div>
      <div className="term" ref={termRef}>
        {pane.lines.map((l, i) => renderLine(l, i))}
      </div>
    </div>
  );
}

// Recursive layout renderer (handles nested splits)
function LayoutNode({ node, panes, focusedPaneId, onFocusPane, cliMap }) {
  if (node.kind === 'pane') {
    const p = panes[node.paneId];
    if (!p) return null;
    return <Pane pane={p} focused={node.paneId === focusedPaneId}
                 onFocus={() => onFocusPane(node.paneId)} cliMap={cliMap}/>;
  }
  // split
  const isH = node.dir === 'h';
  const style = isH
    ? { display: 'grid', gridTemplateColumns: '1fr 6px 1fr', gap: 0, height: '100%' }
    : { display: 'grid', gridTemplateRows:    '1fr 6px 1fr', gap: 0, height: '100%' };
  return (
    <div style={style}>
      <LayoutNode node={node.a} panes={panes} focusedPaneId={focusedPaneId} onFocusPane={onFocusPane} cliMap={cliMap}/>
      <div className={isH ? 'split-h' : 'split-v'}/>
      <LayoutNode node={node.b} panes={panes} focusedPaneId={focusedPaneId} onFocusPane={onFocusPane} cliMap={cliMap}/>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sidebar
// ─────────────────────────────────────────────────────────────────────────────
function Sidebar({ projects, activeId, onActivate, onAdd, onCmdK }) {
  return (
    <div className="sidebar">
      <div className="sb-section">
        <span>Projects</span>
        <button className="sb-section-act" onClick={onAdd}><IconPlus size={12}/></button>
      </div>
      <div className="sb-list">
        {projects.map((p) => (
          <div key={p.id}
               className={`sb-row ${p.id === activeId ? 'active' : ''}`}
               onClick={() => onActivate(p.id)}>
            <div className="sb-icon" style={{ background: p.color }}>{p.glyph}</div>
            <div className="sb-name">{p.name}</div>
            <div className="sb-meta">
              {p.sessions > 0
                ? <><span className="live-dot"/><span className="badge">{p.sessions}</span></>
                : <span className="badge" style={{ opacity: 0.5 }}>—</span>}
            </div>
          </div>
        ))}
      </div>
      <div className="sb-footer">
        <button className="sb-add" onClick={onAdd}>
          <IconPlus size={12}/> New project
          <Kbd>⌘N</Kbd>
        </button>
        <button className="sb-icon-btn" title="Settings"><IconCog size={14}/></button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Quick switcher
// ─────────────────────────────────────────────────────────────────────────────
function highlight(text, q) {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return <>{text.slice(0, i)}<span className="qs-match">{text.slice(i, i + q.length)}</span>{text.slice(i + q.length)}</>;
}
function QuickSwitcher({ projects, onPick, onClose }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? projects.filter(p => p.name.toLowerCase().includes(s) || p.branch.toLowerCase().includes(s)) : projects;
  }, [q, projects]);
  useEffect(() => { setSel(0); }, [q]);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current && inputRef.current.focus(); }, []);

  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); setSel(s => Math.max(s - 1, 0)); }
    else if (e.key === 'Enter')     { e.preventDefault(); filtered[sel] && onPick(filtered[sel].id); }
  };

  return (
    <div className="scrim" onClick={onClose}>
      <div className="qs" onClick={(e) => e.stopPropagation()}>
        <div className="qs-input">
          <IconSearch size={15}/>
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)}
                 onKeyDown={onKey}
                 placeholder="Switch project, find tab, run command…"/>
          <Kbd>esc</Kbd>
        </div>
        <div className="qs-list">
          {filtered.length === 0
            ? <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 12 }}>No matches</div>
            : filtered.map((p, i) => (
              <div key={p.id} className={`qs-row ${i === sel ? 'sel' : ''}`}
                   onMouseEnter={() => setSel(i)}
                   onClick={() => onPick(p.id)}>
                <div className="sb-icon" style={{ background: p.color, width: 22, height: 22 }}>{p.glyph}</div>
                <div className="qs-name">
                  {highlight(p.name, q)}
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2, fontFamily: 'var(--font-mono)' }}>
                    {p.cwd} · {p.branch}
                  </div>
                </div>
                <div className="qs-meta">
                  {p.sessions > 0
                    ? <span style={{ color: 'var(--accent)' }}>{p.sessions} live</span>
                    : 'idle'}
                </div>
              </div>
            ))}
        </div>
        <div className="qs-foot">
          <span className="hint"><Kbd>↑</Kbd><Kbd>↓</Kbd> navigate</span>
          <span className="hint"><Kbd>↵</Kbd> open</span>
          <span className="hint"><Kbd>⌘</Kbd><Kbd>↵</Kbd> open in new tab</span>
          <span style={{ marginLeft: 'auto' }}>Quick switcher</span>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Add Project modal
// ─────────────────────────────────────────────────────────────────────────────
function AddProjectModal({ onCreate, onClose, clis }) {
  const [name, setName]     = useState('');
  const [folder, setFolder] = useState('~/code/');
  const [color, setColor]   = useState(window.WS_SWATCHES[0]);
  const [glyph, setGlyph]   = useState('NB');
  const [cli, setCli]       = useState('claude');
  const valid = name.trim().length > 0 && folder.trim().length > 1;

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">New project</div>
          <button className="tb-icon-btn" onClick={onClose}><IconX size={13}/></button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label className="field-label">Name</label>
            <input className="input" autoFocus value={name}
                   onChange={(e) => setName(e.target.value)}
                   placeholder="my-project"/>
          </div>

          <div className="field">
            <label className="field-label">Folder</label>
            <div className="input-wrap">
              <span className="input-icon"><IconFolder size={14}/></span>
              <input className="input has-icon" value={folder}
                     onChange={(e) => setFolder(e.target.value)}/>
              <span className="input-aside">
                <button className="btn ghost" style={{ height: 24, padding: '0 8px' }}>Browse…</button>
              </span>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div className="field">
              <label className="field-label">Color</label>
              <div className="swatches">
                {window.WS_SWATCHES.map(c => (
                  <button key={c}
                          className={`swatch ${c === color ? 'sel' : ''}`}
                          style={{ background: c }}
                          onClick={() => setColor(c)}/>
                ))}
              </div>
            </div>
            <div className="field">
              <label className="field-label">Default CLI</label>
              <div className="input-wrap">
                <select className="input" value={cli}
                        onChange={(e) => setCli(e.target.value)}
                        style={{ appearance: 'none', paddingRight: 28 }}>
                  {clis.map(c => <option key={c.id} value={c.id}>{c.name} · v{c.version}</option>)}
                </select>
                <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%) rotate(90deg)', color: 'var(--text-tertiary)', pointerEvents: 'none' }}>
                  <IconChev size={12}/>
                </span>
              </div>
            </div>
          </div>

          <div className="field">
            <label className="field-label">Icon glyph</label>
            <div className="icon-grid">
              {window.WS_ICONS.map(g => (
                <button key={g}
                        className={`icon-pick ${g === glyph ? 'sel' : ''}`}
                        onClick={() => setGlyph(g)}>{g}</button>
              ))}
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!valid}
                  style={!valid ? { opacity: 0.5 } : null}
                  onClick={() => valid && onCreate({ name: name.trim(), folder, color, glyph, cli })}>
            Create project
          </button>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, {
  Icon, IconSearch, IconPlus, IconX, IconMore, IconCog, IconBranch, IconChev,
  IconFolder, IconCheck, IconReturn, IconArrows, IconCmd,
  Kbd, MacTraffic, WinControls,
  TitleBar, TabStrip, Pane, LayoutNode, Sidebar, QuickSwitcher, AddProjectModal,
  renderLine,
});
