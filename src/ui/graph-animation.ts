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
  createCamera, drawLine, drawGlow, drawLabel, drawText,
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
      spawnT: i * 0.2 + Math.random() * 0.1,
      glowT: -10,
    });
  }

  if (realEdges && realEdges.length > 0) {
    // Use real dependency edges
    for (const [from, to] of realEdges) {
      if (from < nodes.length && to < nodes.length) {
        edges.push({
          from, to,
          spawnT: Math.max(nodes[from]!.spawnT, nodes[to]!.spawnT) + 0.3,
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
        spawnT: Math.max(nodes[i]!.spawnT, nodes[next]!.spawnT) + 0.2,
        cross: true,
      });
      for (let j = i + 2; j < nodes.length; j++) {
        if (Math.random() < 0.15) {
          edges.push({
            from: i, to: j,
            spawnT: Math.max(nodes[i]!.spawnT, nodes[j]!.spawnT) + 0.4,
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
  const projected: (Projected & { node: GraphNode; idx: number })[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    if (t < n.spawnT) continue;
    const p = proj.project(n.pos);
    if (p.visible) {
      projected.push({ ...p, node: n, idx: i });
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
      // Cross-package: accent colored, dashed
      drawLine(fb, pa, pb, {
        char: "-",
        fg: ACCENT,
        dashGap: 2,
      }, progress);
    } else {
      // Intra-package: dim grey, solid dots
      drawLine(fb, pa, pb, {
        char: ".",
        fg: DARK,
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
      drawGlow(fb, p.sx, p.sy, 3 + burstIntensity * 3, burstIntensity, color);
    }

    // Ambient glow for all nodes
    const ambientPulse = 0.15 + 0.08 * Math.sin(t * 2.5 + p.idx * 1.7);
    drawGlow(fb, p.sx, p.sy, 2, ambientPulse, color);

    // Triggered glow (from status updates)
    if (glowAge < 1.0 && glowAge >= 0) {
      const trigIntensity = (1 - glowAge) * 0.9;
      drawGlow(fb, p.sx, p.sy, 4, trigIntensity, ACCENT);
    }
  }

  // ── Draw nodes ──
  for (const p of projected) {
    const age = t - p.node.spawnT;
    const color = PKG_COLORS[p.node.pkg % PKG_COLORS.length]!;
    const pulse = 0.8 + 0.2 * Math.sin(t * 3 + p.idx);

    // Node character based on age and pulse
    let ch: string;
    if (age < 0.15) {
      ch = "*";
    } else if (age < 0.3) {
      ch = "+";
    } else if (pulse > 0.92) {
      ch = "@";
    } else if (pulse > 0.85) {
      ch = "#";
    } else {
      ch = "*";
    }

    fb.set(p.sx, p.sy, ch, color, p.depth, age < 0.5 ? 1 : 0.3);

    // Labels for nodes that are close enough
    if (p.scale > 0.1 && age > 0.6) {
      drawLabel(fb, proj, p.node.pos, p.node.label, color);
    }
  }

  // ── Particles ──
  particles.draw(fb, proj);
}

// ── Exported API ────────────────────────────────────────────────────────────

export type AnimationHandle = {
  update: (status: string) => void;
  log: (line: string) => void;
  stop: () => void;
  /** Show a prompt and wait for a keypress. Resolves with the key character. Animation keeps running. */
  waitForKey: () => Promise<string>;
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
    stop() {
      try {
        proc.stdin.write("__STOP__\n");
        proc.stdin.flush();
        proc.stdin.end();
      } catch {
        // Subprocess may already be dead — restore terminal from parent
        process.stdout.write("\x1b[2J\x1b[H\x1b[?25h");
      }
    },
    waitForKey(): Promise<string> {
      return new Promise((resolve) => {
        // Read keypresses from the real TTY while animation keeps rendering
        if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
          process.stdin.setRawMode(true);
          process.stdin.resume();
          const onData = (key: Buffer) => {
            process.stdin.removeListener("data", onData);
            process.stdin.setRawMode(false);
            process.stdin.pause();
            // Ctrl+C
            if (key[0] === 0x03) {
              resolve("q");
              return;
            }
            resolve(String.fromCharCode(key[0]!));
          };
          process.stdin.on("data", onData);
        } else {
          // Non-TTY: resolve immediately
          resolve("\n");
        }
      });
    },
  };
}

function startAnimationInProcess(opts?: { packages?: string[]; edges?: [number, number][] }): AnimationHandle {
  const pkgNames = opts?.packages;
  const { nodes, edges } = createGraph(pkgNames, opts?.edges);
  const particles = new ParticleSystem();

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

      // Count active elements
      activeNodes = nodes.filter(n => t >= n.spawnT).length;
      activeEdges = edges.filter(e => t >= e.spawnT).length;

      // Spawn particles on newly appearing nodes
      for (const n of nodes) {
        const age = t - n.spawnT;
        if (age >= 0 && age < dt * 2) {
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
      // Trigger glow on random subset of nodes
      const count = Math.min(5, Math.floor(Math.random() * 4) + 1);
      for (let i = 0; i < count; i++) {
        const idx = Math.floor(Math.random() * nodes.length);
        nodes[idx]!.glowT = sceneTime;
      }
    },
    log(line: string) {
      handle.log(line);
    },
    stop() {
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
      if (line.startsWith("__LOG__:")) {
        anim.log(line.slice(8));
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
    [13.0, "writing superhigh.txt..."],
    [15.0, "generating visualization..."],
    [17.0, "done — press enter to exit"],
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
