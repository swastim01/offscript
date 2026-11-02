import { FormEvent, useEffect, useRef, useState } from 'react';
import { getBossBeat, type Phase } from '../server/engine.js';

type Feed = { user: string; command: string; text: string; time: number; kind: string; source?: 'simulated' | 'twitch' };
type Memory = { id: string; boss: string; theme: string; result: string; text: string; reward?: string; at: number };
type Proposal = { boss: string; theme: string; source: string; method: string; evidenceCount: number; evidenceWindowSeconds: number; sampleSize: number } | null;
type Connection = {
  state: 'not_configured' | 'needs_authorization' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'connection_error';
  channel: { id: string; login: string; displayName: string } | null;
  message: string | null;
  configured: boolean;
  authorizationStartUrl: string | null;
};
type DemoRun = { active: boolean; stage: 'awakening' | 'fracture' | 'last_stand' | 'victory' | null };
type State = {
  phase: Phase; boss: string; theme: string; hp: number; maxHp: number; secondsLeft: number; duration: number;
  viewers: number; lore: string; score: number; streak: number; feed: Feed[]; playerScores: Record<string, number>;
  history: Memory[]; memories: Memory[]; rewardCount: number; guardCharges: number;
};
type DashboardResponse = State & { proposal: Proposal; connection: Connection; demoRun: DemoRun; chatCount?: { simulated: number; twitch: number } };
type RealtimeSnapshot = { type: 'state'; state: State; proposal: Proposal; connection: Connection; demoRun: DemoRun; chatCount: { simulated: number; twitch: number } };

const initialConnection: Connection = { state: 'not_configured', channel: null, message: 'Twitch is not configured.', configured: false, authorizationStartUrl: null };
const initialDemoRun: DemoRun = { active: false, stage: null };
const initial: State = {
  phase: 'idle', boss: 'The Algorithm', theme: 'The chat keeps saying “one more run”', hp: 2400, maxHp: 2400,
  secondsLeft: 120, duration: 120, viewers: 0, lore: 'A community story begins when chat wins together.', score: 0,
  streak: 0, feed: [], playerScores: {}, history: [], memories: [], rewardCount: 0, guardCharges: 0,
};

async function request(path: string, method = 'POST', body?: unknown) {
  const response = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.reason || 'Could not complete that action.');
  return data;
}

function connectionTitle(connection: Connection) {
  switch (connection.state) {
    case 'connected': return 'Chat subscription active';
    case 'connecting': return 'Connecting to Twitch';
    case 'reconnecting': return 'Chat reconnecting';
    case 'connection_error': return 'Twitch needs attention';
    case 'needs_authorization': return 'Twitch ready to connect';
    case 'disconnected': return 'Twitch disconnected';
    default: return 'Twitch not configured';
  }
}

function connectionFallback(connection: Connection) {
  if (connection.state === 'connection_error') return 'The chat subscription stopped. Check the server status, then connect Twitch again.';
  if (connection.state === 'reconnecting') return 'The connection is recovering. Chat actions will resume when EventSub is back.';
  if (connection.state === 'connecting') return 'Twitch authorization is complete; waiting for EventSub chat subscription confirmation.';
  if (connection.state === 'connected') return 'EventSub confirmed the channel chat subscription.';
  if (connection.state === 'needs_authorization') return 'Twitch is configured. Connect the channel to enable real chat.';
  if (connection.state === 'disconnected') return 'Twitch is disconnected. The simulated demo is still available.';
  return 'The local demo remains available while Twitch is offline.';
}

function connectionFooter(connection: Connection) {
  switch (connection.state) {
    case 'connected': return 'TWITCH CHAT ACTIVE · DEMO AVAILABLE';
    case 'connecting': return 'TWITCH CONNECTING · DEMO AVAILABLE';
    case 'reconnecting': return 'TWITCH RECONNECTING · DEMO AVAILABLE';
    case 'connection_error': return 'TWITCH NEEDS ATTENTION · DEMO AVAILABLE';
    case 'needs_authorization': return 'TWITCH READY TO CONNECT · DEMO AVAILABLE';
    case 'disconnected': return 'TWITCH DISCONNECTED · DEMO AVAILABLE';
    default: return 'DEMO READY · TWITCH NOT CONFIGURED';
  }
}

function overlaySourceStatus(connection: Connection) {
  switch (connection.state) {
    case 'connected': return 'TWITCH CHAT SUBSCRIPTION ACTIVE';
    case 'connecting': return 'TWITCH CHAT CONNECTING';
    case 'reconnecting': return 'TWITCH CHAT RECONNECTING';
    case 'connection_error': return 'TWITCH CHAT NEEDS ATTENTION';
    case 'needs_authorization': return 'TWITCH CHAT NOT AUTHORIZED';
    case 'disconnected': return 'TWITCH CHAT DISCONNECTED';
    default: return 'SIMULATED CHAT ONLY';
  }
}

function demoStageLabel(stage: DemoRun['stage']) {
  switch (stage) {
    case 'awakening': return 'Awakening';
    case 'fracture': return 'Fracture';
    case 'last_stand': return 'Final stand';
    case 'victory': return 'Victory';
    default: return 'Preparing';
  }
}

export default function App() {
  const overlay = new URLSearchParams(location.search).has('overlay');
  const realtimeStateSeen = useRef(false);
  const [state, setState] = useState<State>(initial);
  const [proposal, setProposal] = useState<Proposal>(null);
  const [connection, setConnection] = useState<Connection>(initialConnection);
  const [demoRun, setDemoRun] = useState<DemoRun>(initialDemoRun);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [user, setUser] = useState('PixelPilot');
  const [message, setMessage] = useState('one more run, the build is almost ready');

  useEffect(() => {
    request('/api/state', 'GET').then((snapshot: DashboardResponse) => {
      // A delayed HTTP snapshot must not overwrite a newer state already received on WebSocket.
      if (realtimeStateSeen.current) return;
      const { proposal: nextProposal, connection: nextConnection, ...gameState } = snapshot;
      setState(gameState);
      setProposal(nextProposal ?? null);
      setConnection(nextConnection ?? initialConnection);
      setDemoRun(snapshot.demoRun ?? initialDemoRun);
    }).catch(() => { if (!realtimeStateSeen.current) setNotice('Server unavailable. Start OFFSCRIPT with npm run dev.'); });

    const result = new URLSearchParams(location.search);
    const twitchResult = result.get('twitch');
    const twitchMessage = result.get('twitchMessage');
    const rawTwitchStage = result.get('twitchStage');
    const knownStages = ['oauth_start', 'callback_received', 'state_validation', 'token_exchange', 'token_validation', 'user_lookup', 'authorization_result', 'eventsub_start', 'oauth_error'];
    const twitchStage = rawTwitchStage && knownStages.includes(rawTwitchStage) ? rawTwitchStage.replaceAll('_', ' ') : null;
    if (twitchResult) {
      setNotice(twitchMessage ? `${twitchStage ? `${twitchStage}: ` : ''}${twitchMessage}` : twitchResult === 'connected' ? 'Twitch chat subscription is active.' : 'Twitch connection did not complete.');
      history.replaceState({}, '', location.pathname + location.hash);
    }

    let disposed = false;
    let retryTimer: number | undefined;
    let socket: WebSocket | undefined;
    const connect = () => {
      if (disposed) return;
      const current = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/socket`);
      socket = current;
      current.onmessage = event => {
        try {
          const snapshot = JSON.parse(event.data) as RealtimeSnapshot;
          if (snapshot.type !== 'state') return;
          realtimeStateSeen.current = true;
          setState(snapshot.state);
          setProposal(snapshot.proposal ?? null);
          setConnection(snapshot.connection ?? initialConnection);
          setDemoRun(snapshot.demoRun ?? initialDemoRun);
        } catch { /* Ignore malformed frames and keep the last authoritative snapshot. */ }
      };
      current.onclose = () => { if (!disposed) retryTimer = window.setTimeout(connect, 1500); };
      current.onerror = () => current.close();
    };
    connect();
    return () => { disposed = true; if (retryTimer !== undefined) window.clearTimeout(retryTimer); socket?.close(); };
  }, []);

  async function act(path: string, body?: unknown, success?: string) {
    setBusy(true);
    try {
      const result = await request(path, 'POST', body);
      if (!realtimeStateSeen.current) {
        if (result.state) setState(result.state);
        if ('proposal' in result) setProposal(result.proposal);
        if (result.connection) setConnection(result.connection);
        if (result.demoRun) setDemoRun(result.demoRun);
      }
      setNotice(success ?? result.message ?? result.reason ?? 'Action complete.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Something went wrong.');
    } finally { setBusy(false); }
  }

  function sendMessage(event: FormEvent) {
    event.preventDefault();
    void act('/api/chat/message', { user, text: message, source: 'simulated' }, 'Simulated chat message processed.');
  }

  const percent = state.maxHp ? Math.max(0, Math.min(100, state.hp / state.maxHp * 100)) : 0;
  const leader = Object.entries(state.playerScores).sort((a, b) => b[1] - a[1])[0];
  const live = state.phase === 'live';
  const bossBeat = getBossBeat(state);
  const phaseLabel: Record<string, string> = {
    idle: 'Arena standby', prepared: 'Proposal ready', live: 'Event live', paused: 'Paused',
    won: 'Boss defeated', lost: 'Time expired', ended: 'Event ended',
  };

  return <main className={overlay ? 'app overlay' : 'app'}>
    {!overlay && <header className="topbar">
      <a className="brand" href="/"><span className="brand-mark">O</span><span>OFFSCRIPT</span><span className="brand-tag">BETA</span></a>
      <div className="top-right"><span className={`sim-pill ${connection.state}`}><i aria-hidden="true"/>{connectionTitle(connection)}</span><span className="avatar" aria-hidden="true">O</span></div>
    </header>}

    <div className="layout">
      {!overlay && <aside className="sidebar">
        <div className="side-nav"><div className="side-label">CONTROL ROOM</div><a className="nav active" href="#dashboard"><span aria-hidden="true">◈</span> Live dashboard</a><a className="nav" href="/?overlay" target="_blank" rel="noreferrer"><span aria-hidden="true">▣</span> OBS overlay <span className="external">↗</span></a></div>
        <TwitchPanel connection={connection} busy={busy} onDisconnect={() => void act('/api/twitch/disconnect', undefined, 'Twitch disconnected. Demo mode is ready.')} />
      </aside>}

      <section className="content" id="dashboard">
        {!overlay && <div className="page-heading">
          <div><div className="eyebrow">YOUR STREAM, OFFSCRIPT</div><h1>Live dashboard</h1><p>Turn chat’s running jokes into a shared fight.</p></div>
          <div className={`event-state ${state.phase}`} aria-live="polite"><i aria-hidden="true"/>{phaseLabel[state.phase] ?? 'Arena standby'}</div>
        </div>}

        <section className="boss-card" aria-labelledby="boss-title">
          <div className="boss-backdrop" aria-hidden="true"/>
          <div className="boss-content">
            <div className="boss-meta"><span className="encounter"><span aria-hidden="true">✦</span> COMMUNITY ENCOUNTER</span><span className="round">{live ? 'ENCOUNTER IN PROGRESS' : state.phase === 'prepared' ? 'STREAMER REVIEW' : 'DEMO ARENA'}</span></div>
            <div className="boss-title-row"><div><div className="boss-kicker">THE FINAL BOSS</div><h2 id="boss-title">{state.boss}</h2><p>{state.theme}</p></div><div className="boss-sigil" aria-hidden="true">☄</div></div>
            {bossBeat && <div className={`boss-beat ${bossBeat.phase}`} aria-live="polite"><span>PHASE · {bossBeat.label}</span><p>{bossBeat.message}</p></div>}
            <div className="health-label"><span>Boss health</span><strong>{state.hp.toLocaleString()} <small>/ {state.maxHp.toLocaleString()} HP</small></strong></div>
            <div className="health-track" role="progressbar" aria-label="Boss health" aria-valuemin={0} aria-valuemax={state.maxHp} aria-valuenow={state.hp} aria-valuetext={`${state.hp.toLocaleString()} of ${state.maxHp.toLocaleString()} HP`}><div className="health-fill" style={{ width: `${percent}%` }}><span aria-hidden="true"/></div></div>
            <div className="boss-foot"><span>{percent === 0 ? 'DEFEATED' : `${Math.round(percent)}% HEALTH REMAINING`}</span><span><b aria-hidden="true">⌁</b> {state.streak}× TEAM STREAK · {state.guardCharges}/3 WARDS</span></div>
            <div className="event-banner" aria-live="polite">{live ? <><span className="live-dot" aria-hidden="true"/> THE FIGHT IS ON <b>·</b> CHAT, ATTACK TOGETHER</> : state.phase === 'won' ? '✦ THE COMMUNITY CLAIMS VICTORY' : state.phase === 'prepared' ? 'REVIEW THE PROPOSAL, THEN START THE FIGHT' : state.phase === 'paused' ? 'THE FIGHT IS PAUSED' : 'READY WHEN YOUR COMMUNITY IS'}</div>
          </div>
        </section>

        {!overlay && <section className="mobile-twitch"><TwitchPanel connection={connection} busy={busy} onDisconnect={() => void act('/api/twitch/disconnect', undefined, 'Twitch disconnected. Demo mode is ready.')} /></section>}

        {!overlay && <div className="control-row"><div className="event-controls">
          {state.phase === 'paused' ? <button className="btn btn-primary" disabled={busy} onClick={() => void act('/api/event/resume')}>▶ Resume encounter</button> : <button className="btn btn-primary" disabled={busy || live} onClick={() => void act('/api/event/start')}>{live ? '◉ Encounter live' : state.phase === 'prepared' ? '▶ Start approved encounter' : '▶ Start encounter'}</button>}
          {live && <button className="btn btn-quiet" disabled={busy} onClick={() => void act('/api/event/pause')}>Ⅱ Pause</button>}
          {(live || state.phase === 'paused') && <button className="btn btn-quiet" disabled={busy} onClick={() => void act('/api/event/end')}>■ End encounter</button>}
          <button className="btn btn-icon" aria-label="Reset scenario" title="Reset scenario" disabled={busy} onClick={() => void act('/api/event/reset', {}, 'Scenario reset. No reward was granted.')}>↻</button>
        </div><a className="open-overlay" href="/?overlay" target="_blank" rel="noreferrer">Open OBS overlay <span>↗</span></a></div>}

        <div className="stats-grid" aria-label="Encounter statistics">
          <Stat label="TIME LEFT" value={`${Math.floor(state.secondsLeft / 60)}:${String(state.secondsLeft % 60).padStart(2, '0')}`} sub="Encounter countdown" icon="◷"/>
          <Stat label="IN THE FIGHT" value={String(state.viewers)} sub="Joined participants" icon="♙"/>
          <Stat label="COMMUNITY SCORE" value={state.score.toLocaleString()} sub={leader ? `Top: ${leader[0]} · ${leader[1].toLocaleString()} pts` : 'Earned together'} icon="✳"/>
          <Stat label="REWARDS UNLOCKED" value={String(state.rewardCount)} sub="Unique victory badges" icon="♛"/>
        </div>

        {!overlay && <div className="lower-grid">
          <div className="left-stack">
            <section className="panel studio" aria-labelledby="studio-title">
              <div className="panel-heading"><div><div className="eyebrow">CHAT → ENCOUNTER</div><h3 id="studio-title">Community signal</h3><p>Repeated phrases from Twitch chat or the simulator can become a proposal.</p></div><span className="sim-tag">REAL + DEMO INPUT</span></div>
              <form className="chat-form" onSubmit={sendMessage}><label>Demo chat name<input disabled={demoRun.active} value={user} maxLength={24} onChange={event => setUser(event.target.value)} aria-label="Demo chat name"/></label><label>Demo message<input disabled={demoRun.active} value={message} maxLength={180} onChange={event => setMessage(event.target.value)} aria-label="Demo chat message"/></label><button className="btn btn-quiet" disabled={busy || demoRun.active}>Add demo message</button></form>
              <div className="studio-actions"><button className="btn btn-quiet" disabled={busy || demoRun.active} onClick={() => void act('/api/demo/conversation', {}, 'Sample conversation added. Review the proposal below.')}>Load sample conversation</button></div>
              {proposal ? <div className="proposal"><div className="proposal-copy"><div className="eyebrow">PROPOSAL FOR STREAMER REVIEW · {proposal.source}</div><strong>{proposal.boss}</strong><p>{proposal.theme}</p><small>Matched in {proposal.evidenceCount} of the latest {proposal.sampleSize} messages over {proposal.evidenceWindowSeconds} seconds. Approving prepares the encounter; it does not start the fight.</small></div><div className="proposal-actions"><button className="btn btn-primary" disabled={busy || demoRun.active || live || state.phase === 'paused'} onClick={() => void act('/api/encounter/approve', {}, 'Proposal approved. Start the encounter when chat is ready.')}>Approve proposal</button><button className="btn btn-quiet" disabled={busy || demoRun.active} onClick={() => void act('/api/encounter/reject', undefined, 'Proposal declined. New repeated phrases can still create another.')}>Decline</button></div></div> : <div className="studio-empty"><strong>Waiting for a repeated phrase</strong><span>Twitch chat messages are collected while the subscription is active. A repeated phrase creates a review card here; the streamer decides what happens next.</span></div>}
            </section>

            <section className="panel simulate" aria-labelledby="demo-title"><div className="panel-heading"><div><h3 id="demo-title">Demo controls</h3><p>Practice the same authoritative encounter rules without Twitch.</p></div><span className="sim-tag">SIMULATED</span></div><div className="demo-buttons"><button className="demo-run" disabled={busy || demoRun.active || connection.state === 'connected' || live || state.phase === 'paused'} onClick={() => void act('/api/demo/run', {}, 'Simulated arena replay started. Watch the phase changes.')}>{demoRun.active ? `◉ SIMULATED · ${demoStageLabel(demoRun.stage)}` : '▶ Run phased demo replay'}</button><button disabled={busy || demoRun.active || !live} onClick={() => void act('/api/mock', { user: 'PixelPilot', command: 'join' })}>!join PixelPilot</button></div><div className="chat-actions">{(['attack', 'shield', 'inspect', 'lore'] as const).map(command => <button key={command} disabled={busy || demoRun.active || (command !== 'lore' && !live)} onClick={() => void act('/api/mock', { user: 'PixelPilot', command })}>!{command}</button>)}</div><p className="sim-caption" role={demoRun.active ? 'status' : undefined}>{demoRun.active ? `SIMULATION ONLY · ${demoStageLabel(demoRun.stage)} phase. Every replay action is labeled DEMO.` : connection.state === 'connected' ? 'Disconnect Twitch before rehearsing the simulated replay. Real chat remains separate.' : 'A staged replay shows all three boss phases, the team ward, victory, and saved lore. Simulated actions are labeled DEMO.'}</p></section>

            <ActivityFeed items={state.feed} live={live}/>
          </div>

          <div className="right-stack">
            <section className="panel lore"><div className="panel-heading"><div><div className="eyebrow">COMMUNITY LORE</div><h3>Written by the fight</h3></div><span className="lore-icon" aria-hidden="true">✧</span></div><p>“{state.lore}”</p><div className="lore-credit">✦ &nbsp;{state.rewardCount} UNIQUE VICTORY REWARD{state.rewardCount === 1 ? '' : 'S'}</div></section>
            <section className="panel history"><div className="panel-heading"><div><h3>Encounter history</h3><p>Recent community memories</p></div><span className="history-count">{state.history.length}</span></div>{state.history.length ? <div className="history-list">{state.history.slice(0, 5).map(memory => <article className="memory" key={memory.id}><div><span className={`result-chip ${memory.result}`}>{memory.result === 'won' ? 'VICTORY' : 'DEFEAT'}</span><time dateTime={new Date(memory.at).toISOString()}>{new Date(memory.at).toLocaleDateString()}</time></div><strong>{memory.boss}</strong><p>{memory.text}</p>{memory.reward && <small>✦ {memory.reward}</small>}</article>)}</div> : <div className="studio-empty history-empty"><strong>No memories yet</strong><span>Finish an encounter to record how chat rallied and which rewards were earned.</span></div>}</section>
            <section className="panel command-help"><div className="panel-heading"><div><h3>Chat commands</h3><p>Join first for combat actions. Lore is available after a memory is earned.</p></div></div><dl><div><dt><code>!join</code></dt><dd>Enter the party during a live fight.</dd></div><div><dt><code>!attack</code></dt><dd>Damage the boss; cooldown applies.</dd></div><div><dt><code>!shield</code></dt><dd>Charge a team ward.</dd></div><div><dt><code>!inspect</code></dt><dd>Reveal a phase hint.</dd></div><div><dt><code>!lore</code></dt><dd>Recall the latest memory.</dd></div></dl></section>
          </div>
        </div>}

        {overlay && <ActivityFeed items={state.feed.slice(0, 6)} live={live} compact/>}
        {overlay && <div className="overlay-foot">{overlaySourceStatus(connection)} · {state.phase === 'live' ? 'ENCOUNTER LIVE' : 'ENCOUNTER READY'}{demoRun.active ? ` · SIMULATED ${demoStageLabel(demoRun.stage).toUpperCase()}` : ''}</div>}
        {notice && <div className="toast" role="status" aria-live="polite"><span>{notice}</span><button aria-label="Dismiss notification" onClick={() => setNotice('')}>×</button></div>}
        {!overlay && <footer><span>OFFSCRIPT <b>×</b> TWITCH CHAT ARENA</span><span>{connectionFooter(connection)}{demoRun.active ? ` · SIMULATED ${demoStageLabel(demoRun.stage).toUpperCase()}` : ''}</span></footer>}
      </section>
    </div>
  </main>;
}

function TwitchPanel({ connection, busy, onDisconnect }: { connection: Connection; busy: boolean; onDisconnect: () => void }) {
  const connected = connection.state === 'connected';
  return <section className="twitch-panel" aria-labelledby="twitch-title">
    <div className="side-label">TWITCH CONNECTION</div>
    <div className={`connection ${connection.state}`}><i aria-hidden="true"/><span id="twitch-title">{connectionTitle(connection)}</span></div>
    {connection.channel && <div className="channel-name">{connection.channel.displayName}<small>@{connection.channel.login}</small></div>}
    <p>{connection.message ?? connectionFallback(connection)}</p>
    {connected ? <button className="btn btn-quiet twitch-button" disabled={busy} onClick={onDisconnect}>Disconnect Twitch</button> : connection.configured && connection.authorizationStartUrl ? <a className="btn btn-primary twitch-button" href={connection.authorizationStartUrl}>Connect Twitch</a> : connection.state === 'connection_error' || connection.state === 'disconnected' ? <span className="recovery-hint">Reconnect after checking the backend status.</span> : null}
  </section>;
}

function Stat({ label, value, sub, icon }: { label: string; value: string; sub: string; icon: string }) {
  return <section className="stat"><div className="stat-top"><span>{label}</span><b aria-hidden="true">{icon}</b></div><strong>{value}</strong><small>{sub}</small></section>;
}

function ActivityFeed({ items, live, compact = false }: { items: Feed[]; live: boolean; compact?: boolean }) {
  return <section className={`panel activity${compact ? ' activity-compact' : ''}`} aria-labelledby={compact ? 'overlay-feed-title' : 'activity-title'}><div className="panel-heading"><div><h3 id={compact ? 'overlay-feed-title' : 'activity-title'}>{compact ? 'Battle events' : 'Activity feed'}</h3><p>{compact ? 'Recent actions from the shared game state.' : 'Real chat and demo events, in encounter order.'}</p></div><span className="feed-live"><i aria-hidden="true"/>{live ? 'LIVE' : 'READY'}</span></div>{items.length ? <div className="feed-list">{items.map((item, index) => <article className={`feed-item ${item.kind}`} key={`${item.time}-${index}`}><span className="feed-icon" aria-hidden="true">{item.kind === 'attack' ? '⚔' : item.kind === 'shield' ? '⬡' : item.kind === 'chat' ? '◌' : '✦'}</span><div className="feed-copy"><div className="feed-meta"><strong>{item.user}</strong>{item.command && <code>{item.command}</code>}{item.source && <b className={`source-chip ${item.source}`}>{item.source === 'twitch' ? 'TWITCH' : 'DEMO'}</b>}</div><span>{item.text}</span></div><time dateTime={new Date(item.time).toISOString()}>{new Date(item.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></article>)}</div> : <div className="empty-feed">No battle events yet. Start an encounter or let chat join the party.</div>}</section>;
}
