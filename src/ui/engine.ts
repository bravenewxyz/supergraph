/**
 * 3D ASCII render engine.
 *
 * Features:
 *   - Vec3 / Mat4 math
 *   - Perspective camera with configurable FOV
 *   - Z-buffer framebuffer (char + fg color + depth per cell)
 *   - Bresenham line rasterizer with per-pixel depth interpolation
 *   - Depth-based fog (far objects fade to dimmer glyphs)
 *   - Glow halos around emissive points
 *   - Particle system (sparks, trails)
 *   - Double-buffered output (only rewrite changed cells)
 */

// ── ANSI helpers ────────────────────────────────────────────────────────────

export const RESET = "\x1b[0m";
export const DIM = "\x1b[2m";
export const BOLD = "\x1b[1m";

export function rgb(r: number, g: number, b: number): string {
  return `\x1b[38;2;${r};${g};${b}m`;
}

export function rgbBg(r: number, g: number, b: number): string {
  return `\x1b[48;2;${r};${g};${b}m`;
}

export function ansi256(n: number): string {
  return `\x1b[38;5;${n}m`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

type RgbColor = { r: number; g: number; b: number };

const SHADE_RAMP = " .,:-=+*#%@";
const ANSI_TRUECOLOR_RE = /\x1b\[38;2;(\d+);(\d+);(\d+)m/;
const ANSI_256_RE = /\x1b\[38;5;(\d+)m/;
const ANSI_COLOR_CACHE = new Map<string, RgbColor>();

function ansi256ToRgb(index: number): RgbColor {
  if (index < 16) {
    const base: RgbColor[] = [
      { r: 0, g: 0, b: 0 },
      { r: 205, g: 49, b: 49 },
      { r: 13, g: 188, b: 121 },
      { r: 229, g: 229, b: 16 },
      { r: 36, g: 114, b: 200 },
      { r: 188, g: 63, b: 188 },
      { r: 17, g: 168, b: 205 },
      { r: 229, g: 229, b: 229 },
      { r: 102, g: 102, b: 102 },
      { r: 241, g: 76, b: 76 },
      { r: 35, g: 209, b: 139 },
      { r: 245, g: 245, b: 67 },
      { r: 59, g: 142, b: 234 },
      { r: 214, g: 112, b: 214 },
      { r: 41, g: 184, b: 219 },
      { r: 255, g: 255, b: 255 },
    ];
    return base[index] ?? { r: 255, g: 255, b: 255 };
  }

  if (index >= 232) {
    const v = 8 + (index - 232) * 10;
    return { r: v, g: v, b: v };
  }

  const cube = index - 16;
  const r = Math.floor(cube / 36);
  const g = Math.floor((cube % 36) / 6);
  const b = cube % 6;
  const levels = [0, 95, 135, 175, 215, 255];
  return { r: levels[r]!, g: levels[g]!, b: levels[b]! };
}

function colorFromAnsi(fg: string): RgbColor {
  const cached = ANSI_COLOR_CACHE.get(fg);
  if (cached) return cached;

  const trueColor = fg.match(ANSI_TRUECOLOR_RE);
  if (trueColor) {
    const parsed = {
      r: Number(trueColor[1]),
      g: Number(trueColor[2]),
      b: Number(trueColor[3]),
    };
    ANSI_COLOR_CACHE.set(fg, parsed);
    return parsed;
  }

  const indexed = fg.match(ANSI_256_RE);
  if (indexed) {
    const parsed = ansi256ToRgb(Number(indexed[1]));
    ANSI_COLOR_CACHE.set(fg, parsed);
    return parsed;
  }

  const fallback = { r: 255, g: 255, b: 255 };
  ANSI_COLOR_CACHE.set(fg, fallback);
  return fallback;
}

function scaleColor(color: RgbColor, scale: number): RgbColor {
  return {
    r: clamp(Math.round(color.r * scale), 0, 255),
    g: clamp(Math.round(color.g * scale), 0, 255),
    b: clamp(Math.round(color.b * scale), 0, 255),
  };
}

function mixColor(a: RgbColor, b: RgbColor, t: number): RgbColor {
  const blend = clamp(t, 0, 1);
  return {
    r: Math.round(a.r + (b.r - a.r) * blend),
    g: Math.round(a.g + (b.g - a.g) * blend),
    b: Math.round(a.b + (b.b - a.b) * blend),
  };
}

// ── Vec3 ────────────────────────────────────────────────────────────────────

export type Vec3 = { x: number; y: number; z: number };

export const v3 = {
  create(x = 0, y = 0, z = 0): Vec3 { return { x, y, z }; },
  add(a: Vec3, b: Vec3): Vec3 { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; },
  sub(a: Vec3, b: Vec3): Vec3 { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; },
  scale(v: Vec3, s: number): Vec3 { return { x: v.x * s, y: v.y * s, z: v.z * s }; },
  dot(a: Vec3, b: Vec3): number { return a.x * b.x + a.y * b.y + a.z * b.z; },
  cross(a: Vec3, b: Vec3): Vec3 {
    return {
      x: a.y * b.z - a.z * b.y,
      y: a.z * b.x - a.x * b.z,
      z: a.x * b.y - a.y * b.x,
    };
  },
  len(v: Vec3): number { return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z); },
  normalize(v: Vec3): Vec3 {
    const l = v3.len(v);
    return l > 0 ? v3.scale(v, 1 / l) : { x: 0, y: 0, z: 0 };
  },
  lerp(a: Vec3, b: Vec3, t: number): Vec3 {
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
  },
  dist(a: Vec3, b: Vec3): number { return v3.len(v3.sub(b, a)); },
};

// ── Mat4 (column-major, Float64) ────────────────────────────────────────────

export type Mat4 = Float64Array;

export const m4 = {
  identity(): Mat4 {
    const m = new Float64Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
  },

  multiply(a: Mat4, b: Mat4): Mat4 {
    const o = new Float64Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) sum += a[r + k * 4]! * b[k * 4 + c * 4]!;
        // fix: proper col-major multiply
      }
    }
    // Simpler correct version:
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[i + k * 4]! * b[k + j * 4]!;
        o[i + j * 4] = s;
      }
    }
    return o;
  },

  rotateY(angle: number): Mat4 {
    const m = m4.identity();
    const c = Math.cos(angle), s = Math.sin(angle);
    m[0] = c; m[8] = -s;
    m[2] = s; m[10] = c;
    return m;
  },

  rotateX(angle: number): Mat4 {
    const m = m4.identity();
    const c = Math.cos(angle), s = Math.sin(angle);
    m[5] = c; m[9] = s;
    m[6] = -s; m[10] = c;
    return m;
  },

  rotateZ(angle: number): Mat4 {
    const m = m4.identity();
    const c = Math.cos(angle), s = Math.sin(angle);
    m[0] = c; m[4] = s;
    m[1] = -s; m[5] = c;
    return m;
  },

  translate(tx: number, ty: number, tz: number): Mat4 {
    const m = m4.identity();
    m[12] = tx; m[13] = ty; m[14] = tz;
    return m;
  },

  transformPoint(m: Mat4, p: Vec3): Vec3 {
    const w = m[3]! * p.x + m[7]! * p.y + m[11]! * p.z + m[15]!;
    return {
      x: (m[0]! * p.x + m[4]! * p.y + m[8]! * p.z + m[12]!) / w,
      y: (m[1]! * p.x + m[5]! * p.y + m[9]! * p.z + m[13]!) / w,
      z: (m[2]! * p.x + m[6]! * p.y + m[10]! * p.z + m[14]!) / w,
    };
  },
};

// ── Camera ──────────────────────────────────────────────────────────────────

export type Camera = {
  position: Vec3;
  target: Vec3;
  fov: number;       // vertical FOV in radians
  near: number;
  far: number;
};

export function createCamera(opts?: Partial<Camera>): Camera {
  return {
    position: opts?.position ?? v3.create(0, 0, 5),
    target: opts?.target ?? v3.create(0, 0, 0),
    fov: opts?.fov ?? 1.2,
    near: opts?.near ?? 0.1,
    far: opts?.far ?? 50,
  };
}

function lookAtMatrix(eye: Vec3, target: Vec3): Mat4 {
  const up = v3.create(0, 1, 0);
  const f = v3.normalize(v3.sub(target, eye));
  const r = v3.normalize(v3.cross(f, up));
  const u = v3.cross(r, f);

  const m = m4.identity();
  m[0] = r.x; m[4] = r.y; m[8] = r.z;
  m[1] = u.x; m[5] = u.y; m[9] = u.z;
  m[2] = -f.x; m[6] = -f.y; m[10] = -f.z;
  m[12] = -v3.dot(r, eye);
  m[13] = -v3.dot(u, eye);
  m[14] = v3.dot(f, eye);
  return m;
}

// ── Framebuffer ─────────────────────────────────────────────────────────────

export type Cell = {
  char: string;
  fg: string;       // ANSI fg escape
  depth: number;     // Z value (lower = closer)
  emissive: number;  // glow intensity 0–1
  light: number;     // accumulated brightness
  coverage: number;  // accumulated coverage
  accumR: number;
  accumG: number;
  accumB: number;
};

export class Framebuffer {
  readonly width: number;
  readonly height: number;
  readonly cells: Cell[];
  private prev: string[] | null = null;

  constructor(w: number, h: number) {
    this.width = w;
    this.height = h;
    this.cells = new Array(w * h);
    this.clear();
  }

  clear() {
    for (let i = 0; i < this.cells.length; i++) {
      this.cells[i] = {
        char: " ",
        fg: "",
        depth: Infinity,
        emissive: 0,
        light: 0,
        coverage: 0,
        accumR: 0,
        accumG: 0,
        accumB: 0,
      };
    }
  }

  /** Write a cell if it passes the depth test. */
  set(x: number, y: number, char: string, fg: string, depth: number, emissive = 0) {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || ix >= this.width || iy < 0 || iy >= this.height) return;
    const idx = iy * this.width + ix;
    const cell = this.cells[idx]!;
    if (depth <= cell.depth + 0.05) {
      cell.char = char;
      cell.fg = fg;
      cell.depth = depth;
      cell.emissive = Math.max(cell.emissive, emissive);
    }
  }

  private blendLight(ix: number, iy: number, color: RgbColor, depth: number, amount: number, emissive = 0) {
    if (ix < 0 || ix >= this.width || iy < 0 || iy >= this.height || amount <= 0.001) return;

    const idx = iy * this.width + ix;
    const cell = this.cells[idx]!;

    if (cell.char !== " " && depth > cell.depth + 0.18) return;
    if (cell.coverage > 0 && depth > cell.depth + 0.28) return;

    if (depth < cell.depth - 0.18) {
      cell.coverage *= 0.6;
      cell.light *= 0.6;
      cell.accumR *= 0.6;
      cell.accumG *= 0.6;
      cell.accumB *= 0.6;
    }

    cell.depth = Math.min(cell.depth, depth);
    cell.coverage += amount;
    cell.light += amount;
    cell.accumR += color.r * amount;
    cell.accumG += color.g * amount;
    cell.accumB += color.b * amount;
    cell.emissive = Math.max(cell.emissive, emissive);
  }

  /** Sub-pixel sample that distributes intensity across neighboring cells. */
  splat(x: number, y: number, depth: number, fg: string, intensity: number, emissive = 0) {
    const color = colorFromAnsi(fg);
    const minX = Math.floor(x);
    const maxX = Math.ceil(x);
    const minY = Math.floor(y);
    const maxY = Math.ceil(y);

    for (let iy = minY; iy <= maxY; iy++) {
      for (let ix = minX; ix <= maxX; ix++) {
        const wx = Math.max(0, 1 - Math.abs(x - ix));
        const wy = Math.max(0, 1 - Math.abs(y - iy));
        const weight = wx * wy * intensity;
        this.blendLight(ix, iy, color, depth, weight, emissive);
      }
    }
  }

  /** Additive write — blends glow without overwriting foreground chars. */
  addGlow(x: number, y: number, intensity: number, fg: string, depth = Infinity) {
    this.splat(x, y, depth, fg, intensity * 0.85, intensity);
  }

  /** Render to ANSI string. Uses diff against previous frame. */
  render(forceFullRedraw = false): string {
    const out: string[] = [];
    const curr: string[] = new Array(this.cells.length);

    for (let i = 0; i < this.cells.length; i++) {
      const c = this.cells[i]!;
      if (c.char !== " ") {
        curr[i] = c.fg + c.char + RESET;
      } else if (c.light > 0.02 || c.emissive > 0.08) {
        const avgColor = c.light > 0.0001
          ? {
              r: c.accumR / c.light,
              g: c.accumG / c.light,
              b: c.accumB / c.light,
            }
          : { r: 255, g: 255, b: 255 };
        const glow = c.emissive * 0.8;
        const tone = 1 - Math.exp(-(c.light * 0.9 + glow));
        const rampIndex = clamp(Math.floor(tone * (SHADE_RAMP.length - 1)), 0, SHADE_RAMP.length - 1);
        const highlight = mixColor(avgColor, { r: 255, g: 255, b: 255 }, clamp(glow * 0.45, 0, 0.45));
        const finalColor = scaleColor(highlight, 0.55 + tone * 0.95 + glow * 0.4);
        curr[i] = rgb(finalColor.r, finalColor.g, finalColor.b) + SHADE_RAMP[rampIndex]! + RESET;
      } else {
        curr[i] = " ";
      }
    }

    if (!forceFullRedraw && this.prev) {
      // Diff render — only move cursor to changed cells
      for (let y = 0; y < this.height; y++) {
        let lineChanged = false;
        for (let x = 0; x < this.width; x++) {
          const idx = y * this.width + x;
          if (curr[idx] !== this.prev[idx]) {
            lineChanged = true;
            break;
          }
        }
        if (lineChanged) {
          out.push(`\x1b[${y + 1};1H`); // move cursor
          for (let x = 0; x < this.width; x++) {
            out.push(curr[y * this.width + x]!);
          }
        }
      }
    } else {
      // Full redraw
      for (let y = 0; y < this.height; y++) {
        if (y > 0) out.push("\n");
        for (let x = 0; x < this.width; x++) {
          out.push(curr[y * this.width + x]!);
        }
      }
    }

    this.prev = curr;
    return out.join("");
  }
}

// ── Projector (world → screen) ──────────────────────────────────────────────

export type Projected = {
  sx: number;        // screen x
  sy: number;        // screen y
  depth: number;     // view-space z (for z-buffer)
  scale: number;     // perspective scale factor
  visible: boolean;
};

export class Projector {
  private viewMatrix: Mat4 = m4.identity();
  private aspectX: number;
  private aspectY: number;
  private fovScale: number;
  private cam: Camera;
  readonly width: number;
  readonly height: number;

  constructor(camera: Camera, width: number, height: number) {
    this.cam = camera;
    this.width = width;
    this.height = height;
    // Terminal cells are ~2:1 tall:wide, compensate
    this.aspectX = width * 0.5;
    this.aspectY = height;
    this.fovScale = 1 / Math.tan(camera.fov / 2);
    this.update(camera);
  }

  update(camera: Camera) {
    this.cam = camera;
    this.viewMatrix = lookAtMatrix(camera.position, camera.target);
    this.fovScale = 1 / Math.tan(camera.fov / 2);
  }

  project(p: Vec3): Projected {
    const v = m4.transformPoint(this.viewMatrix, p);
    // View-space Z is negative in front of camera (OpenGL convention), negate for depth
    const viewZ = -v.z;

    if (viewZ <= this.cam.near || viewZ > this.cam.far) {
      return { sx: -1, sy: -1, depth: viewZ, scale: 0, visible: false };
    }

    const invZ = this.fovScale / viewZ;
    const sx = this.width / 2 + v.x * invZ * this.aspectX;
    const sy = this.height / 2 - v.y * invZ * this.aspectY;

    return {
      sx,
      sy,
      depth: viewZ,
      scale: invZ,
      visible: sx >= -1 && sx <= this.width && sy >= -1 && sy <= this.height,
    };
  }

  /** Project without rounding (sub-pixel). */
  projectF(p: Vec3): Projected {
    const v = m4.transformPoint(this.viewMatrix, p);
    const viewZ = -v.z;
    if (viewZ <= this.cam.near || viewZ > this.cam.far) {
      return { sx: -1, sy: -1, depth: viewZ, scale: 0, visible: false };
    }
    const invZ = this.fovScale / viewZ;
    const sx = this.width / 2 + v.x * invZ * this.aspectX;
    const sy = this.height / 2 - v.y * invZ * this.aspectY;
    return { sx, sy, depth: viewZ, scale: invZ, visible: sx >= -1 && sx <= this.width && sy >= -1 && sy <= this.height };
  }
}

// ── Depth fog ───────────────────────────────────────────────────────────────

const FOG_RAMP = " .·:+*#@";

/** Given depth 0–1 (0=near, 1=far), pick a fog character. */
export function fogChar(normalizedDepth: number): string {
  const i = Math.max(0, Math.min(FOG_RAMP.length - 1,
    Math.floor((1 - normalizedDepth) * FOG_RAMP.length)));
  return FOG_RAMP[i]!;
}

/** Dim a color based on depth. Returns modified ANSI. */
export function depthDim(fg: string, normalizedDepth: number): string {
  if (normalizedDepth > 0.7) return DIM + fg;
  return fg;
}

// ── Line rasterizer ─────────────────────────────────────────────────────────

export type LineStyle = {
  char?: string;
  chars?: string;     // directional chars: "─│╱╲·" (h, v, fwd-diag, bk-diag, dot)
  fg: string;
  dashGap?: number;   // 0 = solid
  width?: number;
  intensity?: number;
};

/** Draw a 3D line between two projected points with depth interpolation. */
export function drawLine(
  fb: Framebuffer,
  a: Projected, b: Projected,
  style: LineStyle,
  progress = 1,
) {
  if (!a.visible && !b.visible) return;

  const dx = b.sx - a.sx;
  const dy = b.sy - a.sy;
  const length = Math.hypot(dx, dy);
  if (length < 0.001) return;
  const steps = Math.max(1, Math.ceil(length * 1.5));

  const drawSteps = Math.floor(steps * Math.max(0, Math.min(1, progress)));
  const width = style.width ?? (style.dashGap ? 0.95 : 0.7);
  const intensity = style.intensity ?? (style.dashGap ? 0.5 : 0.32);
  const invLength = 1 / length;
  const nx = -dy * invLength;
  const ny = dx * invLength;

  for (let s = 0; s <= drawSteps; s++) {
    const t = steps === 0 ? 0 : s / steps;
    const x = a.sx + dx * t;
    const y = a.sy + dy * t;
    const depth = a.depth + (b.depth - a.depth) * t;

    if (style.dashGap && style.dashGap > 0) {
      if (s % (style.dashGap + 1) !== 0) continue;
    }

    fb.splat(x, y, depth, style.fg, intensity);
    if (width > 0.8) {
      const offset = (width - 0.35) * 0.45;
      fb.splat(x + nx * offset, y + ny * offset, depth + 0.01, style.fg, intensity * 0.5);
      fb.splat(x - nx * offset, y - ny * offset, depth + 0.01, style.fg, intensity * 0.5);
    }
  }
}

// ── Glow emitter ────────────────────────────────────────────────────────────

/** Draw a radial glow halo around a screen point. */
export function drawGlow(
  fb: Framebuffer,
  sx: number, sy: number,
  radius: number,
  intensity: number,
  fg: string,
  depth = Infinity,
) {
  const r = Math.ceil(radius);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r * 2; dx <= r * 2; dx++) {
      // compensate for terminal aspect ratio (chars ~2:1)
      const dist = Math.sqrt((dx / 2) ** 2 + dy ** 2);
      if (dist > radius) continue;
      const falloff = 1 - dist / radius;
      const glow = falloff * falloff * intensity;
      if (glow > 0.05) {
        fb.addGlow(sx + dx, sy + dy, glow, fg, depth);
      }
    }
  }
}

// ── Sphere helper ───────────────────────────────────────────────────────────

export function drawSphere(
  fb: Framebuffer,
  center: Projected,
  radius: number,
  fg: string,
  opts?: { emissive?: number; pulse?: number },
) {
  if (!center.visible || radius <= 0.2) return;

  const baseColor = colorFromAnsi(fg);
  const lightDir = v3.normalize(v3.create(-0.45, -0.65, 0.85));
  const viewDir = v3.create(0, 0, 1);
  const halfVec = v3.normalize(v3.add(lightDir, viewDir));
  const emissive = opts?.emissive ?? 0;
  const pulse = opts?.pulse ?? 0;
  const screenRadius = Math.max(1, radius);
  const maxDy = Math.ceil(screenRadius);
  const maxDx = Math.ceil(screenRadius * 2);

  for (let dy = -maxDy; dy <= maxDy; dy++) {
    for (let dx = -maxDx; dx <= maxDx; dx++) {
      const nx = dx / (screenRadius * 2);
      const ny = dy / screenRadius;
      const rr = nx * nx + ny * ny;
      if (rr > 1) continue;

      const nz = Math.sqrt(1 - rr);
      const normal = v3.normalize(v3.create(nx, ny, nz));
      const diffuse = Math.max(0, v3.dot(normal, lightDir));
      const rim = Math.pow(1 - Math.max(0, v3.dot(normal, viewDir)), 2.2);
      const spec = Math.pow(Math.max(0, v3.dot(normal, halfVec)), 18);
      const ambient = 0.14;
      const brightness = ambient + diffuse * 0.72 + spec * 0.4 + pulse * 0.08;
      const shadeColor = mixColor(baseColor, { r: 255, g: 250, b: 240 }, spec * 0.85 + diffuse * 0.12);
      const finalColor = scaleColor(shadeColor, 0.7 + diffuse * 0.45 + pulse * 0.1);

      fb.splat(
        center.sx + dx,
        center.sy + dy,
        center.depth - nz * 0.18,
        rgb(finalColor.r, finalColor.g, finalColor.b),
        brightness,
        emissive * (0.65 + rim * 0.35),
      );
    }
  }
}

// ── Particle system ─────────────────────────────────────────────────────────

export type Particle = {
  pos: Vec3;
  vel: Vec3;
  life: number;      // remaining life (seconds)
  maxLife: number;
  char: string;
  fg: string;
  emissive: number;
};

export class ParticleSystem {
  particles: Particle[] = [];

  emit(pos: Vec3, count: number, opts: {
    speed?: number;
    life?: number;
    char?: string;
    fg?: string;
    emissive?: number;
    spread?: number;
  } = {}) {
    const speed = opts.speed ?? 0.5;
    const life = opts.life ?? 1.5;
    const spread = opts.spread ?? 1;
    for (let i = 0; i < count; i++) {
      const angle1 = Math.random() * Math.PI * 2;
      const angle2 = Math.random() * Math.PI - Math.PI / 2;
      const spd = speed * (0.3 + Math.random() * 0.7);
      this.particles.push({
        pos: { ...pos },
        vel: {
          x: Math.cos(angle1) * Math.cos(angle2) * spd * spread,
          y: Math.sin(angle2) * spd * spread * 0.5 + speed * 0.2,
          z: Math.sin(angle1) * Math.cos(angle2) * spd * spread,
        },
        life,
        maxLife: life,
        char: opts.char ?? "·",
        fg: opts.fg ?? rgb(255, 255, 255),
        emissive: opts.emissive ?? 0.5,
      });
    }
  }

  update(dt: number) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]!;
      p.pos.x += p.vel.x * dt;
      p.pos.y += p.vel.y * dt;
      p.pos.z += p.vel.z * dt;
      // Gravity
      p.vel.y -= 0.3 * dt;
      // Drag
      p.vel.x *= 1 - 0.5 * dt;
      p.vel.z *= 1 - 0.5 * dt;
      p.life -= dt;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
      }
    }
  }

  draw(fb: Framebuffer, proj: Projector) {
    for (const p of this.particles) {
      const pp = proj.project(p.pos);
      if (!pp.visible) continue;
      const lifeRatio = p.life / p.maxLife;
      fb.splat(pp.sx, pp.sy, pp.depth, p.fg, 0.2 + lifeRatio * 0.9, p.emissive * lifeRatio);
      if (lifeRatio > 0.5) {
        fb.set(pp.sx, pp.sy, lifeRatio > 0.8 ? "*" : "+", p.fg, pp.depth - 0.02, p.emissive * lifeRatio);
      }
    }
  }
}

// ── Text rendering ──────────────────────────────────────────────────────────

/** Draw a string at screen coordinates. */
export function drawText(
  fb: Framebuffer,
  x: number, y: number,
  text: string,
  fg: string,
  depth = 0,
) {
  for (let i = 0; i < text.length; i++) {
    fb.set(x + i, y, text[i]!, fg, depth);
  }
}

/** Draw a 3D-positioned label (projects to screen, renders text). */
export function drawLabel(
  fb: Framebuffer,
  proj: Projector,
  worldPos: Vec3,
  text: string,
  fg: string,
  offsetX = 2,
) {
  const p = proj.project(worldPos);
  if (!p.visible) return;
  const label = text;

  let startX = Math.round(p.sx) + offsetX;
  if (startX + text.length >= fb.width) {
    startX = Math.max(0, Math.round(p.sx) - text.length - 1);
  }

  for (let i = 0; i < label.length; i++) {
    fb.set(startX + i, Math.round(p.sy), text[i]!, fg, p.depth - 0.24);
  }
}

// ── Terminal controller ─────────────────────────────────────────────────────

export class Terminal {
  private started = false;
  private sigintHandler: (() => void) | null = null;

  get cols(): number { return process.stdout.columns || 80; }
  get rows(): number { return process.stdout.rows || 24; }

  start() {
    if (this.started) return;
    this.started = true;
    process.stdout.write("\x1b[?25l");   // hide cursor
    process.stdout.write("\x1b[2J");     // clear screen

    // Ensure terminal is restored on SIGINT/exit
    this.sigintHandler = () => {
      this.stop();
      process.exit(0);
    };
    process.on("SIGINT", this.sigintHandler);
    process.on("SIGTERM", this.sigintHandler);
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    process.stdout.write("\x1b[2J\x1b[H"); // clear screen
    process.stdout.write("\x1b[?25h");   // show cursor
    if (this.sigintHandler) {
      process.removeListener("SIGINT", this.sigintHandler);
      process.removeListener("SIGTERM", this.sigintHandler);
      this.sigintHandler = null;
    }
  }

  draw(content: string) {
    process.stdout.write(`\x1b[H${content}`);
  }
}

// ── Scene loop helper ───────────────────────────────────────────────────────

export type SceneCallbacks = {
  update: (dt: number, t: number) => void;
  render: (fb: Framebuffer, proj: Projector, t: number) => void;
  statusBar?: (t: number) => string;
};

export type SceneHandle = {
  update: (status: string) => void;
  log: (line: string) => void;
  stop: () => void;
};

export function runScene(
  camera: Camera,
  callbacks: SceneCallbacks,
  opts?: { fps?: number; maxWidth?: number; maxHeight?: number; reserveBottom?: number; logLines?: number },
): SceneHandle {
  const fps = opts?.fps ?? 24;
  const maxW = opts?.maxWidth ?? 160;
  const maxH = opts?.maxHeight ?? 50;
  const logLineCount = opts?.logLines ?? 0;
  const reserveBottom = (opts?.reserveBottom ?? 3) + logLineCount;

  const term = new Terminal();
  term.start();

  const W = Math.min(term.cols, maxW);
  const H = Math.min(term.rows - reserveBottom, maxH);
  const fb = new Framebuffer(W, H);
  const proj = new Projector(camera, W, H);

  let t = 0;
  const dt = 1 / fps;
  let statusLine = "";
  const logBuffer: string[] = [];

  const interval = setInterval(() => {
    t += dt;
    callbacks.update(dt, t);
    proj.update(camera);

    fb.clear();
    callbacks.render(fb, proj, t);

    const frame = fb.render(true);
    const status = callbacks.statusBar?.(t) ?? statusLine;

    term.draw(frame);
    // Status bar below the framebuffer
    const barY = H + 1;
    process.stdout.write(`\x1b[${barY};1H${status}\x1b[K`);

    // Log lines below the status bar
    if (logLineCount > 0) {
      const dimCode = "\x1b[2m";
      const reset = "\x1b[0m";
      for (let i = 0; i < logLineCount; i++) {
        const lineY = barY + 1 + i;
        const idx = logBuffer.length - logLineCount + i;
        const text = idx >= 0 ? logBuffer[idx]! : "";
        // Truncate to terminal width
        const truncated = text.length > W ? text.slice(0, W - 1) + "…" : text;
        process.stdout.write(`\x1b[${lineY};1H${dimCode}${truncated}${reset}\x1b[K`);
      }
    }
  }, 1000 / fps);

  return {
    update(status: string) {
      statusLine = status;
    },
    log(line: string) {
      logBuffer.push(line);
      // Keep buffer bounded
      if (logBuffer.length > 200) logBuffer.splice(0, logBuffer.length - 200);
    },
    stop() {
      clearInterval(interval);
      term.stop();
    },
  };
}
