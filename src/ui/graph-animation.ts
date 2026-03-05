#!/usr/bin/env bun
/**
 * 3D ASCII graph animation — visualizes the supergraph building up.
 * Nodes appear, edges connect, the graph rotates in 3D space.
 */

const CHARS = " .·:+*#@";
const EDGE_CHAR = "·";
const NODE_CHARS = ["◉", "●", "○", "◆", "◇", "▪"];
const COLORS = [
  "\x1b[32m",  // green
  "\x1b[36m",  // cyan
  "\x1b[35m",  // magenta
  "\x1b[33m",  // yellow
  "\x1b[34m",  // blue
  "\x1b[31m",  // red
];
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const ACCENT = "\x1b[38;2;201;240;107m"; // #c9f06b
const GREY = "\x1b[38;5;240m";

type Node3D = {
  x: number; y: number; z: number;
  label: string;
  pkg: number;
  active: boolean;
  spawnT: number;
};

type Edge3D = {
  from: number; to: number;
  spawnT: number;
};

const PKG_NAMES = [
  "core", "graph", "flow", "fortress", "agent",
  "cli", "events", "schema", "utils", "bridge",
];

const MODULE_NAMES = [
  "index", "types", "store", "actors", "events",
  "schema", "nodes", "edges", "config", "utils",
  "router", "ctrl", "model", "hooks", "guard",
  "bridge", "adapter", "mapper", "queue", "cache",
  "parser", "render", "state", "effect", "query",
];

function createGraph(nodeCount: number): { nodes: Node3D[]; edges: Edge3D[] } {
  const nodes: Node3D[] = [];
  const edges: Edge3D[] = [];

  for (let i = 0; i < nodeCount; i++) {
    const pkg = Math.floor(Math.random() * PKG_NAMES.length);
    const angle = (pkg / PKG_NAMES.length) * Math.PI * 2;
    const radius = 1.2 + Math.random() * 0.8;
    const mod = MODULE_NAMES[Math.floor(Math.random() * MODULE_NAMES.length)]!;

    nodes.push({
      x: Math.cos(angle) * radius + (Math.random() - 0.5) * 0.6,
      y: (Math.random() - 0.5) * 2,
      z: Math.sin(angle) * radius + (Math.random() - 0.5) * 0.6,
      label: `${PKG_NAMES[pkg]}/${mod}`,
      pkg,
      active: false,
      spawnT: i * 0.12 + Math.random() * 0.08,
    });
  }

  // Intra-package edges
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (nodes[i]!.pkg === nodes[j]!.pkg && Math.random() < 0.4) {
        edges.push({ from: i, to: j, spawnT: Math.max(nodes[i]!.spawnT, nodes[j]!.spawnT) + 0.1 });
      }
    }
  }

  // Cross-package edges
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (nodes[i]!.pkg !== nodes[j]!.pkg && Math.random() < 0.08) {
        edges.push({ from: i, to: j, spawnT: Math.max(nodes[i]!.spawnT, nodes[j]!.spawnT) + 0.3 });
      }
    }
  }

  return { nodes, edges };
}

function project(x: number, y: number, z: number, rotY: number, rotX: number, W: number, H: number) {
  // Rotate around Y
  const cosY = Math.cos(rotY), sinY = Math.sin(rotY);
  let rx = x * cosY - z * sinY;
  let rz = x * sinY + z * cosY;

  // Rotate around X
  const cosX = Math.cos(rotX), sinX = Math.sin(rotX);
  let ry = y * cosX - rz * sinX;
  rz = y * sinX + rz * cosX;

  // Perspective
  const d = 5;
  const scale = d / (d + rz);
  const sx = Math.round(W / 2 + rx * scale * W * 0.25);
  const sy = Math.round(H / 2 - ry * scale * H * 0.35);

  return { sx, sy, depth: rz, scale };
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

function renderFrame(
  nodes: Node3D[],
  edges: Edge3D[],
  t: number,
  W: number,
  H: number,
  rotY: number,
  rotX: number,
  statusLine: string,
): string {
  // Buffer: [char, color]
  const buf: [string, string][] = new Array(W * H).fill(null).map(() => [" ", ""]);

  const set = (x: number, y: number, ch: string, color: string, depth: number) => {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const idx = y * W + x;
    buf[idx] = [ch, color];
  };

  // Draw edges
  for (const e of edges) {
    const age = t - e.spawnT;
    if (age < 0) continue;
    const alpha = Math.min(1, age / 0.5);

    const a = nodes[e.from]!;
    const b = nodes[e.to]!;
    const pa = project(a.x, a.y, a.z, rotY, rotX, W, H);
    const pb = project(b.x, b.y, b.z, rotY, rotX, W, H);

    const cross = a.pkg !== b.pkg;
    const color = cross ? ACCENT : GREY;
    const ch = cross ? "·" : "·";

    // Bresenham-ish line
    const steps = Math.max(Math.abs(pb.sx - pa.sx), Math.abs(pb.sy - pa.sy));
    const drawSteps = Math.round(steps * alpha);
    for (let s = 0; s <= drawSteps; s++) {
      const frac = steps === 0 ? 0 : s / steps;
      const px = Math.round(lerp(pa.sx, pb.sx, frac));
      const py = Math.round(lerp(pa.sy, pb.sy, frac));
      const depth = lerp(pa.depth, pb.depth, frac);
      set(px, py, ch, color, depth);
    }
  }

  // Draw nodes (sorted by depth, back to front)
  const projected = nodes.map((n, i) => {
    const age = t - n.spawnT;
    const p = project(n.x, n.y, n.z, rotY, rotX, W, H);
    return { ...p, node: n, idx: i, age };
  }).filter(p => p.age > 0).sort((a, b) => b.depth - a.depth);

  for (const p of projected) {
    const age = p.age;
    const pulse = 0.8 + 0.2 * Math.sin(t * 3 + p.idx);
    const color = COLORS[p.node.pkg % COLORS.length]!;
    const ch = age < 0.3 ? "+" : (pulse > 0.9 ? "◉" : "●");
    set(p.sx, p.sy, ch, color, p.depth);

    // Label (only for nearby/large nodes)
    if (p.scale > 0.7 && age > 0.5) {
      const label = p.node.label.slice(0, 12);
      for (let c = 0; c < label.length; c++) {
        set(p.sx + 2 + c, p.sy, label[c]!, DIM + color, p.depth);
      }
    }
  }

  // Build output
  const lines: string[] = [];
  for (let y = 0; y < H; y++) {
    let line = "";
    for (let x = 0; x < W; x++) {
      const [ch, color] = buf[y * W + x]!;
      if (ch !== " ") {
        line += color + ch + RESET;
      } else {
        line += " ";
      }
    }
    lines.push(line);
  }

  // Status bar at bottom
  const activeNodes = nodes.filter(n => t >= n.spawnT).length;
  const activeEdges = edges.filter(e => t >= e.spawnT).length;
  const statsLine = `${GREY}${activeNodes}m · ${activeEdges}e${RESET}`;

  lines.push("");
  lines.push(`  ${ACCENT}supergraph${RESET}  ${statsLine}  ${DIM}${statusLine}${RESET}`);

  return lines.join("\n");
}

export type AnimationHandle = {
  update: (status: string) => void;
  stop: () => void;
};

export function startAnimation(): AnimationHandle {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const W = Math.min(cols, 120);
  const H = Math.min(rows - 4, 30);

  const { nodes, edges } = createGraph(35);

  let t = 0;
  let statusLine = "initializing...";
  const dt = 0.06;
  const rotSpeed = 0.012;

  // Hide cursor
  process.stdout.write("\x1b[?25l");
  // Clear screen
  process.stdout.write("\x1b[2J");

  const interval = setInterval(() => {
    t += dt;
    const rotY = t * rotSpeed;
    const rotX = 0.3 + Math.sin(t * 0.02) * 0.1;

    const frame = renderFrame(nodes, edges, t, W, H, rotY, rotX, statusLine);

    // Move cursor to top-left and draw
    process.stdout.write(`\x1b[H${frame}`);
  }, 50);

  return {
    update(status: string) {
      statusLine = status;
    },
    stop() {
      clearInterval(interval);
      // Show cursor
      process.stdout.write("\x1b[?25h");
      // Clear screen
      process.stdout.write("\x1b[2J\x1b[H");
    },
  };
}

// Run standalone for testing
if (import.meta.main) {
  const anim = startAnimation();

  const phases = [
    [1.0, "scanning packages..."],
    [2.5, "building module graph..."],
    [4.0, "analyzing exports..."],
    [5.5, "tracing dependencies..."],
    [7.0, "detecting cross-package edges..."],
    [8.5, "compressing symbols..."],
    [10.0, "writing superhigh.txt..."],
    [11.0, "generating visualization..."],
    [12.0, "done."],
  ] as const;

  let phase = 0;
  const t0 = Date.now();

  const check = setInterval(() => {
    const elapsed = (Date.now() - t0) / 1000;
    while (phase < phases.length && elapsed >= phases[phase]![0]) {
      anim.update(phases[phase]![1]);
      phase++;
    }
    if (phase >= phases.length) {
      clearInterval(check);
      setTimeout(() => {
        anim.stop();
        console.log(`\x1b[38;2;201;240;107m✓\x1b[0m  supergraph complete`);
      }, 1500);
    }
  }, 100);
}
