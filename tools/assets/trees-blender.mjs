#!/usr/bin/env node
// Dump raw mesh data out of a Poly Haven .blend with a headless Blender (data only, nothing is executed from the file).
//
//   node tools/assets/trees-blender.mjs <id> "<regex>" ["<regex>" ...] [--list]
//
// - Opens assets-src/trees/_blend/<id>/<id>_1k.blend with  --factory-startup --disable-autoexec  (no add-ons, no
//   embedded scripts / drivers), evaluates every MESH/CURVE object whose name matches one of the regexes (modifiers
//   and geometry nodes applied) and writes  assets-src/trees/_dump/<id>/<object>.json + .bin .
// - --list only prints the objects (name, type, evaluated triangle count).
//
// Why Blender: the glTF downloads contain only the multi-million-triangle LOD0. The artist's card-based LOD1/LOD2
// meshes and the twig prototypes exist only inside the .blend. Blender is NOT an npm dependency; set BLENDER=/path
// if it is not at /Applications/Blender.app/Contents/MacOS/Blender. (Tested with Blender 5.0.0.)
//
// .bin layout (little endian), in this order, sizes are given in the .json:
//   position   float32 x3 per vertex      (Blender object space, Z up, metres)
//   cornerVert int32  per corner
//   polyStart  int32  per polygon         (first corner of the polygon; polygons are convex quads / tris / ngons)
//   polyCount  int32  per polygon
//   polyMat    int32  per polygon         (index into json.materials)
//   uv         float32 x2 per corner      (only if json.hasUV)
//   normal     float32 x3 per corner      (Blender's evaluated corner normals)
//   color      float32 x4 per corner      (only if json.hasColor; attribute "Col", linear)

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve( import.meta.dirname, '../..' );
const BLENDER = process.env.BLENDER || '/Applications/Blender.app/Contents/MacOS/Blender';

const PY = String.raw`
import bpy, sys, json, os, re
import numpy as np

argv = sys.argv[sys.argv.index('--') + 1:]
out_dir = argv[0]
list_only = argv[1] == '1'
patterns = [re.compile(p) for p in argv[2:]]
os.makedirs(out_dir, exist_ok=True)
deps = bpy.context.evaluated_depsgraph_get()

def safe(name):
    return re.sub(r'[^A-Za-z0-9_.-]', '_', name)

for o in sorted(bpy.data.objects, key=lambda o: o.name):
    if o.type not in ('MESH', 'CURVE'):
        continue
    if not any(p.search(o.name) for p in patterns):
        continue
    oe = o.evaluated_get(deps)
    me = oe.to_mesh()
    nv, nc, npoly = len(me.vertices), len(me.loops), len(me.polygons)
    tris = nc - 2 * npoly
    print(f"DUMP '{o.name}' type={o.type} verts={nv} corners={nc} polys={npoly} tris={tris}")
    if list_only or nv == 0:
        oe.to_mesh_clear()
        continue
    pos = np.empty(nv * 3, dtype=np.float32)
    me.attributes['position'].data.foreach_get('vector', pos)
    cv = np.empty(nc, dtype=np.int32)
    me.loops.foreach_get('vertex_index', cv)
    ps = np.empty(npoly, dtype=np.int32)
    pc = np.empty(npoly, dtype=np.int32)
    pm = np.empty(npoly, dtype=np.int32)
    me.polygons.foreach_get('loop_start', ps)
    me.polygons.foreach_get('loop_total', pc)
    me.polygons.foreach_get('material_index', pm)
    uv = None
    a = me.attributes.get('UVMap')
    if a is None:
        for cand in me.attributes:
            if cand.domain == 'CORNER' and cand.data_type in ('FLOAT2', 'FLOAT_VECTOR') and not cand.name.startswith('.'):
                a = cand
                break
    if a is not None and a.domain == 'CORNER':
        if a.data_type == 'FLOAT2':
            uv = np.empty(nc * 2, dtype=np.float32)
            a.data.foreach_get('vector', uv)
        elif a.data_type == 'FLOAT_VECTOR':
            tmp = np.empty(nc * 3, dtype=np.float32)
            a.data.foreach_get('vector', tmp)
            uv = np.ascontiguousarray(tmp.reshape(-1, 3)[:, :2]).reshape(-1)
    nor = np.empty(nc * 3, dtype=np.float32)
    me.corner_normals.foreach_get('vector', nor)
    col = None
    c = me.attributes.get('Col')
    if c is not None and c.data_type in ('FLOAT_COLOR', 'BYTE_COLOR'):
        n = nv if c.domain == 'POINT' else nc
        tmp = np.empty(n * 4, dtype=np.float32)
        c.data.foreach_get('color', tmp)
        tmp = tmp.reshape(-1, 4)
        if c.domain == 'POINT':
            tmp = tmp[cv]
        if c.domain in ('POINT', 'CORNER'):
            col = np.ascontiguousarray(tmp, dtype=np.float32).reshape(-1)
    extra = {}
    for a2 in me.attributes:
        if a2.name in ('Group',) and a2.domain == 'POINT' and a2.data_type == 'FLOAT':
            tmp = np.empty(nv, dtype=np.float32)
            a2.data.foreach_get('value', tmp)
            extra[a2.name] = [float(tmp.min()), float(tmp.max())]
    base = os.path.join(out_dir, safe(o.name))
    with open(base + '.bin', 'wb') as f:
        f.write(pos.tobytes()); f.write(cv.tobytes()); f.write(ps.tobytes()); f.write(pc.tobytes()); f.write(pm.tobytes())
        if uv is not None: f.write(uv.tobytes())
        f.write(nor.tobytes())
        if col is not None: f.write(col.tobytes())
    meta = {
        'name': o.name, 'type': o.type, 'vertices': nv, 'corners': nc, 'polygons': npoly, 'triangles': tris,
        'hasUV': uv is not None, 'hasColor': col is not None,
        'materials': [m.name if m else None for m in me.materials],
        'location': list(o.location), 'rotation': list(o.rotation_euler), 'scale': list(o.scale),
        'matrixWorld': [list(r) for r in o.matrix_world],
        'collections': [c2.name for c2 in o.users_collection],
        'modifiers': [m.type + (':' + m.node_group.name if m.type == 'NODES' and m.node_group else '') for m in o.modifiers],
        'extra': extra,
    }
    with open(base + '.json', 'w') as f:
        json.dump(meta, f, indent=1)
    oe.to_mesh_clear()
print('DUMP-DONE')
`;

const args = process.argv.slice( 2 );
const listOnly = args.includes( '--list' );
const rest = args.filter( ( a ) => a !== '--list' );
const id = rest[ 0 ];
const patterns = rest.slice( 1 );
if ( ! id || patterns.length === 0 ) {

	console.error( 'usage: node tools/assets/trees-blender.mjs <id> "<regex>" ["<regex>" ...] [--list]' );
	process.exit( 2 );

}

const blend = join( ROOT, 'assets-src/trees/_blend', id, id + '_1k.blend' );
if ( ! existsSync( blend ) ) throw new Error( 'missing ' + blend + ' (run trees-fetch.mjs <id> --no-model --blend)' );
if ( ! existsSync( BLENDER ) ) throw new Error( 'Blender not found at ' + BLENDER + ' (set BLENDER=...)' );
const outDir = join( ROOT, 'assets-src/trees/_dump', id );
mkdirSync( outDir, { recursive: true } );
// the python source lives in a private temp dir (never inside a download directory); Blender is started with a
// neutral working directory and gets every path as an argument.
const work = join( tmpdir(), 'alpenglow-trees-blender' );
mkdirSync( work, { recursive: true } );
const script = join( work, 'dump.py' );
writeFileSync( script, PY );
const out = execFileSync( BLENDER, [ '--factory-startup', '--disable-autoexec', '-b', blend, '--python', script, '--', outDir, listOnly ? '1' : '0', ...patterns ], { cwd: work, encoding: 'utf8', maxBuffer: 1 << 26, stdio: [ 'ignore', 'pipe', 'pipe' ] } );
const lines = out.split( '\n' ).filter( ( l ) => l.startsWith( 'DUMP' ) );
console.log( lines.join( '\n' ) );
if ( ! out.includes( 'DUMP-DONE' ) ) {

	console.log( out.split( '\n' ).slice( - 40 ).join( '\n' ) );
	process.exit( 1 );

}
