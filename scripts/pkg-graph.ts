#!/usr/bin/env bun

import { mkdir, readdir } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { loadConfig } from "../flow/src/cli/config.js";
import { findFiles, parseRootArg, readFile } from "./utils.js";

const ROOT = parseRootArg(resolve(import.meta.dir, "../.."));

type PackageNode = {
  id: number;
  name: string;
  short: string;
  location: string;
  group: string;
  category: string;
  scripts: string[];
  deps: string[];
  version: string;
  description: string;
  r: number;
};

type GraphData = {
  generated: string;
  nodes: PackageNode[];
  edges: { source: number; target: number }[];
  stats: {
    total: number;
    edgeCount: number;
    byGroup: Record<string, number>;
    byCategory: Record<string, number>;
  };
};

function deriveCategory(rel: string): string {
  if (
    /\b(backend|frontend|auth|analytics|protocol-event-processor|cms|form-service)\b/.test(
      rel,
    )
  )
    return "app";
  if (/\binfrastructure\b/.test(rel)) return "infra";
  if (/\bintegrations\b/.test(rel)) return "integration";
  if (/\b(typescript-config|testing)\b/.test(rel)) return "config";
  return "lib";
}

async function buildGraph(
  packagesDir: string,
  internalScope: string,
  root: string,
): Promise<GraphData> {
  const pkgFiles = await findFiles(
    resolve(root, packagesDir),
    /^package\.json$/,
  );

  const nodes: PackageNode[] = [];
  const nameToIdx: Record<string, number> = {};

  for (const file of pkgFiles) {
    const dir = dirname(file);
    const rel = relative(resolve(root, packagesDir), dir);
    if (rel.split("/").length > 3) continue;

    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(await readFile(file));
    } catch {
      continue;
    }

    const name = (pkg.name as string) ?? basename(dir);
    const location = relative(root, dir);
    const category = deriveCategory(rel);
    const group = rel.split("/")[0] ?? rel;

    const allDeps = {
      ...((pkg.dependencies as Record<string, string>) ?? {}),
      ...((pkg.devDependencies as Record<string, string>) ?? {}),
    };
    const deps = Object.keys(allDeps).filter(
      (d) =>
        internalScope &&
        d.startsWith(internalScope) &&
        String(allDeps[d]).includes("workspace"),
    );

    const scripts = Object.keys(
      (pkg.scripts as Record<string, string>) ?? {},
    ).filter((s) =>
      [
        "dev",
        "build",
        "test",
        "start",
        "lint",
        "check-types",
        "pull-env",
      ].includes(s),
    );

    const short = name
      .replace(internalScope, "")
      .replace("@", "")
      .replace(/^guildxyz\//, "");

    nameToIdx[name] = nodes.length;
    nodes.push({
      id: nodes.length,
      name,
      short,
      location,
      group,
      category,
      scripts,
      deps,
      version: (pkg.version as string) ?? "0.0.0",
      description: (pkg.description as string) ?? "",
      r: 12,
    });
  }

  // ── Go packages (from go-packages/*/go.mod) ────────────────────────────────

  const goPackagesDir = resolve(root, "go-packages");
  try {
    const goEntries = await readdir(goPackagesDir, { withFileTypes: true });
    const goModuleScope = "github.com/guildxyz/";

    for (const entry of goEntries) {
      if (!entry.isDirectory()) continue;
      const goModPath = resolve(goPackagesDir, entry.name, "go.mod");
      let goModContent: string;
      try {
        goModContent = await readFile(goModPath);
      } catch {
        continue;
      }
      if (!goModContent) continue;

      const moduleMatch = goModContent.match(/^module\s+(\S+)/m);
      if (!moduleMatch) continue;
      const modulePath = moduleMatch[1];
      const name = `go:${entry.name}`;
      const location = relative(root, resolve(goPackagesDir, entry.name));

      // Parse internal Go deps (github.com/guildxyz/*) from require block
      const goDeps: string[] = [];
      const requireBlock = goModContent.match(/require\s*\(([\s\S]*?)\)/);
      if (requireBlock) {
        for (const line of requireBlock[1].split("\n")) {
          const depMatch = line
            .trim()
            .match(/^(github\.com\/guildxyz\/[^\s]+)/);
          if (depMatch) {
            const depModule = depMatch[1];
            const depName = depModule.replace(goModuleScope, "").split("/")[0];
            if (depName) goDeps.push(`go:${depName}`);
          }
        }
      }

      const goVersion = goModContent.match(/^go\s+(\S+)/m)?.[1] ?? "?";

      nameToIdx[name] = nodes.length;
      nodes.push({
        id: nodes.length,
        name,
        short: `go-${entry.name}`,
        location,
        group: "go-packages",
        category: "go",
        scripts: [],
        deps: [...new Set(goDeps)],
        version: goVersion,
        description: modulePath,
        r: 12,
      });
    }
  } catch {
    // go-packages/ doesn't exist — skip silently
  }

  const edges: { source: number; target: number }[] = [];
  const incomingCount = new Array(nodes.length).fill(0);
  const edgeSet = new Set<string>();

  for (const node of nodes) {
    for (const dep of node.deps) {
      const targetIdx = nameToIdx[dep];
      if (targetIdx === undefined || targetIdx === node.id) continue;
      const key = `${node.id}:${targetIdx}`;
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      edges.push({ source: node.id, target: targetIdx });
      incomingCount[targetIdx]++;
    }
  }

  for (const node of nodes) {
    node.r = Math.max(
      10,
      Math.min(38, 10 + Math.sqrt(incomingCount[node.id]) * 5.5),
    );
  }

  const byGroup: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  for (const node of nodes) {
    byGroup[node.group] = (byGroup[node.group] ?? 0) + 1;
    byCategory[node.category] = (byCategory[node.category] ?? 0) + 1;
  }

  return {
    generated: new Date().toISOString(),
    nodes,
    edges,
    stats: {
      total: nodes.length,
      edgeCount: edges.length,
      byGroup,
      byCategory,
    },
  };
}

function generateHtml(data: GraphData): string {
  const json = JSON.stringify(data);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>pkg-graph</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Instrument+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#08080a;--bg2:#111115;--bg3:#18181d;--bg4:#1f1f26;
  --border:#2a2a33;--border2:#3a3a46;
  --text:#e8e6e3;--text2:#9d9b97;--text3:#6b6966;
  --accent:#c9f06b;--accent2:#a8cc4e;
  --red:#f06b6b;--orange:#f0a86b;--yellow:#f0db6b;--blue:#6bb0f0;--purple:#a86bf0;--cyan:#6be8f0;
  --font-mono:'JetBrains Mono',monospace;--font-sans:'Instrument Sans',sans-serif;
}
html,body{height:100%;overflow:hidden;background:var(--bg);color:var(--text);font-family:var(--font-sans)}
canvas{display:block;position:absolute;top:0;left:0}
#hud{position:fixed;top:0;left:0;right:0;display:flex;align-items:center;gap:12px;padding:10px 16px;background:rgba(8,8,10,.88);backdrop-filter:blur(12px);border-bottom:1px solid var(--border);z-index:20}
#hud h1{font-family:var(--font-mono);font-size:.95rem;font-weight:700;color:var(--accent);letter-spacing:-.03em;white-space:nowrap}
#hud .sep{width:1px;height:20px;background:var(--border);flex-shrink:0}
#hud .stat{font-size:.72rem;color:var(--text3);font-family:var(--font-mono);white-space:nowrap}
#hud .stat b{color:var(--text2);font-weight:600}
#search{background:var(--bg3);border:1px solid var(--border);border-radius:4px;padding:5px 10px;color:var(--text);font-family:var(--font-mono);font-size:.78rem;outline:none;width:200px}
#search:focus{border-color:var(--accent)}
#search::placeholder{color:var(--text3)}
.hud-btn{background:var(--bg3);border:1px solid var(--border);border-radius:4px;padding:4px 10px;color:var(--text2);font-family:var(--font-mono);font-size:.72rem;cursor:pointer;white-space:nowrap;transition:all .12s}
.hud-btn:hover{border-color:var(--border2);color:var(--text)}
.hud-btn.active{border-color:var(--accent);color:var(--accent);background:rgba(201,240,107,.07)}
#hud .spacer{flex:1}
#legend{position:fixed;bottom:16px;left:16px;background:rgba(17,17,21,.92);border:1px solid var(--border);border-radius:6px;padding:10px 14px;z-index:20;font-size:.7rem;font-family:var(--font-mono);cursor:default;user-select:none}
#legend .lrow{display:flex;align-items:center;gap:8px;margin:3px 0;cursor:pointer;border-radius:3px;padding:1px 3px;transition:background .1s}
#legend .lrow:hover{background:rgba(255,255,255,.04)}
#legend .lrow.dimmed .ltxt,#legend .lrow.dimmed .lcount{opacity:.3}
#legend .ldot{width:9px;height:9px;border-radius:50%;flex-shrink:0;transition:opacity .1s}
#legend .ldot.dimmed{opacity:.25}
#legend .ltxt{color:var(--text2)}
#legend .lcount{color:var(--text3);margin-left:auto;padding-left:14px}
#detail{position:fixed;top:46px;right:0;width:360px;height:calc(100% - 46px);background:rgba(17,17,21,.97);border-left:1px solid var(--border);z-index:20;overflow-y:auto;padding:16px;transform:translateX(100%);transition:transform .2s ease;backdrop-filter:blur(8px)}
#detail.open{transform:translateX(0)}
#detail .close{position:absolute;top:12px;right:12px;background:none;border:none;color:var(--text3);cursor:pointer;font-size:1.1rem;font-family:var(--font-mono)}
#detail .close:hover{color:var(--text)}
#detail .pkg-name{font-family:var(--font-mono);font-size:.95rem;font-weight:700;margin-bottom:3px;padding-right:28px;word-break:break-all}
#detail .pkg-loc{font-size:.7rem;color:var(--text3);margin-bottom:12px;font-family:var(--font-mono)}
.detail-section{margin-bottom:14px}
.detail-section h3{font-family:var(--font-mono);font-size:.7rem;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px;display:flex;align-items:center;gap:6px}
.detail-section h3 .cnt{color:var(--text3);font-weight:400}
.d-list{list-style:none}
.d-list li{padding:2px 0;font-family:var(--font-mono);font-size:.72rem;cursor:pointer;display:flex;align-items:center;gap:6px}
.d-list li:hover{text-decoration:underline}
.d-list li .dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.script-tag{display:inline-block;background:var(--bg4);color:var(--text2);font-family:var(--font-mono);font-size:.68rem;padding:2px 7px;border-radius:3px;margin:2px 2px 2px 0}
.cat-badge{display:inline-block;font-family:var(--font-mono);font-size:.68rem;padding:2px 8px;border-radius:10px;background:var(--bg4);color:var(--text2)}
#minimap{position:fixed;bottom:16px;right:16px;width:180px;height:130px;background:rgba(17,17,21,.88);border:1px solid var(--border);border-radius:6px;z-index:20;overflow:hidden}
#minimap canvas{width:100%;height:100%}
#tooltip{position:fixed;pointer-events:none;background:rgba(17,17,21,.97);border:1px solid var(--border);border-radius:4px;padding:8px 12px;font-family:var(--font-mono);font-size:.72rem;color:var(--text);z-index:30;display:none;max-width:280px;backdrop-filter:blur(8px)}
#tooltip .tt-name{font-weight:700;margin-bottom:3px}
#tooltip .tt-loc{font-size:.65rem;margin-bottom:2px}
#tooltip .tt-stat{color:var(--text3);font-size:.65rem}
</style>
</head>
<body>
<canvas id="canvas"></canvas>
<div id="hud">
  <h1>pkg-graph</h1>
  <div class="sep"></div>
  <span class="stat" id="statNodes"></span>
  <span class="stat" id="statEdges"></span>
  <div class="sep"></div>
  <input id="search" placeholder="Search packages..." type="text">
  <div class="sep"></div>
  <button class="hud-btn active" id="btnEdges">Edges</button>
  <button class="hud-btn active" id="btnLabels">Labels</button>
  <button class="hud-btn active" id="btnPhysics">Physics</button>
  <button class="hud-btn" id="btnReset">Reset</button>
  <div class="spacer"></div>
  <span class="stat" id="statZoom"></span>
</div>
<div id="legend"></div>
<div id="detail"><button class="close">&times;</button></div>
<div id="minimap"><canvas id="minicanvas"></canvas></div>
<div id="tooltip"></div>

<script id="__GRAPH_DATA__" type="application/json">${json}</script>
<script>
const D = JSON.parse(document.getElementById("__GRAPH_DATA__").textContent);
const nodes = D.nodes;
const edges = D.edges;
const nameToIdx = {};
nodes.forEach((n,i) => { nameToIdx[n.name] = i; });

const DIR_COLORS = [
  "#c9f06b","#6bb0f0","#f0a86b","#a86bf0","#6be8f0","#f06b9d",
  "#f0db6b","#6bf09d","#b06bf0","#f06b6b","#6b8ef0","#d4f06b",
  "#f0886b","#6bf0d4","#c06bf0","#8af06b",
];

const groups = [...new Set(nodes.map(n => n.group))].sort();
const groupColorMap = {};
groups.forEach((g,i) => { groupColorMap[g] = DIR_COLORS[i % DIR_COLORS.length]; });

function nodeColor(n) { return groupColorMap[n.group] || "#9d9b97"; }

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const miniCanvas = document.getElementById("minicanvas");
const miniCtx = miniCanvas.getContext("2d");

let W, H;
function resize() {
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = W*devicePixelRatio; canvas.height = H*devicePixelRatio;
  canvas.style.width = W+"px"; canvas.style.height = H+"px";
  ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);
  miniCanvas.width = 180*devicePixelRatio; miniCanvas.height = 130*devicePixelRatio;
  miniCtx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);
}
window.addEventListener("resize", resize);
resize();

const spread = Math.max(320, nodes.length * 22);
const phys = nodes.map((n,i) => {
  const angle = (i / nodes.length) * Math.PI * 2;
  return {
    x: Math.cos(angle) * spread * 0.42 + (Math.random()-0.5)*60,
    y: Math.sin(angle) * spread * 0.42 + (Math.random()-0.5)*60,
    vx: 0, vy: 0, pinned: false,
  };
});

const incomingCount = new Array(nodes.length).fill(0);
for (const e of edges) incomingCount[e.target]++;

let camX=0, camY=0, camZoom=0.85;
let showEdges=true, showLabels=true, physicsRunning=true;
let selectedNode=null, hoveredNode=null, searchTerm="";
let dragNode=null, isPanning=false, panStart={x:0,y:0};
let hiddenGroups = new Set();

function screenToWorld(sx,sy){return{x:(sx-W/2)/camZoom+camX,y:(sy-H/2)/camZoom+camY};}
function worldToScreen(wx,wy){return{x:(wx-camX)*camZoom+W/2,y:(wy-camY)*camZoom+H/2};}

function simulate() {
  if (!physicsRunning) return;
  const alpha=0.35, repulsion=9500, attraction=0.012, damping=0.87, centerPull=0.0006;
  for (let i=0;i<nodes.length;i++) {
    if(phys[i].pinned) continue;
    phys[i].vx *= damping; phys[i].vy *= damping;
    phys[i].vx -= phys[i].x * centerPull;
    phys[i].vy -= phys[i].y * centerPull;
  }
  for (let i=0;i<nodes.length;i++) {
    if(phys[i].pinned) continue;
    for (let j=i+1;j<nodes.length;j++) {
      let dx=phys[i].x-phys[j].x, dy=phys[i].y-phys[j].y;
      let d2=dx*dx+dy*dy; if(d2<1) d2=1;
      const d=Math.sqrt(d2);
      const rsum=nodes[i].r+nodes[j].r+18;
      const f=repulsion/d2 + (d<rsum?(rsum-d)*0.7:0);
      const fx=(dx/d)*f, fy=(dy/d)*f;
      phys[i].vx+=fx; phys[i].vy+=fy;
      if(!phys[j].pinned){phys[j].vx-=fx;phys[j].vy-=fy;}
    }
  }
  for (const e of edges) {
    const s=phys[e.source],t=phys[e.target];
    const dx=t.x-s.x, dy=t.y-s.y;
    const d=Math.sqrt(dx*dx+dy*dy)||1;
    const ideal=nodes[e.source].r+nodes[e.target].r+110;
    const f=(d-ideal)*attraction;
    const fx=(dx/d)*f, fy=(dy/d)*f;
    if(!s.pinned){s.vx+=fx;s.vy+=fy;}
    if(!t.pinned){t.vx-=fx;t.vy-=fy;}
    if (nodes[e.source].group===nodes[e.target].group) {
      const cf=f*0.5;
      if(!s.pinned){s.vx+=(dx/d)*cf;s.vy+=(dy/d)*cf;}
      if(!t.pinned){t.vx-=(dx/d)*cf;t.vy-=(dy/d)*cf;}
    }
  }
  for (let i=0;i<nodes.length;i++) {
    if(phys[i].pinned) continue;
    phys[i].x+=phys[i].vx*alpha;
    phys[i].y+=phys[i].vy*alpha;
  }
}

function isVisible(i) {
  const n=nodes[i];
  if (hiddenGroups.has(n.group)) return false;
  if (searchTerm && !n.name.toLowerCase().includes(searchTerm) && !n.short.toLowerCase().includes(searchTerm)) return false;
  return true;
}

function draw() {
  ctx.clearRect(0,0,W,H);
  ctx.save();
  ctx.translate(W/2,H/2);
  ctx.scale(camZoom,camZoom);
  ctx.translate(-camX,-camY);

  if (showEdges || selectedNode!==null) {
    for (const e of edges) {
      if (!isVisible(e.source)&&!isVisible(e.target)) continue;
      const isHi=selectedNode!==null&&(e.source===selectedNode||e.target===selectedNode);
      if (!showEdges&&!isHi) continue;
      ctx.globalAlpha=isHi?0.9:(selectedNode!==null?0.06:0.4);
      ctx.strokeStyle=isHi?(e.source===selectedNode?"#6bb0f0":"#f0a86b"):"#444450";
      ctx.lineWidth=isHi?2/camZoom:1/camZoom;
      const sx=phys[e.source].x,sy=phys[e.source].y;
      const tx=phys[e.target].x,ty=phys[e.target].y;
      ctx.beginPath(); ctx.moveTo(sx,sy); ctx.lineTo(tx,ty); ctx.stroke();
      if (isHi||camZoom>1.0) {
        const dx=tx-sx,dy=ty-sy,d=Math.sqrt(dx*dx+dy*dy)||1;
        const nr=nodes[e.target].r;
        const ax=tx-(dx/d)*(nr+3),ay=ty-(dy/d)*(nr+3);
        const al=Math.min(10/camZoom,d*0.2);
        const ang=Math.atan2(dy,dx);
        ctx.beginPath();
        ctx.moveTo(ax,ay);
        ctx.lineTo(ax-al*Math.cos(ang-0.4),ay-al*Math.sin(ang-0.4));
        ctx.moveTo(ax,ay);
        ctx.lineTo(ax-al*Math.cos(ang+0.4),ay-al*Math.sin(ang+0.4));
        ctx.stroke();
      }
    }
  }

  ctx.globalAlpha=1;
  for (let i=0;i<nodes.length;i++) {
    if (!isVisible(i)) continue;
    const n=nodes[i]; const p=phys[i];
    const col=nodeColor(n);
    const isSel=i===selectedNode, isHov=i===hoveredNode;
    const dimmed=selectedNode!==null&&!isSel&&
      !edges.some(e=>(e.source===selectedNode&&e.target===i)||(e.target===selectedNode&&e.source===i));

    ctx.globalAlpha=dimmed?0.12:1;

    if (incomingCount[i]>0&&!dimmed) {
      ctx.beginPath();
      ctx.arc(p.x,p.y,n.r+5,0,Math.PI*2);
      ctx.fillStyle=col+"18";
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(p.x,p.y,n.r,0,Math.PI*2);
    ctx.fillStyle=col;
    ctx.globalAlpha=dimmed?0.08:(isSel||isHov?0.92:0.65);
    ctx.fill();

    if (isSel||isHov) {
      ctx.strokeStyle=isSel?"#fff":col;
      ctx.lineWidth=(isSel?2.5:1.5)/camZoom;
      ctx.globalAlpha=1;
      ctx.stroke();
    }

    ctx.globalAlpha=dimmed?0.12:1;
    if (showLabels||(isSel||isHov||camZoom>1.5)) {
      const fs=Math.max(8,Math.min(13,11/camZoom));
      ctx.font=\`600 \${fs}px 'JetBrains Mono'\`;
      ctx.textAlign="center";
      ctx.textBaseline="top";
      ctx.fillStyle=isSel?"#c9f06b":col;
      ctx.globalAlpha=dimmed?0.12:(isSel||isHov?1:(showLabels?0.82:0.7));
      ctx.fillText(n.short,p.x,p.y+n.r+4);
    }
  }

  ctx.restore();
  ctx.globalAlpha=1;
}

function drawMinimap() {
  miniCtx.clearRect(0,0,180,130);
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for (const p of phys) {
    if(p.x<minX)minX=p.x; if(p.y<minY)minY=p.y;
    if(p.x>maxX)maxX=p.x; if(p.y>maxY)maxY=p.y;
  }
  const pad=20; minX-=pad;minY-=pad;maxX+=pad;maxY+=pad;
  const gw=maxX-minX||1,gh=maxY-minY||1;
  const sc=Math.min(180/gw,130/gh);
  const ox=(180-gw*sc)/2,oy=(130-gh*sc)/2;
  miniCtx.strokeStyle="rgba(58,58,70,0.35)"; miniCtx.lineWidth=0.5;
  for (const e of edges) {
    const s=phys[e.source],t=phys[e.target];
    miniCtx.beginPath();
    miniCtx.moveTo(ox+(s.x-minX)*sc,oy+(s.y-minY)*sc);
    miniCtx.lineTo(ox+(t.x-minX)*sc,oy+(t.y-minY)*sc);
    miniCtx.stroke();
  }
  for (let i=0;i<nodes.length;i++) {
    if(!isVisible(i)) continue;
    const n=nodes[i];const p=phys[i];
    miniCtx.beginPath();
    miniCtx.arc(ox+(p.x-minX)*sc,oy+(p.y-minY)*sc,Math.max(2,n.r*sc*0.5),0,Math.PI*2);
    miniCtx.fillStyle=nodeColor(n);
    miniCtx.globalAlpha=0.75; miniCtx.fill();
  }
  miniCtx.globalAlpha=1;
  const vpL=camX-W/(2*camZoom),vpT=camY-H/(2*camZoom);
  miniCtx.strokeStyle="rgba(201,240,107,0.5)"; miniCtx.lineWidth=1;
  miniCtx.strokeRect(ox+(vpL-minX)*sc,oy+(vpT-minY)*sc,(W/camZoom)*sc,(H/camZoom)*sc);
}

function findNodeAt(sx,sy) {
  const w=screenToWorld(sx,sy);
  let best=null,bestD=Infinity;
  for (let i=0;i<nodes.length;i++) {
    if(!isVisible(i)) continue;
    const p=phys[i];
    const dx=w.x-p.x,dy=w.y-p.y,d=Math.sqrt(dx*dx+dy*dy);
    if(d<nodes[i].r+6&&d<bestD){best=i;bestD=d;}
  }
  return best;
}

function showTooltip(i,sx,sy) {
  const n=nodes[i],col=nodeColor(n);
  const tt=document.getElementById("tooltip");
  tt.style.display="block";
  tt.style.left=(sx+14)+"px"; tt.style.top=(sy-12)+"px";
  const inc=incomingCount[i];
  tt.innerHTML=\`<div class="tt-name" style="color:\${col}">\${n.short}</div><div class="tt-loc" style="color:\${col}88">\${n.group} · \${n.category}</div><div class="tt-stat">\${n.location}<br>\${inc} dependent\${inc!==1?"s":""} · \${n.deps.length} dep\${n.deps.length!==1?"s":""}</div>\`;
}
function hideTooltip(){document.getElementById("tooltip").style.display="none";}

function openDetail(idx) {
  selectedNode=idx;
  const n=nodes[idx], col=nodeColor(n);
  const det=document.getElementById("detail");
  det.classList.add("open");
  const importers=[];
  for(let i=0;i<nodes.length;i++){if(nodes[i].deps.includes(n.name)) importers.push(i);}

  let html=\`<button class="close">&times;</button>\`;
  html+=\`<div class="pkg-name" style="color:\${col}">\${n.name}</div>\`;
  html+=\`<div class="pkg-loc">\${n.location}\${n.version?" · v"+n.version:""}</div>\`;
  if(n.description) html+=\`<div style="font-size:.75rem;color:var(--text2);margin-bottom:12px">\${n.description}</div>\`;

  html+=\`<div class="detail-section"><h3>Group &amp; Category</h3>
    <div style="display:flex;align-items:center;gap:10px">
      <div style="display:flex;align-items:center;gap:5px"><div style="width:8px;height:8px;border-radius:50%;background:\${col}"></div><span style="font-family:var(--font-mono);font-size:.78rem;color:\${col}">\${n.group}</span></div>
      <span class="cat-badge">\${n.category}</span>
    </div></div>\`;

  if(n.scripts.length){
    html+=\`<div class="detail-section"><h3>Scripts</h3>\`;
    for(const s of n.scripts) html+=\`<span class="script-tag">\${s}</span>\`;
    html+=\`</div>\`;
  }

  if(n.deps.length){
    html+=\`<div class="detail-section"><h3>Depends On <span class="cnt">\${n.deps.length}</span></h3><ul class="d-list">\`;
    for(const dep of n.deps){
      const di=nameToIdx[dep];
      const dn=di!==undefined?nodes[di]:null;
      const dc=dn?nodeColor(dn):"var(--text3)";
      html+=\`<li data-idx="\${di!==undefined?di:""}" style="color:\${dc}"><div class="dot" style="background:\${dc}"></div>\${dep.replace("@guildxyz/","")}</li>\`;
    }
    html+=\`</ul></div>\`;
  }

  if(importers.length){
    html+=\`<div class="detail-section"><h3>Used By <span class="cnt">\${importers.length}</span></h3><ul class="d-list">\`;
    for(const ii of importers){
      const im=nodes[ii],ic=nodeColor(im);
      html+=\`<li data-idx="\${ii}" style="color:\${ic}"><div class="dot" style="background:\${ic}"></div>\${im.name.replace("@guildxyz/","")}</li>\`;
    }
    html+=\`</ul></div>\`;
  }

  det.innerHTML=html;
  det.querySelector(".close").addEventListener("click",()=>{det.classList.remove("open");selectedNode=null;});
  det.querySelectorAll(".d-list li[data-idx]").forEach(li=>{
    const idx2=parseInt(li.dataset.idx);
    if(isNaN(idx2)) return;
    li.addEventListener("click",()=>{openDetail(idx2);camX=phys[idx2].x;camY=phys[idx2].y;});
  });
}

canvas.addEventListener("mousedown",e=>{
  const n=findNodeAt(e.clientX,e.clientY);
  if(n!==null){dragNode=n;phys[n].pinned=true;return;}
  isPanning=true; panStart={x:e.clientX,y:e.clientY};
});
canvas.addEventListener("mousemove",e=>{
  if(dragNode!==null){const w=screenToWorld(e.clientX,e.clientY);phys[dragNode].x=w.x;phys[dragNode].y=w.y;return;}
  if(isPanning){camX-=(e.clientX-panStart.x)/camZoom;camY-=(e.clientY-panStart.y)/camZoom;panStart={x:e.clientX,y:e.clientY};return;}
  const n=findNodeAt(e.clientX,e.clientY);
  if(n!==null){hoveredNode=n;canvas.style.cursor="pointer";showTooltip(n,e.clientX,e.clientY);}
  else{hoveredNode=null;canvas.style.cursor="grab";hideTooltip();}
});
canvas.addEventListener("mouseup",e=>{
  if(dragNode!==null){
    if(!e.shiftKey) phys[dragNode].pinned=false;
    openDetail(dragNode); dragNode=null; return;
  }
  isPanning=false;
});
canvas.addEventListener("wheel",e=>{
  e.preventDefault();
  const z=1.09,old=camZoom;
  camZoom*=e.deltaY<0?z:1/z;
  camZoom=Math.max(0.04,Math.min(12,camZoom));
  const w=screenToWorld(e.clientX,e.clientY);
  camX+=(w.x-camX)*(1-old/camZoom); camY+=(w.y-camY)*(1-old/camZoom);
},{passive:false});
canvas.addEventListener("dblclick",e=>{
  const n=findNodeAt(e.clientX,e.clientY);
  if(n!==null) phys[n].pinned=!phys[n].pinned;
});

document.getElementById("search").addEventListener("input",e=>{searchTerm=e.target.value.toLowerCase();});
document.getElementById("btnEdges").addEventListener("click",function(){showEdges=!showEdges;this.classList.toggle("active",showEdges);});
document.getElementById("btnLabels").addEventListener("click",function(){showLabels=!showLabels;this.classList.toggle("active",showLabels);});
document.getElementById("btnPhysics").addEventListener("click",function(){physicsRunning=!physicsRunning;this.classList.toggle("active",physicsRunning);});
document.getElementById("btnReset").addEventListener("click",()=>{
  camX=0;camY=0;camZoom=0.85;selectedNode=null;
  document.getElementById("detail").classList.remove("open");
  for(const p of phys) p.pinned=false;
});
document.addEventListener("keydown",e=>{
  if(e.key==="Escape"){selectedNode=null;document.getElementById("detail").classList.remove("open");hideTooltip();}
  if(e.key==="l"&&document.activeElement!==document.getElementById("search")){
    showLabels=!showLabels;
    document.getElementById("btnLabels").classList.toggle("active",showLabels);
  }
});

document.getElementById("statNodes").innerHTML=\`<b>\${D.stats.total}</b> packages\`;
document.getElementById("statEdges").innerHTML=\`<b>\${D.stats.edgeCount}</b> deps\`;

const legendEl=document.getElementById("legend");
let lHtml="";
for (const g of groups) {
  const col=groupColorMap[g];
  const cnt=D.stats.byGroup[g]||0;
  lHtml+=\`<div class="lrow" data-group="\${g}"><div class="ldot" style="background:\${col}"></div><span class="ltxt">\${g}</span><span class="lcount">\${cnt}</span></div>\`;
}
legendEl.innerHTML=lHtml;
legendEl.querySelectorAll(".lrow").forEach(row=>{
  row.addEventListener("click",()=>{
    const g=row.dataset.group;
    if(hiddenGroups.has(g)){hiddenGroups.delete(g);row.classList.remove("dimmed");}
    else{hiddenGroups.add(g);row.classList.add("dimmed");}
  });
});

let frame=0;
function loop(){
  simulate();draw();frame++;
  if(frame%8===0){drawMinimap();document.getElementById("statZoom").innerHTML=\`<b>\${camZoom.toFixed(2)}</b>x\`;}
  requestAnimationFrame(loop);
}
loop();
</script>
</body>
</html>`;
}

export interface PkgGraphOptions {
  root: string;
  outPath?: string;
}

export async function runPkgGraph(opts: PkgGraphOptions): Promise<void> {
  const cfg = await loadConfig(opts.root);
  const data = await buildGraph(
    cfg.workspace.packagesDir ?? "packages",
    cfg.workspace.internalScope ?? "@guildxyz/",
    opts.root,
  );

  const outPath = opts.outPath ?? resolve(opts.root, "audit/pkg-graph.html");
  await mkdir(dirname(outPath), { recursive: true });
  await Bun.write(outPath, generateHtml(data));

  const groupList = Object.keys(data.stats.byGroup);
  console.log(`${data.stats.total} packages · ${data.stats.edgeCount} edges · ${groupList.length} groups`);
  console.log(`→ ${relative(opts.root, outPath)}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: bun pkg-graph.ts [--out <path>]");
    process.exit(0);
  }

  const outArg = args.indexOf("--out");
  const outPath =
    outArg !== -1
      ? resolve(process.cwd(), args[outArg + 1])
      : undefined;

  await runPkgGraph({ root: ROOT, outPath });
}

// Only auto-run when executed directly (not when imported by audit.ts)
const isDirectRun = process.argv[1] === import.meta.filename ||
  process.argv[1]?.endsWith("/pkg-graph.ts") ||
  process.argv[1]?.endsWith("/pkg-graph.js");
if (isDirectRun) main();
