#!/usr/bin/env python3
"""
the deNURBurator (tm) -- v1.0.0 "BOG STANDARD"

Violently rips B-rep NURBS geometry out of SolidWorks .step files,
beats it flat into honest triangles, and renders the wreckage as a
rotating, z-buffered, lambert-shaded ASCII mesh in your terminal.

USAGE
    python denurburator.py bracket.step
    python denurburator.py huge_assembly.step --scale 0.6 --max-faces 3000
    python denurburator.py tiny_actuator.step --scale 1.4
    python denurburator.py --demo                  # built-in nitinol coil
    python denurburator.py --demo --dump 3         # no curses, print 3 frames

DEPENDENCIES
    required:  numpy
    STEP i/o:  trimesh + cascadio   (pip install trimesh cascadio)
        or:    cadquery             (pip install cadquery)
    windows:   windows-curses       (pip install windows-curses)

CONTROLS (inside the render loop)
    q / ESC      flee the swamp
    space        pause rotation
    + / -        zoom in / out
    arrow keys   adjust yaw & pitch spin rates
    r            reset camera and spin

https://peterjamesvilla.com/denurburator
contact: hello@peterjamesvilla.com
"""

import argparse
import math
import sys
import time

import numpy as np

# Density ramp: leftmost = void, rightmost = fully lit. The classic.
SHADES = " .,-~:;=!*#$@"
SHADE_ARR = np.array(list(SHADES))
N_SHADES = len(SHADES)

# Fixed key light, pointing from the upper-left, slightly toward camera.
LIGHT = np.array([-0.45, 0.65, -0.62])
LIGHT = LIGHT / np.linalg.norm(LIGHT)


# ─────────────────────────────────────────────────────────────────────
#  STEP INGESTION — where the NURBS are ripped
# ─────────────────────────────────────────────────────────────────────

def load_step(path, tol):
    """Parse a STEP file and force-tessellate its B-rep into triangles.

    Tries trimesh (which routes STEP through cascadio/OpenCascade),
    then falls back to cadquery's native tessellator. Either way the
    parametric surfaces do not survive the encounter.
    """
    attempts = []

    try:
        import trimesh
        m = trimesh.load(path, force="mesh")
        V = np.asarray(m.vertices, dtype=np.float64)
        F = np.asarray(m.faces, dtype=np.int64)
        if len(F) == 0:
            raise ValueError("tessellation produced zero faces")
        return V, F
    except Exception as e:  # noqa: BLE001 - report every failed ritual
        attempts.append(f"  trimesh/cascadio: {type(e).__name__}: {e}")

    try:
        import cadquery as cq
        wp = cq.importers.importStep(path)
        verts, faces, offset = [], [], 0
        for solid in wp.vals():
            vs, fs = solid.tessellate(tol)
            verts.append(np.array([(v.x, v.y, v.z) for v in vs], dtype=np.float64))
            faces.append(np.asarray(fs, dtype=np.int64) + offset)
            offset += len(vs)
        if not faces:
            raise ValueError("STEP file contained no solids")
        return np.vstack(verts), np.vstack(faces)
    except Exception as e:  # noqa: BLE001
        attempts.append(f"  cadquery: {type(e).__name__}: {e}")

    sys.exit(
        "deNURBurator could not extract geometry from %r.\n"
        "Attempted rituals:\n%s\n\n"
        "Install a STEP backend:\n"
        "    pip install trimesh cascadio      (lightweight)\n"
        "    pip install cadquery              (heavyweight, full OCC)\n"
        % (path, "\n".join(attempts))
    )


def demo_mesh():
    """Built-in victim: a nitinol actuator coil (helical tube), so the
    tool can be demonstrated without owning a single CAD license."""
    turns, R, r, pitch = 4.5, 1.0, 0.28, 0.55
    n_u, n_v = 110, 9

    u = np.linspace(0.0, turns * 2.0 * np.pi, n_u)
    v = np.linspace(0.0, 2.0 * np.pi, n_v, endpoint=False)

    # Helix centreline and its Frenet-ish frame.
    C = np.stack([R * np.cos(u), R * np.sin(u), u * pitch / (2.0 * np.pi)], axis=1)
    T = np.stack([-R * np.sin(u), R * np.cos(u),
                  np.full_like(u, pitch / (2.0 * np.pi))], axis=1)
    T /= np.linalg.norm(T, axis=1, keepdims=True)
    N1 = np.cross(T, np.array([0.0, 0.0, 1.0]))
    N1 /= np.linalg.norm(N1, axis=1, keepdims=True)
    N2 = np.cross(T, N1)

    ring = (np.cos(v)[None, :, None] * N1[:, None, :]
            + np.sin(v)[None, :, None] * N2[:, None, :])
    V = (C[:, None, :] + r * ring).reshape(-1, 3)

    faces = []
    for i in range(n_u - 1):
        for j in range(n_v):
            a = i * n_v + j
            b = i * n_v + (j + 1) % n_v
            c = (i + 1) * n_v + j
            d = (i + 1) * n_v + (j + 1) % n_v
            faces.append((a, b, c))
            faces.append((b, d, c))
    return V, np.asarray(faces, dtype=np.int64)


def enforce_face_budget(V, F, max_faces):
    """Large assemblies get decimated. Politely if fast-simplification
    is installed; with a random cleaver if it is not."""
    if len(F) <= max_faces:
        return V, F
    try:
        import trimesh
        m = trimesh.Trimesh(vertices=V, faces=F, process=False)
        s = m.simplify_quadric_decimation(max_faces)
        if 0 < len(s.faces) <= max_faces * 1.2:
            return (np.asarray(s.vertices, dtype=np.float64),
                    np.asarray(s.faces, dtype=np.int64))
    except Exception:  # noqa: BLE001 - the cleaver it is
        pass
    keep = np.random.default_rng(42).choice(len(F), max_faces, replace=False)
    return V, F[keep]


def prepare(V, F):
    """Centre the part, normalise it to unit radius, precompute unit
    face normals, and drop degenerate slivers."""
    lo, hi = V.min(axis=0), V.max(axis=0)
    V = V - (lo + hi) / 2.0
    radius = np.linalg.norm(V, axis=1).max()
    V = V / max(radius, 1e-12)

    e1 = V[F[:, 1]] - V[F[:, 0]]
    e2 = V[F[:, 2]] - V[F[:, 0]]
    N = np.cross(e1, e2)
    mag = np.linalg.norm(N, axis=1)
    ok = mag > 1e-12
    F, N, mag = F[ok], N[ok], mag[ok]
    N = N / mag[:, None]
    return V, F, N


# ─────────────────────────────────────────────────────────────────────
#  THE ENGINE — raw numpy: rotate, project, z-buffer, shade
# ─────────────────────────────────────────────────────────────────────

def rotation_matrix(ax, ay):
    ca, sa = math.cos(ax), math.sin(ax)
    cb, sb = math.cos(ay), math.sin(ay)
    Rx = np.array([[1, 0, 0], [0, ca, -sa], [0, sa, ca]])
    Ry = np.array([[cb, 0, sb], [0, 1, 0], [-sb, 0, cb]])
    return Ry @ Rx


def render_frame(V, F, N, ax, ay, w, h, scale, distance):
    """One full frame: rotate the mesh, perspective-project it onto a
    w x h character grid, z-buffer every triangle, and shade each face
    by the dot product of its normal against the fixed light vector.

    Returns a list of h strings, each exactly w characters wide.
    """
    R = rotation_matrix(ax, ay)
    rv = V @ R.T                       # rotated vertices  (n, 3)
    rn = N @ R.T                       # rotated normals   (m, 3)

    # STEP tessellations arrive with feral winding order, so instead of
    # trusting it we flip every normal to face the camera and let the
    # z-buffer sort out occlusion.
    flip = np.where(rn[:, 2] > 0.0, -1.0, 1.0)
    rn = rn * flip[:, None]

    intensity = np.clip(rn @ LIGHT, 0.0, 1.0)
    shade_idx = np.clip(
        np.rint((0.08 + 0.92 * intensity) * (N_SHADES - 1)),
        1, N_SHADES - 1).astype(np.int8)

    # Perspective projection. Camera sits at z = -distance looking +z.
    depth = rv[:, 2] + distance
    depth = np.maximum(depth, 1e-3)
    K = 0.42 * distance * min(h, w / 2.0) * scale
    sx = rv[:, 0] / depth * K * 2.0 + w / 2.0   # x2: terminal cells are tall
    sy = -rv[:, 1] / depth * K + h / 2.0

    zbuf = np.full((h, w), np.inf, dtype=np.float64)
    cidx = np.zeros((h, w), dtype=np.int8)      # 0 == ' ' == the void

    # Front-to-back order: fragments of hidden faces then lose the
    # depth test immediately, which keeps big assemblies interactive.
    order = np.argsort(depth[F].min(axis=1))

    for fi in order:
        i0, i1, i2 = F[fi]
        x0, y0, d0 = sx[i0], sy[i0], depth[i0]
        x1, y1, d1 = sx[i1], sy[i1], depth[i1]
        x2, y2, d2 = sx[i2], sy[i2], depth[i2]

        xa = max(int(math.floor(min(x0, x1, x2))), 0)
        xb = min(int(math.ceil(max(x0, x1, x2))), w - 1)
        ya = max(int(math.floor(min(y0, y1, y2))), 0)
        yb = min(int(math.ceil(max(y0, y1, y2))), h - 1)
        if xa > xb or ya > yb:
            continue

        denom = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        if abs(denom) < 1e-9:
            continue

        gx = np.arange(xa, xb + 1, dtype=np.float64)[None, :]
        gy = np.arange(ya, yb + 1, dtype=np.float64)[:, None]
        w0 = ((y1 - y2) * (gx - x2) + (x2 - x1) * (gy - y2)) / denom
        w1 = ((y2 - y0) * (gx - x2) + (x0 - x2) * (gy - y2)) / denom
        w2 = 1.0 - w0 - w1

        inside = (w0 >= -1e-6) & (w1 >= -1e-6) & (w2 >= -1e-6)
        if not inside.any():
            continue

        zsub = zbuf[ya:yb + 1, xa:xb + 1]
        frag_z = w0 * d0 + w1 * d1 + w2 * d2
        wins = inside & (frag_z < zsub)
        if not wins.any():
            continue
        zsub[wins] = frag_z[wins]
        cidx[ya:yb + 1, xa:xb + 1][wins] = shade_idx[fi]

    return ["".join(SHADE_ARR[cidx[y]]) for y in range(h)]


# ─────────────────────────────────────────────────────────────────────
#  THE LOOP — curses, 30 FPS, no flicker
# ─────────────────────────────────────────────────────────────────────

def run_loop(stdscr, V, F, N, args, label):
    import curses
    curses.curs_set(0)
    stdscr.nodelay(True)
    green = mag = 0
    if curses.has_colors():
        curses.start_color()
        curses.use_default_colors()
        curses.init_pair(1, curses.COLOR_GREEN, -1)
        curses.init_pair(2, curses.COLOR_MAGENTA, -1)
        green, mag = curses.color_pair(1), curses.color_pair(2)

    ax, ay = 0.35, 0.0
    yaw_rate, pitch_rate = 0.050, 0.021
    scale = args.scale
    paused = False
    frame_budget = 1.0 / max(args.fps, 1)
    fps_ema = float(args.fps)

    while True:
        t0 = time.perf_counter()

        c = stdscr.getch()
        if c in (ord("q"), ord("Q"), 27):
            break
        elif c == ord(" "):
            paused = not paused
        elif c in (ord("+"), ord("=")):
            scale = min(scale * 1.12, 20.0)
        elif c in (ord("-"), ord("_")):
            scale = max(scale / 1.12, 0.05)
        elif c == curses.KEY_RIGHT:
            yaw_rate += 0.01
        elif c == curses.KEY_LEFT:
            yaw_rate -= 0.01
        elif c == curses.KEY_UP:
            pitch_rate += 0.005
        elif c == curses.KEY_DOWN:
            pitch_rate -= 0.005
        elif c in (ord("r"), ord("R")):
            ax, ay = 0.35, 0.0
            yaw_rate, pitch_rate = 0.050, 0.021
            scale = args.scale

        h, w = stdscr.getmaxyx()
        if h < 4 or w < 20:
            time.sleep(0.1)
            continue

        lines = render_frame(V, F, N, ax, ay, w, h - 1, scale, args.distance)

        stdscr.erase()
        for y, line in enumerate(lines):
            try:
                stdscr.addnstr(y, 0, line, w, green)
            except curses.error:
                pass  # bottom-right cell always complains; ignore it

        status = (f" deNURBurator ░ {label} ░ {len(F)} tris "
                  f"░ {fps_ema:4.1f} fps ░ zoom {scale:.2f} "
                  f"░ [q]uit [space]pause [+/-]zoom [arrows]spin [r]eset")
        try:
            stdscr.addnstr(h - 1, 0, status.ljust(w - 1), w - 1,
                           mag | curses.A_REVERSE)
        except curses.error:
            pass
        stdscr.refresh()

        if not paused:
            ay += yaw_rate
            ax += pitch_rate

        elapsed = time.perf_counter() - t0
        if elapsed < frame_budget:
            time.sleep(frame_budget - elapsed)
        fps_ema = 0.9 * fps_ema + 0.1 / max(time.perf_counter() - t0, 1e-6)


# ─────────────────────────────────────────────────────────────────────

def parse_args():
    p = argparse.ArgumentParser(
        prog="denurburator",
        description="Rip NURBS out of a STEP file; render rotating ASCII.",
        epilog="Zoom guidance: sprawling assemblies want --scale 0.5-0.8; "
               "a lone nitinol actuator deserves --scale 1.2-2.0.")
    p.add_argument("step_file", nargs="?", help="path to a .step / .stp file")
    p.add_argument("--demo", action="store_true",
                   help="skip CAD entirely; render the built-in nitinol coil")
    p.add_argument("--scale", type=float, default=1.0,
                   help="zoom multiplier after auto-fit (default 1.0)")
    p.add_argument("--fps", type=int, default=30,
                   help="target frames per second (default 30)")
    p.add_argument("--distance", type=float, default=3.0,
                   help="camera distance in part-radii (default 3.0)")
    p.add_argument("--max-faces", type=int, default=1800,
                   help="decimation budget for big assemblies (default 1800)")
    p.add_argument("--tol", type=float, default=0.8,
                   help="tessellation tolerance for cadquery backend; "
                        "bigger = chunkier = more violent (default 0.8)")
    p.add_argument("--dump", type=int, metavar="N", default=0,
                   help="render N frames to stdout without curses and exit")
    p.add_argument("--size", metavar="WxH", default="80x24",
                   help="frame size for --dump mode (default 80x24)")
    return p.parse_args()


def main():
    args = parse_args()

    if args.demo:
        V, F = demo_mesh()
        label = "NITINOL-COIL (built-in)"
    elif args.step_file:
        V, F = load_step(args.step_file, args.tol)
        label = args.step_file
    else:
        sys.exit("Feed me a .step file, or run with --demo. See --help.")

    V, F = enforce_face_budget(V, F, args.max_faces)
    V, F, N = prepare(V, F)

    if args.dump > 0:
        try:
            w, h = (int(t) for t in args.size.lower().split("x"))
        except ValueError:
            sys.exit("--size wants WxH, e.g. --size 100x30")
        for k in range(args.dump):
            lines = render_frame(V, F, N, 0.35 + k * 0.021, k * 0.05,
                                 w, h, args.scale, args.distance)
            sys.stdout.write("\n".join(lines) + "\n")
            if k < args.dump - 1:
                sys.stdout.write("─" * w + "\n")
        return

    try:
        import curses
    except ImportError:
        sys.exit("curses missing. On Windows: pip install windows-curses")
    curses.wrapper(run_loop, V, F, N, args, label)


if __name__ == "__main__":
    main()
