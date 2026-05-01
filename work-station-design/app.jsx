/* global React, ReactDOM, useTweaks, TweaksPanel, TweakSection, TweakRadio, TweakSlider, TweakToggle, TweakButton */
const { useState, useEffect, useRef, useMemo, useCallback } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "dark",
  "os": "mac",
  "accent": "teal",
  "density": "comfortable",
  "sidebarWidth": 232,
  "showBanner": false,
  "showSettings": false,
  "showOnboarding": false,
  "showPaneError": false,
  "showCrashBanner": false,
  "showSearch": false,
  "showSkeleton": false
}/*EDITMODE-END*/;

const ACCENTS = {
  teal:   { h: 200, label: 'Teal' },
  lime:   { h: 130, label: 'Lime' },
  violet: { h: 295, label: 'Violet' },
  amber:  { h:  75, label: 'Amber' },
};

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = t.theme;
    root.dataset.density = t.density;
    root.style.setProperty('--accent-h', String(ACCENTS[t.accent]?.h ?? 200));
  }, [t.theme, t.density, t.accent]);

  const [projects, setProjects] = useState(() => window.WS_PROJECTS);
  const [activeProjectId, setActiveProjectId] = useState('argon');
  const [activeTabIds, setActiveTabIds] = useState(() => {
    const m = {};
    window.WS_PROJECTS.forEach(p => { if (p.tabs.length) m[p.id] = p.tabs.find(x => x.focused)?.id ?? p.tabs[0].id; });
    return m;
  });
  const [focusedPaneByTab, setFocusedPaneByTab] = useState({
    t1: 'p1', t2: 'p4', t3: 'p5', t4: 'p6',
    pt1: 'pp1', pt2: 'pp2', ht1: 'hp1',
  });

  const [showQS, setShowQS]       = useState(false);
  const [showAdd, setShowAdd]     = useState(false);
  const [editId, setEditId]       = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);
  const [bannerSeen, setBannerSeen] = useState(() => localStorage.getItem('ws-banner-seen') === '1');
  const [crashSeen, setCrashSeen] = useState(false);

  const [cliPopover, setCliPopover] = useState(null);  // {anchor, mode: 'newTab'|'replacePane'}
  const [winMenuOpen, setWinMenuOpen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState(null);

  // Settings (persistent demo)
  const [settings, setSettingsState] = useState(window.WS_SETTINGS);
  const setSettings = (patch) => setSettingsState(s => ({ ...s, ...patch }));

  // Search overlay
  const [searchQuery, setSearchQuery] = useState('');
  const [searchCount, setSearchCount] = useState(0);
  const [searchIdx, setSearchIdx] = useState(0);

  // Toasts
  const [toasts, setToasts] = useState([]);
  const pushToast = (toast) => setToasts(ts => [...ts, { ...toast, id: Date.now() + Math.random() }]);
  const dismissToast = (id) => setToasts(ts => ts.filter(t => t.id !== id));

  // Skeleton timer
  useEffect(() => {
    if (t.showSkeleton) {
      const x = setTimeout(() => setTweak('showSkeleton', false), 4000);
      return () => clearTimeout(x);
    }
  }, [t.showSkeleton]);

  const cliMap = useMemo(() => Object.fromEntries(window.WS_CLIS.map(c => [c.id, c])), []);
  const activeProject = projects.find(p => p.id === activeProjectId) || projects[0];
  const activeTabId   = activeTabIds[activeProject.id];
  const activeTab     = activeProject.tabs.find(x => x.id === activeTabId);

  // Pre-fill search demo
  useEffect(() => {
    if (t.showSearch && !searchQuery) setSearchQuery('Compiled');
    if (!t.showSearch) { setSearchQuery(''); setSearchIdx(0); }
  }, [t.showSearch]);

  useEffect(() => {
    const onKey = (e) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === 'k') { e.preventDefault(); setShowQS(true); }
      else if (meta && e.key.toLowerCase() === 'n') { e.preventDefault(); setShowAdd(true); }
      else if (meta && e.key === ',')              { e.preventDefault(); setTweak('showSettings', true); }
      else if (meta && e.key.toLowerCase() === 'f') { e.preventDefault(); setTweak('showSearch', true); }
      else if (meta && e.key.toLowerCase() === 't') { e.preventDefault(); openCliPopover('newTab'); }
      else if (e.key === 'Escape') {
        setShowQS(false); setShowAdd(false); setCliPopover(null);
        setTweak('showSearch', false); setTweak('showSettings', false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const switchProject = (id) => { setActiveProjectId(id); setShowQS(false); };
  const closeTab = (tabId) => {
    setProjects(ps => ps.map(p => p.id === activeProject.id
      ? { ...p, tabs: p.tabs.filter(x => x.id !== tabId) } : p));
  };
  const createProject = ({ name, folder, color, glyph, cli }) => {
    const id = 'np_' + Date.now();
    setProjects(ps => [...ps, { id, name, color, glyph, branch: 'main', sessions: 0, cwd: folder, tabs: [], panes: {} }]);
    setActiveProjectId(id); setShowAdd(false);
    pushToast({ type: 'success', title: 'Project created', body: `${name} is ready.` });
  };
  const saveProject = (patch) => {
    setProjects(ps => ps.map(p => p.id === editId ? { ...p, ...patch } : p));
    setEditId(null);
  };
  const deleteProject = (id) => {
    setProjects(ps => ps.filter(p => p.id !== id));
    if (activeProjectId === id && projects.length > 1) {
      const next = projects.find(p => p.id !== id);
      if (next) setActiveProjectId(next.id);
    }
    setConfirmDel(null); setEditId(null);
  };
  const focusPane = (paneId) => setFocusedPaneByTab(m => ({ ...m, [activeTabId]: paneId }));

  // Layout mutation (split drag)
  const updateLayout = (newLayout) => {
    setProjects(ps => ps.map(p => p.id !== activeProject.id ? p
      : { ...p, tabs: p.tabs.map(tb => tb.id !== activeTabId ? tb : { ...tb, layout: newLayout }) }));
  };

  const openCliPopover = (mode) => {
    setCliPopover({ mode, anchor: { right: 12, top: 'calc(var(--titlebar-h) + var(--density-tab) + 8px)' } });
  };
  const handleCliPick = (cli) => {
    const newTabId = 'tab_' + Date.now();
    const newPaneId = 'pane_' + Date.now();
    setProjects(ps => ps.map(p => {
      if (p.id !== activeProject.id) return p;
      return {
        ...p,
        tabs: [...p.tabs, { id: newTabId, label: cli.id, cli: cli.id, dirty: false,
          layout: { kind: 'pane', paneId: newPaneId } }],
        panes: { ...p.panes, [newPaneId]: { cli: cli.id, cwd: p.cwd, focused: true, status: 'live',
          lines: [
            { t: 'prompt', s: p.cwd }, { t: 'cmd', s: cli.id },
            { t: 'sys', s: `◆ ${cli.name} v${cli.version}` },
            { t: 'cur', s: '' },
          ] } },
      };
    }));
    setActiveTabIds(m => ({ ...m, [activeProject.id]: newTabId }));
    setFocusedPaneByTab(m => ({ ...m, [newTabId]: newPaneId }));
    setCliPopover(null);
  };

  const focusedPaneId = focusedPaneByTab[activeTabId];

  return (
    <>
      <div className="ws-app" data-os={t.os} style={{ '--sidebar-w': t.sidebarWidth + 'px' }}>
        {/* Title bar */}
        <div className="titlebar">
          {t.os === 'mac' && <MacTraffic/>}
          {t.os === 'win' && (
            <button className="win-hamburger" onClick={() => setWinMenuOpen(o => !o)}>
              <IconHam size={14}/>
            </button>
          )}
          <div className="tb-spacer"/>
          <div className="tb-title">
            <span className="tb-dot" style={{ background: activeProject.color }}/>
            <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{activeProject.name}</span>
            <span className="tb-sep">·</span>
            <span className="tb-branch"><IconBranch size={11}/> {activeProject.branch}</span>
          </div>
          <div className="tb-spacer"/>
          <div className="tb-actions">
            <Tip label="Quick switcher" keys={['⌘','K']} side="down">
              <button className="tb-icon-btn" onClick={() => setShowQS(true)}><IconSearch size={13}/></button>
            </Tip>
            <Tip label="Settings" keys={['⌘',',']} side="down">
              <button className="tb-icon-btn" onClick={() => setTweak('showSettings', true)}><IconCog size={13}/></button>
            </Tip>
          </div>
          {t.os === 'win' && <WinControls/>}
          {winMenuOpen && t.os === 'win' && <WinMenu onClose={() => setWinMenuOpen(false)}/>}
        </div>

        {/* Update banner */}
        {t.showBanner && !bannerSeen && (
          <div className="banner">
            <span className="b-spin"><IconRefresh size={12}/></span>
            <span>Update available — v0.7.3 ready to install.</span>
            <button className="btn ghost" style={{ height: 22, padding: '0 8px' }}>Restart</button>
            <button className="tb-icon-btn" style={{ width: 20, height: 20 }}
                    onClick={() => { setBannerSeen(true); localStorage.setItem('ws-banner-seen', '1'); }}>
              <IconX size={11}/>
            </button>
          </div>
        )}

        {/* Crash banner under titlebar */}
        {t.showCrashBanner && !crashSeen && (
          <CrashBanner onClose={() => { setCrashSeen(true); setTweak('showCrashBanner', false); }}/>
        )}

        <div className="ws-body">
          {/* Main */}
          <div className="ws-main">
            {t.showSettings ? (
              <div style={{ gridRow: '1 / -1', minHeight: 0, height: '100%', display: 'flex', flexDirection: 'column' }}>
                <SettingsPage projectName={activeProject.name}
                              onBack={() => setTweak('showSettings', false)}
                              settings={settings} setSettings={setSettings}
                              hotkeys={window.WS_HOTKEYS} clis={window.WS_CLIS}/>
              </div>
            ) : t.showSkeleton ? (
              <>
                <div className="tabstrip"><div className="tab-scroll">
                  <div className="skel-row" style={{ width: 160, padding: '8px 10px' }}>
                    <div className="skel skel-icon" style={{ width: 14, height: 14 }}/>
                    <div className="skel skel-block" style={{ width: '60%' }}/>
                    <div/>
                  </div>
                </div></div>
                <WorkspaceSkeleton/>
              </>
            ) : activeProject.tabs.length > 0 && activeTab ? (
              <>
                <TabStrip tabs={activeProject.tabs} activeId={activeTabId} cliMap={cliMap}
                          onActivate={(id) => setActiveTabIds(m => ({ ...m, [activeProject.id]: id }))}
                          onClose={closeTab}
                          onAdd={() => openCliPopover('newTab')}/>
                <div className="pane-area" style={{ position: 'relative' }}>
                  <ResizableLayout node={activeTab.layout}
                                   panes={renderPanes(activeProject.panes, t.showPaneError)}
                                   focusedPaneId={focusedPaneId}
                                   onFocusPane={focusPane}
                                   cliMap={cliMap}
                                   onLayoutChange={updateLayout}
                                   searchQuery={t.showSearch ? searchQuery : ''}
                                   searchPaneId={focusedPaneId}
                                   currentMatch={searchIdx}
                                   onMatchCountChange={setSearchCount}/>
                  {t.showSearch && (
                    <TermSearch query={searchQuery} setQuery={setSearchQuery}
                                count={searchCount} currentIdx={searchIdx}
                                setCurrentIdx={setSearchIdx}
                                onClose={() => setTweak('showSearch', false)}/>
                  )}
                </div>
              </>
            ) : (
              <ProjectEmptyState project={activeProject} clis={window.WS_CLIS}/>
            )}
          </div>

          {/* Sidebar */}
          {t.showSkeleton ? <SidebarSkeleton/> : (
            <div className="sidebar">
              <div className="sb-section">
                <span>Projects</span>
                <Tip label="New project" keys={['⌘','N']}>
                  <button className="sb-section-act" onClick={() => setShowAdd(true)}><IconPlus size={12}/></button>
                </Tip>
              </div>
              <div className="sb-list">
                {projects.map((p) => (
                  <div key={p.id}
                       className={`sb-row ${p.id === activeProjectId ? 'active' : ''}`}
                       onClick={() => switchProject(p.id)}
                       onContextMenu={(e) => {
                         e.preventDefault();
                         setCtxMenu({ x: e.clientX - 180, y: e.clientY, projectId: p.id });
                       }}>
                    <div className="sb-icon" style={{ background: p.color }}>{p.glyph}</div>
                    <div className="sb-name">{p.name}</div>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <button className="sb-edit" onClick={(e) => { e.stopPropagation(); setEditId(p.id); }}>
                        <IconPencil size={11}/>
                      </button>
                      <div className="sb-meta">
                        {p.sessions > 0
                          ? <><span className="live-dot"/><span className="badge">{p.sessions}</span></>
                          : <span className="badge" style={{ opacity: 0.5 }}>—</span>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="sb-footer">
                <button className="sb-add" onClick={() => setShowAdd(true)}>
                  <IconPlus size={12}/> New project
                  <Kbd>⌘N</Kbd>
                </button>
                <Tip label="Settings" keys={['⌘',',']}>
                  <button className="sb-icon-btn" onClick={() => setTweak('showSettings', true)}><IconCog size={14}/></button>
                </Tip>
              </div>
            </div>
          )}
        </div>

        {/* Toasts */}
        <div className="toast-stack">
          {toasts.map(toast => <Toast key={toast.id} toast={toast} onDismiss={dismissToast}/>)}
        </div>

        {/* Modals & overlays */}
        {showQS  && <QuickSwitcher projects={projects} onPick={switchProject} onClose={() => setShowQS(false)}/>}
        {showAdd && <AddProjectModal clis={window.WS_CLIS} onCreate={createProject} onClose={() => setShowAdd(false)}/>}
        {editId  && (() => {
          const proj = projects.find(p => p.id === editId);
          if (!proj) return null;
          return <EditProjectModal project={proj} clis={window.WS_CLIS}
                                   onClose={() => setEditId(null)}
                                   onSave={saveProject}
                                   onDelete={() => setConfirmDel(editId)}/>;
        })()}
        {confirmDel && (() => {
          const proj = projects.find(p => p.id === confirmDel);
          if (!proj) return null;
          return <DeleteConfirmModal project={proj}
                                     onCancel={() => setConfirmDel(null)}
                                     onConfirm={() => deleteProject(confirmDel)}/>;
        })()}
        {cliPopover && <CliPopover clis={window.WS_CLIS} anchor={cliPopover.anchor}
                                   onPick={handleCliPick}
                                   onClose={() => setCliPopover(null)}/>}
        {ctxMenu && (() => {
          const p = projects.find(pr => pr.id === ctxMenu.projectId);
          return (
            <ContextMenu x={ctxMenu.x} y={ctxMenu.y} onClose={() => setCtxMenu(null)}
                         items={[
                           { label: 'Switch to project', onClick: () => switchProject(p.id) },
                           { label: 'Edit…',             onClick: () => setEditId(p.id) },
                           { label: 'Reveal in Finder',  onClick: () => {} },
                           { label: 'Delete', danger: true, onClick: () => { setEditId(p.id); setTimeout(() => setConfirmDel(p.id), 0); } },
                         ]}/>
          );
        })()}
        {t.showOnboarding && <Onboarding onClose={() => setTweak('showOnboarding', false)}
                                         onCreateProject={createProject}
                                         clis={window.WS_CLIS}/>}
      </div>

      <TweaksPanel>
        <TweakSection label="Theme"/>
        <TweakRadio label="Mode"   value={t.theme}   options={['dark','light']}                         onChange={(v) => setTweak('theme', v)}/>
        <TweakRadio label="Accent" value={t.accent}  options={Object.keys(ACCENTS)}                     onChange={(v) => setTweak('accent', v)}/>
        <TweakSection label="Window"/>
        <TweakRadio label="OS chrome" value={t.os}   options={['mac','win']}                            onChange={(v) => setTweak('os', v)}/>
        <TweakRadio label="Density"   value={t.density} options={['compact','comfortable']}             onChange={(v) => setTweak('density', v)}/>
        <TweakSlider label="Sidebar width" value={t.sidebarWidth} min={180} max={320} step={4} unit="px" onChange={(v) => setTweak('sidebarWidth', v)}/>
        <TweakSection label="Demo states"/>
        <TweakToggle label="Settings page"     value={t.showSettings}    onChange={(v) => setTweak('showSettings', v)}/>
        <TweakToggle label="Onboarding"        value={t.showOnboarding}  onChange={(v) => setTweak('showOnboarding', v)}/>
        <TweakToggle label="Pane spawn error"  value={t.showPaneError}   onChange={(v) => setTweak('showPaneError', v)}/>
        <TweakToggle label="Crash banner"      value={t.showCrashBanner} onChange={(v) => { setTweak('showCrashBanner', v); setCrashSeen(false); }}/>
        <TweakToggle label="Update banner"     value={t.showBanner}      onChange={(v) => { setTweak('showBanner', v); setBannerSeen(false); localStorage.removeItem('ws-banner-seen'); }}/>
        <TweakToggle label="Search overlay"    value={t.showSearch}      onChange={(v) => setTweak('showSearch', v)}/>
        <TweakToggle label="Skeleton loaders"  value={t.showSkeleton}    onChange={(v) => setTweak('showSkeleton', v)}/>
        <TweakSection label="Trigger toast"/>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
          <button className="btn" style={{ height: 24, fontSize: 11 }} onClick={() => pushToast(window.WS_DEMO_ERRORS.toastSamples[0])}>Error</button>
          <button className="btn" style={{ height: 24, fontSize: 11 }} onClick={() => pushToast(window.WS_DEMO_ERRORS.toastSamples[1])}>Warning</button>
          <button className="btn" style={{ height: 24, fontSize: 11 }} onClick={() => pushToast(window.WS_DEMO_ERRORS.toastSamples[2])}>Info</button>
          <button className="btn" style={{ height: 24, fontSize: 11 }} onClick={() => pushToast(window.WS_DEMO_ERRORS.toastSamples[3])}>Success</button>
        </div>
      </TweaksPanel>
    </>
  );
}

// Apply pane error injection
function renderPanes(panes, showError) {
  if (!showError) return panes;
  // Attach error marker to argon's p1 pane
  return Object.fromEntries(Object.entries(panes).map(([k, v]) =>
    k === 'p1' ? [k, { ...v, status: 'error', __error: window.WS_DEMO_ERRORS.paneSpawnError }] : [k, v]
  ));
}

// Wrap Pane2 to honor __error
const _Pane2 = window.Pane2;
window.Pane2 = function(props) {
  const e = props.pane && props.pane.__error;
  return _Pane2({ ...props, error: e });
};

function ProjectEmptyState({ project, clis }) {
  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100%', background: 'var(--bg-canvas)' }}>
      <div style={{ width: 'min(520px, 80%)', textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 18, alignItems: 'center' }}>
        <div className="sb-icon" style={{ background: project.color, width: 48, height: 48, borderRadius: 12, fontSize: 16 }}>{project.glyph}</div>
        <div>
          <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>{project.name}</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)', marginTop: 4, fontFamily: 'var(--font-mono)' }}>{project.cwd}</div>
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', maxWidth: 360 }}>No sessions yet. Pick a CLI to spawn the first pane.</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, width: '100%' }}>
          {clis.slice(0, 6).map(c => (
            <button key={c.id} className="pe-cli" style={{
              display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4,
              padding: 12, background: 'var(--bg-surface)', border: '1px solid var(--border-default)',
              borderRadius: 6, cursor: 'default',
            }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: c.color }}/>
                <span style={{ color: 'var(--text-primary)', fontSize: 12.5, fontWeight: 500 }}>{c.name}</span>
              </span>
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>v{c.version}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App/>);
