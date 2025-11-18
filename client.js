// client.js (ESM) — client groupe, grid identique au MJ
// .env : MJ_BASE_URL=http://localhost:4000  PLAYER_ID=p1  CLIENT_PORT=4101
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { EventSource } from 'eventsource';

const MJ = process.env.MJ_BASE_URL || 'http://localhost:4000';
const PLAYER_ID = process.env.PLAYER_ID || 'p1';
const CLIENT_PORT = process.env.CLIENT_PORT || 4101;

let lastSnapshot = null;
let lastChats = [];
const clientStreams = new Set();

function pushToClients(event, payload){
  const line = `event: ${event}\n` + `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clientStreams) res.write(line);
}

function attachToMJ(){
  const es = new EventSource(`${MJ}/events`);
  es.onopen = () => console.log(`[client ${PLAYER_ID}] connecté aux events MJ`);
  es.onerror = (e) => console.error(`[client ${PLAYER_ID}] MJ events error`, e?.message || e);
  es.addEventListener('state', ev => { lastSnapshot = JSON.parse(ev.data); pushToClients('state', lastSnapshot); });
  es.addEventListener('chat',  ev => { const m = JSON.parse(ev.data); lastChats.push(m); if (lastChats.length>200) lastChats.shift(); pushToClients('chat', m); });
  es.addEventListener('turn',  ev => { const t = JSON.parse(ev.data); pushToClients('turn', t); });
}
attachToMJ();

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (_req,res)=>res.json({ ok:true, playerId: PLAYER_ID, mj: MJ }));

app.post('/join', async (req,res)=>{
  try {
    const r = await fetch(`${MJ}/join`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ playerId: PLAYER_ID, name: req.body?.name, cls: req.body?.cls })
    });
    const j = await r.json(); res.status(r.status).json(j);
  } catch (e) { console.error(e); res.status(502).json({ error:'join proxy error' }); }
});

app.post('/say', async (req,res)=>{
  try {
    const { text } = req.body || {}; if (!text) return res.status(400).json({ error:'text required' });
    const r = await fetch(`${MJ}/chat`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ playerId: PLAYER_ID, text })
    });
    const j = await r.json(); res.status(r.status).json(j);
  } catch (e) { console.error(e); res.status(502).json({ error:'say proxy error' }); }
});

app.get('/state', (_req,res)=>res.json({ snapshot: lastSnapshot }));

app.get('/events', (req,res)=>{
  res.writeHead(200, { 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache', 'Connection':'keep-alive', 'Access-Control-Allow-Origin':'*' });
  clientStreams.add(res);
  if (lastSnapshot) res.write(`event: state\ndata: ${JSON.stringify(lastSnapshot)}\n\n`);
  for (const m of lastChats) res.write(`event: chat\ndata: ${JSON.stringify(m)}\n\n`);
  req.on('close', ()=> clientStreams.delete(res));
});

app.get('/', (_req,res)=>{
  res.type('html').send(`<!doctype html>
<html lang="fr"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Client RPG — ${PLAYER_ID}</title>
<style>
  :root { --cell: 30px; }
  body { font-family: system-ui, sans-serif; max-width: 960px; margin: 1rem auto; padding: 0 12px; }
  #top { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  #grid { width:600px; height:600px; display:grid; grid-template-columns: repeat(20, var(--cell)); gap: 0px; margin: 12px 0;
          background-size: cover; background-position: center; }
  .cell {
    width: var(--cell);
    height: var(--cell);
    border: 1px solid rgba(255,255,255,.3);
    background-position: center;
    background-repeat: no-repeat;
    background-size: contain; /* pour les icônes d'objets/monstres */
  }
  .floor { }
  .player { outline: 2px solid #3388ff; }
  #chat { border:1px solid #ddd; border-radius:8px; padding:8px; max-height:220px; overflow:auto; white-space:pre-wrap; }
  .mine { color:#06c; } .other { color:#444; }
  #turn { padding:6px 10px; border-radius:8px; background:#f2f2f2; }
  form { display:flex; gap:.5rem; margin-top:.5rem; }
  input,button { font-size:1rem; padding:.6rem .8rem; }
</style>
</head><body>
  <div id="top">
    <h2 style="margin:0">Client ${PLAYER_ID}</h2>
    <div id="turn">Tour: ...</div>
    <button id="joinBtn">Rejoindre</button>
    <button id="startBtn">Démarrer (MJ)</button>
  </div>

  <div id="stats"></div>
  <div id="grid"></div>

  <div id="chat"></div>
  <form id="f"><input id="msg" placeholder="Parler / agir..." style="flex:1"/><button>Envoyer</button></form>

<script>
const PLAYER_ID = ${JSON.stringify(PLAYER_ID)};
const MJ = ${JSON.stringify(MJ)};

const grid = document.getElementById('grid');
const chat = document.getElementById('chat');
const stats = document.getElementById('stats');
const turnBox = document.getElementById('turn');
const form = document.getElementById('f');
const msg = document.getElementById('msg');
const joinBtn = document.getElementById('joinBtn');
const startBtn = document.getElementById('startBtn');

let snapshot = null, active = null;

function abs(u){
  if (!u) return null;
  if (/^https?:\\/\\//i.test(u)) return u;
  // ex: '/assets/level1.png' -> 'http://MJ/assets/level1.png'
  return MJ.replace(/\\/$/,'') + u;
}

function pickViewMap(snap){
  if (!snap || !snap.maps || !snap.maps.length) return null;
  const id = snap.viewMapId || snap.players.find(p=>p.joined)?.mapId || snap.maps[0].id;
  return snap.maps.find(m=>m.id===id) || snap.maps[0];
}

function draw(){
  if (!snapshot) return;

  const me = snapshot.players.find(p=>p.id===PLAYER_ID);
  stats.innerHTML = me ? \`<b>\${me.name}</b> [\${me.cls}] — HP:\${me.hp} SP:\${me.sp} — Pos (\${me.x},\${me.y})\` : 'Non rejoint';

  const m = pickViewMap(snapshot);
  if (!m) { grid.innerHTML=''; return; }

  grid.style.backgroundImage = m.background ? 'url(' + abs(m.background) + ')' : 'none';
  grid.innerHTML = '';

  for (let y=0; y<m.grid.length; y++){
    for (let x=0; x<m.grid[0].length; x++){
      const d = document.createElement('div');
      d.className = 'cell floor';
      if (m.grid[y][x] === '#') d.classList.add('wall');

      // décor (teinte)
      const dec = (m.decor || []).find(dd => dd.x===x && dd.y===y);
      if (dec) d.classList.add('dec-' + dec.type);

      // item & monstre dans la même case ? on cumule les backgrounds (monstre au-dessus).
      const itm = (m.items || []).find(i => i.x===x && i.y===y);
      const mon = (m.monsters || []).find(mm => mm.x===x && mm.y===y);

      if (itm) d.classList.add('item');
      if (mon) d.classList.add('monster');

      const layers = [];
      if (itm?.icon) layers.push('url(' + abs(itm.icon) + ')');
      if (mon?.icon) layers.push('url(' + abs(mon.icon) + ')');
      if (layers.length) {
        d.style.backgroundImage = layers.join(', ');
        // même size/repeat/position pour toutes les couches (suffisant ici)
        d.style.backgroundRepeat = 'no-repeat';
        d.style.backgroundPosition = 'center';
        d.style.backgroundSize = 'contain';
      }

      // joueur ?
      if (snapshot.players.some(p=>p.joined && p.mapId===m.id && p.x===x && p.y===y)) d.classList.add('player');

      grid.appendChild(d);
    }
  }

  turnBox.textContent = active ? ('Tour: ' + active + (active===PLAYER_ID ? ' — À VOUS' : '')) : 'Tour: ...';
  msg.disabled = (active !== PLAYER_ID);
}

function logChat(m){
  const who = m.from===PLAYER_ID ? 'Vous' : m.from;
  const cls = m.from===PLAYER_ID ? 'mine' : 'other';
  const line = document.createElement('div');
  line.innerHTML = \`<span class="\${cls}"><b>\${who}</b>:</span> \${(m.text||'')}\` + (m.narrative? '<br><small>'+m.narrative+'</small>':'');
  chat.appendChild(line); chat.scrollTop = chat.scrollHeight;
}

const es = new EventSource('/events');
es.addEventListener('state', ev => { snapshot = JSON.parse(ev.data); draw(); });
es.addEventListener('chat',  ev => logChat(JSON.parse(ev.data)));
es.addEventListener('turn',  ev => { active = JSON.parse(ev.data).active; draw(); });

joinBtn.onclick = async ()=>{
  const name = prompt('Ton nom/pseudo ?') || undefined;
  const cls  = prompt('Ta classe ? (optionnel)') || undefined;
  const r = await fetch('/join', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name, cls }) });
  if (!r.ok) alert(await r.text());
};
startBtn.onclick = async ()=>{
  const r = await fetch(${JSON.stringify(`${MJ}/start`)}, { method:'POST' });
  if (!r.ok) alert(await r.text());
};
form.onsubmit = async (e)=>{
  e.preventDefault();
  const text = msg.value.trim(); if(!text) return;
  msg.value = '';
  const r = await fetch('/say', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text }) });
  if (!r.ok) alert(await r.text());
};
</script>
</body></html>`);
});

app.listen(CLIENT_PORT, ()=> console.log(`Client API (${PLAYER_ID}) on http://localhost:${CLIENT_PORT}`));
