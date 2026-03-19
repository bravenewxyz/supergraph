#!/usr/bin/env bun
/**
 * 3D ASCII graph animation — visualizes the supergraph building up.
 * Built on top of the 3D ASCII render engine.
 *
 * Run standalone:  bun src/ui/graph-animation.ts
 */

import {
  type Vec3, type Camera, type Projected,
  v3, rgb, DIM, RESET, BOLD,
  Framebuffer, Projector, ParticleSystem,
  createCamera, drawLine, drawGlow, drawSphere, drawText,
  runScene,
} from "./engine.js";

// ── Colors ──────────────────────────────────────────────────────────────────

const ACCENT = rgb(201, 240, 107);  // #c9f06b
const GREY = rgb(80, 80, 80);
const DARK = rgb(50, 50, 50);

const PKG_COLORS = [
  rgb(80, 220, 100),   // green
  rgb(80, 200, 220),   // cyan
  rgb(200, 100, 220),  // magenta
  rgb(220, 200, 80),   // yellow
  rgb(80, 130, 220),   // blue
  rgb(220, 100, 80),   // red
  rgb(150, 220, 80),   // lime
  rgb(220, 150, 80),   // orange
  rgb(100, 180, 200),  // teal
  rgb(200, 120, 180),  // pink
];

// ── Graph data ──────────────────────────────────────────────────────────────

type GraphNode = {
  pos: Vec3;
  targetPos: Vec3;   // for spring animation
  vel: Vec3;
  label: string;
  pkg: number;
  spawnT: number;
  glowT: number;     // last glow trigger time
  ready: boolean;
};

type GraphEdge = {
  from: number;
  to: number;
  spawnT: number;
  cross: boolean;    // cross-package edge
};

const DEFAULT_PKG_NAMES = [
  "core", "graph", "flow", "fortress", "agent",
  "cli", "events", "schema", "utils", "bridge",
];


function createGraph(packageNames?: string[], realEdges?: [number, number][]) {
  const PKG_NAMES = packageNames && packageNames.length > 0 ? packageNames : DEFAULT_PKG_NAMES;

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // One node per package
  for (let i = 0; i < PKG_NAMES.length; i++) {
    const angle = (i / PKG_NAMES.length) * Math.PI * 2;
    const r = 2.0 + (Math.random() - 0.5) * 0.4;

    const targetPos = v3.create(
      Math.cos(angle) * r,
      (Math.random() - 0.5) * 2.0,
      Math.sin(angle) * r,
    );

    nodes.push({
      pos: v3.create(
        (Math.random() - 0.5) * 0.3,
        (Math.random() - 0.5) * 0.3,
        (Math.random() - 0.5) * 0.3,
      ),
      targetPos,
      vel: v3.create(0, 0, 0),
      label: PKG_NAMES[i]!,
      pkg: i,
      spawnT: Number.POSITIVE_INFINITY,
      glowT: -10,
      ready: false,
    });
  }

  if (realEdges && realEdges.length > 0) {
    // Use real dependency edges
    for (const [from, to] of realEdges) {
      if (from < nodes.length && to < nodes.length) {
        edges.push({
          from, to,
          spawnT: Number.POSITIVE_INFINITY,
          cross: true,
        });
      }
    }
  } else {
    // Fallback: ring + random edges
    for (let i = 0; i < nodes.length; i++) {
      const next = (i + 1) % nodes.length;
      edges.push({
        from: i, to: next,
        spawnT: Number.POSITIVE_INFINITY,
        cross: true,
      });
      for (let j = i + 2; j < nodes.length; j++) {
        if (Math.random() < 0.15) {
          edges.push({
            from: i, to: j,
            spawnT: Number.POSITIVE_INFINITY,
            cross: true,
          });
        }
      }
    }
  }

  return { nodes, edges };
}

// ── Physics ─────────────────────────────────────────────────────────────────

function updatePhysics(nodes: GraphNode[], dt: number, t: number) {
  const springK = 3.0;
  const damping = 0.88;

  for (const n of nodes) {
    if (t < n.spawnT) continue;
    const age = t - n.spawnT;
    if (age < 0) continue;

    // Spring force toward target
    const dx = n.targetPos.x - n.pos.x;
    const dy = n.targetPos.y - n.pos.y;
    const dz = n.targetPos.z - n.pos.z;

    n.vel.x += dx * springK * dt;
    n.vel.y += dy * springK * dt;
    n.vel.z += dz * springK * dt;

    // Damping
    n.vel.x *= damping;
    n.vel.y *= damping;
    n.vel.z *= damping;

    // Integrate
    n.pos.x += n.vel.x * dt;
    n.pos.y += n.vel.y * dt;
    n.pos.z += n.vel.z * dt;
  }
}

// ── Render ───────────────────────────────────────────────────────────────────

function renderGraph(
  fb: Framebuffer,
  proj: Projector,
  nodes: GraphNode[],
  edges: GraphEdge[],
  particles: ParticleSystem,
  t: number,
) {
  // Project all visible nodes
  const projected: (Projected & { node: GraphNode; idx: number; sphereRadius: number })[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    if (t < n.spawnT) continue;
    const p = proj.project(n.pos);
    if (p.visible) {
      const sphereRadius = Math.max(1.15, Math.min(3.2, 0.9 + p.scale * 18));
      projected.push({ ...p, node: n, idx: i, sphereRadius });
    }
  }

  // Sort back-to-front for correct overlap
  projected.sort((a, b) => b.depth - a.depth);

  // ── Draw edges ──
  for (const e of edges) {
    const age = t - e.spawnT;
    if (age < 0) continue;
    const progress = Math.min(1, age / 0.6);

    const a = nodes[e.from]!;
    const b = nodes[e.to]!;
    if (t < a.spawnT || t < b.spawnT) continue;

    const pa = proj.project(a.pos);
    const pb = proj.project(b.pos);

    if (e.cross) {
      const midDepth = (pa.depth + pb.depth) * 0.5;
      drawGlow(
        fb,
        (pa.sx + pb.sx) * 0.5,
        (pa.sy + pb.sy) * 0.5,
        1.4 + progress * 0.8,
        0.06 + progress * 0.08,
        ACCENT,
        midDepth + 0.2,
      );

      // Cross-package: accent colored, dashed
      drawLine(fb, pa, pb, {
        fg: ACCENT,
        dashGap: 2,
        width: 1.1,
        intensity: 0.42,
      }, progress);
    } else {
      // Intra-package: dim grey, softer solid line
      drawLine(fb, pa, pb, {
        fg: DARK,
        width: 0.75,
        intensity: 0.18,
      }, progress);
    }
  }

  // ── Draw node glows ──
  for (const p of projected) {
    const age = t - p.node.spawnT;
    const glowAge = t - p.node.glowT;
    const color = PKG_COLORS[p.node.pkg % PKG_COLORS.length]!;

    // Spawn burst glow
    if (age < 0.8) {
      const burstIntensity = (1 - age / 0.8) * 0.7;
      drawGlow(fb, p.sx, p.sy, 3 + burstIntensity * 3, burstIntensity, color, p.depth + 0.12);
    }

    // Ambient glow for all nodes
    const ambientPulse = 0.15 + 0.08 * Math.sin(t * 2.5 + p.idx * 1.7);
    drawGlow(fb, p.sx, p.sy, 2.5, ambientPulse, color, p.depth + 0.16);

    // Triggered glow (from status updates)
    if (glowAge < 1.0 && glowAge >= 0) {
      const trigIntensity = (1 - glowAge) * 0.9;
      drawGlow(fb, p.sx, p.sy, 4.8, trigIntensity, ACCENT, p.depth + 0.08);
    }
  }

  // ── Draw nodes ──
  for (const p of projected) {
    const age = t - p.node.spawnT;
    const color = PKG_COLORS[p.node.pkg % PKG_COLORS.length]!;
    const pulse = 0.8 + 0.2 * Math.sin(t * 3 + p.idx);
    drawSphere(fb, p, p.sphereRadius, color, {
      emissive: age < 0.5 ? 1 : 0.35,
      pulse: pulse - 0.8,
    });

    const coreChar = age < 0.18 ? "*" : pulse > 0.93 ? "@" : "+";
    fb.set(p.sx, p.sy, coreChar, color, p.depth - 0.22, age < 0.5 ? 1 : 0.45);

  }

  drawNodeLabels(fb, projected);

  // ── Particles ──
  particles.draw(fb, proj);
}

type LabelRect = { x: number; y: number; width: number; height: number };

function intersectionArea(a: LabelRect, b: LabelRect): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  return x2 > x1 && y2 > y1 ? (x2 - x1) * (y2 - y1) : 0;
}

function drawNodeLabels(
  fb: Framebuffer,
  projected: (Projected & { node: GraphNode; idx: number; sphereRadius: number })[],
) {
  const occupied: LabelRect[] = projected.map((p) => ({
    x: Math.max(0, Math.floor(p.sx - p.sphereRadius * 1.4)),
    y: Math.max(0, Math.floor(p.sy - p.sphereRadius)),
    width: Math.max(1, Math.ceil(p.sphereRadius * 2.8)),
    height: Math.max(1, Math.ceil(p.sphereRadius * 2)),
  }));

  const labels = [...projected].sort((a, b) => a.depth - b.depth);
  for (const p of labels) {
    const text = p.node.label;
    const color = PKG_COLORS[p.node.pkg % PKG_COLORS.length]!;
    const pad = Math.max(2, Math.ceil(p.sphereRadius));
    const centerX = fb.width / 2;
    const centerY = fb.height / 2;
    const dx = p.sx - centerX;
    const dy = p.sy - centerY;

    const right = {
      x: Math.round(p.sx + p.sphereRadius * 2 + pad),
      y: Math.round(p.sy),
      width: text.length,
      height: 1,
    };
    const left = {
      x: Math.round(p.sx - p.sphereRadius * 2 - pad - text.length),
      y: Math.round(p.sy),
      width: text.length,
      height: 1,
    };
    const above = {
      x: Math.round(p.sx - text.length / 2),
      y: Math.round(p.sy - p.sphereRadius - 2),
      width: text.length,
      height: 1,
    };
    const below = {
      x: Math.round(p.sx - text.length / 2),
      y: Math.round(p.sy + p.sphereRadius + 1),
      width: text.length,
      height: 1,
    };

    const candidates = Math.abs(dx) >= Math.abs(dy)
      ? (dx >= 0 ? [right, above, below, left] : [left, above, below, right])
      : (dy >= 0 ? [below, right, left, above] : [above, right, left, below]);

    let bestRect = candidates[0]!;
    let bestScore = Infinity;

    for (const candidate of candidates) {
      const rect: LabelRect = {
        x: Math.max(0, Math.min(fb.width - candidate.width, candidate.x)),
        y: Math.max(0, Math.min(fb.height - 1, candidate.y)),
        width: candidate.width,
        height: candidate.height,
      };

      let score = Math.abs(rect.x - candidate.x) + Math.abs(rect.y - candidate.y) * 2;
      for (const block of occupied) {
        score += intersectionArea(rect, block) * 50;
      }

      if (score < bestScore) {
        bestScore = score;
        bestRect = rect;
      }
    }

    drawText(fb, bestRect.x, bestRect.y, text, color, p.depth - 0.26);
    occupied.push({
      x: Math.max(0, bestRect.x - 1),
      y: bestRect.y,
      width: Math.min(fb.width - bestRect.x + 1, bestRect.width + 2),
      height: 1,
    });
  }
}

// ── Exported API ────────────────────────────────────────────────────────────

export type AnimationHandle = {
  update: (status: string) => void;
  log: (line: string) => void;
  packageReady: (pkgName: string) => void;
  pause: () => void;
  stop: () => Promise<void>;
};

/**
 * Start animation in a subprocess so it gets its own event loop and
 * isn't starved by CPU-intensive audit tools on the main thread.
 */
export function startAnimation(opts?: { packages?: string[]; edges?: [number, number][] }): AnimationHandle {
  const isCompiled = !process.execPath.includes("bun");

  // Spawn animation as subprocess so it gets its own event loop
  const args = isCompiled
    ? [process.execPath, "__anim__", "--subprocess"]
    : ["bun", import.meta.filename, "--subprocess"];
  if (opts?.packages?.length) {
    args.push("--packages", opts.packages.join(","));
  }
  if (opts?.edges?.length) {
    args.push("--edges", opts.edges.map(([a, b]) => `${a}-${b}`).join(","));
  }

  const proc = Bun.spawn(args, {
    stdin: "pipe",
    stdout: "inherit",
    stderr: "pipe",
  });

  return {
    update(status: string) {
      try {
        proc.stdin.write(status + "\n");
        proc.stdin.flush();
      } catch {}
    },
    log(line: string) {
      try {
        proc.stdin.write(`__LOG__:${line}\n`);
        proc.stdin.flush();
      } catch {}
    },
    packageReady(pkgName: string) {
      try {
        proc.stdin.write(`__READY__:${encodeURIComponent(pkgName)}\n`);
        proc.stdin.flush();
      } catch {}
    },
    pause() {
      try {
        proc.stdin.write("__PAUSE__\n");
        proc.stdin.flush();
      } catch {}
    },
    async stop() {
      try {
        proc.stdin.write("__STOP__\n");
        proc.stdin.flush();
        proc.stdin.end();
      } catch {
        // Subprocess may already be dead — just restore cursor
        process.stdout.write("\x1b[2J\x1b[H\x1b[?25h");
        return;
      }
      // Wait for subprocess to actually exit so its screen-clear finishes
      // before the parent prints anything
      const timeout = setTimeout(() => { try { proc.kill(); } catch {} }, 500);
      try { await proc.exited; } catch {}
      clearTimeout(timeout);
    },
  };
}

function startAnimationInProcess(opts?: { packages?: string[]; edges?: [number, number][] }): AnimationHandle {
  const pkgNames = opts?.packages;
  const { nodes, edges } = createGraph(pkgNames, opts?.edges);
  const particles = new ParticleSystem();
  const nodeByName = new Map(nodes.map((node) => [node.label, node]));

  const camera = createCamera({
    position: v3.create(0, 0.5, 7),
    target: v3.create(0, 0, 0),
    fov: 1.0,
  });

  let statusText = "initializing...";
  let activeNodes = 0;
  let activeEdges = 0;
  let sceneTime = 0; // track scene time for glow triggers

  // Orbit state
  let orbitAngle = 0;
  const orbitRadius = 7;
  const orbitSpeed = 0.15;
  const orbitTilt = 0.3;

  const handle = runScene(camera, {
    update(dt, t) {
      sceneTime = t;
      // Orbit camera
      orbitAngle += orbitSpeed * dt;
      const tiltWobble = orbitTilt + Math.sin(t * 0.12) * 0.15;
      camera.position = v3.create(
        Math.sin(orbitAngle) * orbitRadius,
        Math.sin(tiltWobble) * 2.5 + 1,
        Math.cos(orbitAngle) * orbitRadius,
      );

      // Physics
      updatePhysics(nodes, dt, t);

      for (const e of edges) {
        if (e.spawnT !== Number.POSITIVE_INFINITY) continue;
        const from = nodes[e.from]!;
        const to = nodes[e.to]!;
        if (!from.ready || !to.ready) continue;
        e.spawnT = t + 0.08;
      }

      // Count active elements
      activeNodes = nodes.filter((n) => n.ready).length;
      activeEdges = edges.filter((e) => e.spawnT <= t).length;

      // Spawn particles on newly appearing nodes
      for (const n of nodes) {
        const age = t - n.spawnT;
        if (n.ready && age >= 0 && age < dt * 2) {
          const color = PKG_COLORS[n.pkg % PKG_COLORS.length]!;
          particles.emit(n.pos, 6, {
            speed: 0.8,
            life: 1.2,
            char: ".",
            fg: color,
            emissive: 0.8,
            spread: 0.6,
          });
          n.glowT = t;
        }
      }

      // Spawn particles on newly appearing cross-package edges
      for (const e of edges) {
        if (!e.cross) continue;
        const age = t - e.spawnT;
        if (age >= 0 && age < dt * 2) {
          const mid = v3.lerp(nodes[e.from]!.pos, nodes[e.to]!.pos, 0.5);
          particles.emit(mid, 4, {
            speed: 0.4,
            life: 0.8,
            fg: ACCENT,
            emissive: 1,
          });
        }
      }

      particles.update(dt);
    },

    render(fb, proj, t) {
      renderGraph(fb, proj, nodes, edges, particles, t);
    },

    statusBar(t) {
      const stats = `${GREY}${activeNodes}m ${DIM}·${RESET} ${GREY}${activeEdges}e${RESET}`;
      return `  ${ACCENT}${BOLD}supergraph${RESET}  ${stats}  ${DIM}${statusText}${RESET}`;
    },
  }, {
    fps: 24,
    maxWidth: 160,
    maxHeight: 50,
    reserveBottom: 3,
    logLines: 8,
  });

  return {
    update(status: string) {
      statusText = status;
      const readyNodes = nodes.filter((node) => node.ready);
      const count = Math.min(5, Math.floor(Math.random() * 4) + 1, readyNodes.length);
      for (let i = 0; i < count; i++) {
        const idx = Math.floor(Math.random() * readyNodes.length);
        readyNodes[idx]!.glowT = sceneTime;
      }
    },
    log(line: string) {
      handle.log(line);
    },
    packageReady(pkgName: string) {
      const node = nodeByName.get(pkgName);
      if (!node || node.ready) return;
      node.ready = true;
      node.pos = { ...node.targetPos };
      node.vel = v3.create(0, 0, 0);
      node.spawnT = sceneTime;
      node.glowT = sceneTime;
    },
    pause() {
      handle.pause();
    },
    async stop() {
      handle.stop();
    },
  };
}

// ── Subprocess mode — reads status updates from stdin ──────────────────────

if (process.argv.includes("--subprocess")) {
  const pkgIdx = process.argv.indexOf("--packages");
  const pkgArg = pkgIdx >= 0 ? process.argv[pkgIdx + 1] : undefined;
  const packages = pkgArg ? pkgArg.split(",") : undefined;

  const edgeIdx = process.argv.indexOf("--edges");
  const edgeArg = edgeIdx >= 0 ? process.argv[edgeIdx + 1] : undefined;
  const parsedEdges: [number, number][] | undefined = edgeArg
    ? edgeArg.split(",").map(e => {
        const [a, b] = e.split("-").map(Number);
        return [a!, b!] as [number, number];
      })
    : undefined;

  const anim = startAnimationInProcess({ packages, edges: parsedEdges });

  const decoder = new TextDecoder();
  let buffer = "";

  process.stdin.resume();
  process.stdin.on("data", (chunk: Buffer) => {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      if (line === "__STOP__") {
        anim.stop();
        process.exit(0);
      }
      if (line === "__PAUSE__") {
        anim.pause();
        continue;
      }
      if (line.startsWith("__LOG__:")) {
        anim.log(line.slice(8));
      } else if (line.startsWith("__READY__:")) {
        anim.packageReady(decodeURIComponent(line.slice(10)));
      } else {
        anim.update(line);
      }
    }
  });

  process.stdin.on("end", () => {
    anim.stop();
    process.exit(0);
  });

  process.on("SIGINT", () => {
    anim.stop();
    process.exit(0);
  });
}

// ── Standalone demo ─────────────────────────────────────────────────────────
else if (import.meta.main) {
  const anim = startAnimationInProcess();

  const phases = [
    [1.0, "scanning packages..."],
    [3.0, "building module graph..."],
    [5.0, "analyzing exports..."],
    [7.0, "tracing dependencies..."],
    [9.0, "detecting cross-package edges..."],
    [11.0, "compressing symbols..."],
    [13.0, "writing supergraph.txt..."],
    [15.0, "generating visualization..."],
    [17.0, "done — press enter to exit"],
  ] as const;

  let phase = 0;
  let readyIdx = 0;
  const t0 = Date.now();

  const check = setInterval(() => {
    const elapsed = (Date.now() - t0) / 1000;
    while (phase < phases.length && elapsed >= phases[phase]![0]) {
      anim.update(phases[phase]![1]);
      phase++;
    }
    while (readyIdx < DEFAULT_PKG_NAMES.length && elapsed >= 1.2 + readyIdx * 1.15) {
      anim.packageReady(DEFAULT_PKG_NAMES[readyIdx]!);
      readyIdx++;
    }
    if (phase >= phases.length) {
      clearInterval(check);
    }
  }, 100);

  // Wait for Enter to exit
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (key: Buffer) => {
      // Enter (0x0d), or Ctrl+C (0x03), or q
      if (key[0] === 0x0d || key[0] === 0x0a || key[0] === 0x03 || key[0] === 0x71) {
        clearInterval(check);
        anim.stop();
        console.log(`${ACCENT}done${RESET}  supergraph complete`);
        process.exit(0);
      }
    });
  } else {
    // Non-TTY: just wait for phases to complete then exit after a pause
    const exitCheck = setInterval(() => {
      if (phase >= phases.length) {
        clearInterval(exitCheck);
        setTimeout(() => {
          anim.stop();
          console.log(`${ACCENT}done${RESET}  supergraph complete`);
          process.exit(0);
        }, 2000);
      }
    }, 200);
  }

  // Handle Ctrl+C gracefully
  process.on("SIGINT", () => {
    clearInterval(check);
    anim.stop();
    process.exit(0);
  });
}
