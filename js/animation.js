/*
 * Hero backdrop: a wide hex landscape seen from high up and far off. A plain in
 * front, rolling hills, a hazy basin, then a mountain range whose ridge line
 * stands against a dark sky. One height field, one column type, one draw.
 *
 * Projection
 *   Pinhole camera 96 units above the floor, pitched down 21 degrees, so the
 *   ground runs from the bottom edge up to a ridge line in the top quarter and
 *   the sky is whatever is left. Rows run far to near, which is painter order.
 *
 * Terrain
 *   Minecraft-shaped noise: domain warp, continentalness, erosion and two ridged
 *   terms, all read through curves. A profile in z turns the field into plain ->
 *   hills -> basin -> range, so the ground is composed rather than speckled.
 *
 * Drawing
 *   The scene never animates: it is painted once and repainted on resize. Each
 *   row draws its wall faces first, batched by height class and shade, then its
 *   tops batched into one path per colour band. Adjacent columns of a band merge
 *   into a single fill and the walls sit behind them, so no seam of backdrop can
 *   show anywhere in the picture.
 */

(function () {
    'use strict';

    var canvas = document.getElementById('c');
    if (!canvas) {
        return;
    }

    var ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) {
        return;
    }

    var TAU = Math.PI * 2;

    /* ---------------- world scale ---------------- */
    var R = 3.7;                    // column circumradius
    var CELLW = Math.sqrt(3) * R;   // flat-to-flat: the lattice pitch
    var ROWSTEP = 1.5 * R;          // row pitch in depth
    var CAM_Y = 170;                // eye height above the floor
    var TAN_PITCH = 0.50;           // 27 degrees down: hexes keep their shape
    var Z_NEAR = 112;               // nearest row, already below the bottom edge
    var Z_FAR = 700;                // last row, on the range's crest
    var HMAX = 155;                 // peak clamp
    var QUANT = 2.6;                // one terrace step, in world units

    var BACKDROP = 'rgb(3,8,11)';

    /* Hole audit switch. When true the frame is painted magenta and the sky and
     * title gradients are skipped, so every pixel the terrain does not cover is
     * unmistakable. Flip it to true, render, flood-fill the borders, then set it
     * back to false: the live backdrop is never magenta. */
    var DEBUG_HOLES = false;
    var DEBUG_FILL = 'rgb(255,0,255)';

    /* ---------------- palette shape ---------------- */
    var NB = 18;                    // height steps for tops
    var NSUB = 3;                   // tone steps inside each height step
    var NBANDS = NB * NSUB;
    var NF = 40;                    // fog steps: enough that a step is invisible
    var NC = 8;                     // height classes for wall faces
    var AMBER = NBANDS;             // the one band that is not a height
    var FOG_MAX = 0.56;             // aerial perspective never fully hides a ridge

    var HAZE = [46, 80, 96];        // what distance turns stone into

    var SKY_T = [0, 0.3, 0.55, 0.75, 1];
    var SKY_C = [
        [4, 9, 13],
        [5, 13, 18],
        [9, 23, 30],
        [15, 36, 46],
        [22, 52, 66]
    ];

    /* Pointy-top template: a vertex every 60 degrees starting at 30, so the
     * edges at x = +-0.866 are vertical and the pitch is sqrt(3) R. */
    var HEX_X = new Float32Array(6);
    var HEX_Z = new Float32Array(6);
    /* Outward normal of edge k -> k+1. The edge midpoints sit at 60(k+1)
     * degrees, so the normal is the unit vector at that angle. */
    var HEX_NX = new Float32Array(6);
    var HEX_NZ = new Float32Array(6);
    (function () {
        for (var i = 0; i < 6; i++) {
            var a = i * TAU / 6 + TAU / 12;
            HEX_X[i] = Math.cos(a);
            HEX_Z[i] = Math.sin(a);
            var na = i * TAU / 6 + TAU / 6;
            HEX_NX[i] = Math.cos(na);
            HEX_NZ[i] = Math.sin(na);
        }
    })();

    /* Neighbour across edge k: which row (-1 farther, 0 same, +1 nearer), which
     * side, and which shade that face takes. The normal table above decides
     * which of the six are drawn; this only says where to look once it has. */
    var ENB_ROW = new Int8Array([-1, -1, 0, 1, 1, 0]);
    var ENB_SIDE = new Int8Array([1, -1, -1, -1, 1, 1]);
    var ENB_SHADE = new Uint8Array([1, 0, 0, 0, 1, 1]);

    /* ------------------------------------------------------------------ *
     * Noise. Original hash and value noise; no tables, no allocation.
     * ------------------------------------------------------------------ */
    function ihash(x, y, seed) {
        var n = Math.imul(x | 0, 0x27d4eb2d) ^
            Math.imul(y | 0, 0x165667b1) ^
            Math.imul(seed | 0, 0x9e3779b1);
        n = Math.imul(n ^ (n >>> 15), 0x85ebca6b);
        n = Math.imul(n ^ (n >>> 13), 0xc2b2ae35);
        return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
    }

    function vnoise(x, y, seed) {
        var xi = Math.floor(x);
        var yi = Math.floor(y);
        var xf = x - xi;
        var yf = y - yi;
        var u = xf * xf * (3 - 2 * xf);
        var v = yf * yf * (3 - 2 * yf);
        var a = ihash(xi, yi, seed);
        var b = ihash(xi + 1, yi, seed);
        var c = ihash(xi, yi + 1, seed);
        var d = ihash(xi + 1, yi + 1, seed);
        var ab = a + (b - a) * u;
        var cd = c + (d - c) * u;
        return ab + (cd - ab) * v;
    }

    function fbm(x, y, seed, oct) {
        var sum = 0;
        var amp = 1;
        var norm = 0;
        var freq = 1;
        for (var i = 0; i < oct; i++) {
            sum += amp * vnoise(x * freq, y * freq, seed + i * 137);
            norm += amp;
            amp *= 0.5;
            freq *= 2.03;
        }
        return sum / norm;
    }

    /* Ridged: value noise folded at its midpoint, so crests are sharp and the
     * ground between them is wide. */
    function ridged(x, y, seed) {
        return 1 - Math.abs(2 * fbm(x, y, seed, 3) - 1);
    }

    /* Smooth curve through control points. The control arrays are module
     * constants; this runs once per column and must not build anything. */
    function curve(t, kx, ky) {
        var last = kx.length - 1;
        if (t <= kx[0]) {
            return ky[0];
        }
        if (t >= kx[last]) {
            return ky[last];
        }
        for (var i = 1; i <= last; i++) {
            if (t <= kx[i]) {
                var span = kx[i] - kx[i - 1];
                var u = span > 1e-6 ? (t - kx[i - 1]) / span : 0;
                return ky[i - 1] + (ky[i] - ky[i - 1]) * (u * u * (3 - 2 * u));
            }
        }
        return ky[last];
    }

    var CONT_X = [0.30, 0.52, 0.72];
    var CONT_Y = [0.42, 1.00, 0.60];
    var ERO_X = [0.34, 0.60, 0.80];
    var ERO_Y = [1.00, 0.72, 0.38];
    var HILL_X = [230, 262, 300, 340];
    var HILL_Y = [0, 1.1, 0.9, 0];
    var VALLEY_X = [330, 370, 450, 500];
    var VALLEY_Y = [0, 1, 1, 0.35];
    var MTN_X = [430, 500, 585, 690];
    var MTN_Y = [0, 0.45, 0.95, 0.86];

    /* ------------------------------------------------------------------ *
     * The height field. Everything the picture needs comes out of here:
     * flat ground, one mid ridge, a valley floor, then the range.
     * ------------------------------------------------------------------ */
    function heightAt(x, z) {
        // Domain warp, so no feature reads as a plain noise blob.
        var wx = x + 45 * (fbm(x * 0.0032, z * 0.0032, 11, 2) - 0.5);
        var wz = z + 45 * (fbm(x * 0.0032, z * 0.0032, 23, 2) - 0.5);

        var cont = fbm(wx * 0.0022, wz * 0.0022, 31, 3);
        var ero = fbm(wx * 0.0055, wz * 0.0055, 41, 2);
        var pv = ridged(wx * 0.0095, wz * 0.0095, 51);   // individual ridges
        var pv2 = ridged(wx * 0.0038, wz * 0.0038, 59);  // how the ridges group

        var upland = curve(cont, CONT_X, CONT_Y);
        var sharp = curve(ero, ERO_X, ERO_Y);

        // The floor: a broad swell plus one finer set of mounds. Two scales, no
        // high-frequency noise: enough to put a terrace edge every few columns,
        // not enough to turn the foreground into a contour carpet.
        var ground = 6.0 + 30 * (fbm(wx * 0.0042, wz * 0.0042, 71, 2) - 0.5) +
            22 * (fbm(wx * 0.0135, wz * 0.0135, 77, 2) - 0.5);

        // The mid ridge that closes the foreground and hides the valley's foot.
        var hills = curve(wz, HILL_X, HILL_Y) *
            (7 + 26 * (fbm(wx * 0.0115, wz * 0.0115, 61, 2) - 0.26));

        // The valley floor: flat, a few units below the plain.
        var valley = curve(wz, VALLEY_X, VALLEY_Y);

        // The range: a massif base with ridgelines on it. Squaring the ridge
        // term deepens the ground between crests so they read as peaks.
        var m = curve(wz, MTN_X, MTN_Y);
        var ridge = (0.16 + 0.84 * pv * pv) * (0.42 + 0.58 * pv2) * sharp;
        var mtn = m * (40 + 130 * ridge * upland);

        var h = ground + (hills > 0 ? hills : 0) - valley * 3 + mtn;
        if (h < 0.2) {
            h = 0.2;
        } else if (h > HMAX) {
            h = HMAX;
        }
        return h;
    }

    /* ------------------------------------------------------------------ *
     * Palette. Colour is a continuous function of height through one ramp; fog
     * mixes it toward the haze as distance grows.
     * ------------------------------------------------------------------ */
    var PAL_U = [0, 0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.78, 0.86, 0.92, 1];
    var PAL_C = [
        [22, 57, 61],       // lowland: deep teal
        [25, 62, 61],
        [29, 68, 62],
        [36, 79, 64],       // wet green
        [42, 80, 62],       // lit hill
        [44, 70, 61],
        [40, 55, 62],       // slate
        [31, 39, 57],       // carbon
        [56, 74, 98],       // cold rock
        [120, 160, 184],    // bare cyan stone
        [176, 210, 226],    // snow
        [236, 250, 254]     // lit cap
    ];
    var AMBER_C = [182, 108, 36];
    var TONE = [0.94, 1, 1.07];

    var topLut = [];                // (NBANDS + 1) * NF colour strings
    var topEdge = [];               // the same, a touch darker: the hex seam
    var wallLit = [];               // NC * NF
    var wallDark = [];              // NC * NF

    var cTmp = [0, 0, 0];

    function skyAt(t, out) {
        var last = SKY_T.length - 1;
        var i;
        if (t <= 0) {
            t = 0;
        } else if (t >= 1) {
            t = 1;
        }
        for (i = 1; i <= last; i++) {
            if (t <= SKY_T[i]) {
                var a = SKY_C[i - 1];
                var b = SKY_C[i];
                var k = (t - SKY_T[i - 1]) / (SKY_T[i] - SKY_T[i - 1]);
                out[0] = a[0] + (b[0] - a[0]) * k;
                out[1] = a[1] + (b[1] - a[1]) * k;
                out[2] = a[2] + (b[2] - a[2]) * k;
                return;
            }
        }
        out[0] = SKY_C[last][0];
        out[1] = SKY_C[last][1];
        out[2] = SKY_C[last][2];
    }

    function css(r, g, b) {
        r = r < 0 ? 0 : r > 255 ? 255 : r | 0;
        g = g < 0 ? 0 : g > 255 ? 255 : g | 0;
        b = b < 0 ? 0 : b > 255 ? 255 : b | 0;
        return 'rgb(' + r + ',' + g + ',' + b + ')';
    }

    function paletteAt(u, out) {
        var last = PAL_U.length - 1;
        var i;
        if (u <= 0) {
            u = 0;
        } else if (u >= 1) {
            u = 1;
        }
        for (i = 1; i <= last; i++) {
            if (u <= PAL_U[i]) {
                var a = PAL_C[i - 1];
                var b = PAL_C[i];
                var k = (u - PAL_U[i - 1]) / (PAL_U[i] - PAL_U[i - 1]);
                out[0] = a[0] + (b[0] - a[0]) * k;
                out[1] = a[1] + (b[1] - a[1]) * k;
                out[2] = a[2] + (b[2] - a[2]) * k;
                return;
            }
        }
        out[0] = PAL_C[last][0];
        out[1] = PAL_C[last][1];
        out[2] = PAL_C[last][2];
    }

    /* ------------------------------------------------------------------ *
     * View state.
     * ------------------------------------------------------------------ */
    var W = 0;
    var H = 0;
    var cx = 0;
    var cy = 0;
    var f = 0;
    var pcos = 1;
    var psin = 0;
    var farY = 0;

    /* ------------------------------------------------------------------ *
     * The field, flat typed arrays: one height per column, row bookkeeping
     * beside it. Built per size, drawn from, never rebuilt while drawing.
     * ------------------------------------------------------------------ */
    var rowN = 0;
    var rowZ = null;
    var rowShift = null;
    var rowStart = null;
    var rowCount = null;
    var rowBase = null;
    var rowFog = null;
    var celH = null;
    var celAmber = null;

    /* Scratch for one row: six projected corners per column, the counting sort
     * that batches tops by band, and one quad buffer per wall class and shade. */
    var MAXROW = 0;
    var rowTX = null;
    var rowTY = null;
    var rowBand = null;
    var rowHband = null;
    var order = null;
    var bucket = null;
    var wallX = null;
    var wallY = null;
    var wallN = null;

    var skyGrad = null;
    var titleGrad = null;
    var titleY0 = 0;
    var titleY1 = 0;

    /* ------------------------------------------------------------------ *
     * Build the field for the current viewport: rows far to near, each row as
     * wide as the frame needs at its own depth, plus two columns of margin, so
     * no row can end inside the picture.
     * ------------------------------------------------------------------ */
    function buildField() {
        var rows = ((((Z_FAR - Z_NEAR) / ROWSTEP) | 0) + 2);
        rowZ = new Float32Array(rows);
        rowShift = new Float32Array(rows);
        rowStart = new Int32Array(rows);
        rowCount = new Int32Array(rows);
        rowBase = new Int32Array(rows);
        rowFog = new Uint8Array(rows);

        var r, cols, total = 0, widest = 0;
        rowN = 0;
        for (r = 0; r < rows; r++) {
            var z = Z_FAR - r * ROWSTEP;
            if (z < Z_NEAR) {
                break;
            }
            // Widest the frame can reach at this depth: the corner sits on the
            // far plane of the row, which is where the extent is greatest.
            cols = Math.ceil(((W * 0.5) * (z * pcos + CAM_Y * psin) / f + CELLW * 2) / CELLW) + 2;
            rowZ[rowN] = z;
            rowShift[rowN] = (r & 1) ? CELLW * 0.5 : 0;
            rowBase[rowN] = -cols;
            rowCount[rowN] = cols * 2 + 1;
            rowStart[rowN] = total;
            total += cols * 2 + 1;
            if (cols * 2 + 1 > widest) {
                widest = cols * 2 + 1;
            }
            var fogT = (z - 380) / 320;
            fogT = fogT < 0 ? 0 : fogT > 1 ? 1 : fogT;
            rowFog[rowN] = (fogT * (NF - 1) + 0.5) | 0;
            rowN++;
        }
        celH = new Float32Array(total);
        celAmber = new Uint8Array(total);

        for (r = 0; r < rowN; r++) {
            var base = rowStart[r];
            var n = rowCount[r];
            var zr = rowZ[r];
            var sh = rowShift[r];
            var b0 = rowBase[r];
            for (var i = 0; i < n; i++) {
                var xc = (b0 + i) * CELLW + sh;
                // One-unit terracing, the way a block world stacks: every step
                // between neighbours is a whole level, so a wall is never a
                // hairline and every contour reads as a terrace edge.
                var hb = heightAt(xc, zr);
                // One terrace step, so a wall between neighbours is a whole
                // level and never a hairline.
                var hc = Math.floor(hb / QUANT) * QUANT;
                if (hc < QUANT) {
                    hc = QUANT;
                }
                // Every column is its own pillar: a deterministic 1-3 step lift
                // sampled at the column itself, independent of the broad
                // terrain. Adjacent columns differ on nearly every edge, which
                // is what gives the plain sides to draw - without it
                // neighbouring cells land on the same level and the floor reads
                // as flat tile. The lift shrinks with height, because the range
                // already has its own relief and a full jitter turns it to fur.
                var jitAmp = 3 - 1.8 * (hb > 40 ? 1 : hb / 40);
                var jit = ihash((xc * 2) | 0, (zr * 2) | 0, 907);
                hc += QUANT * (1 + ((jit * jit * jitAmp) | 0));
                // A rare ember: a low column, lifted one more step.
                if (hb < 11 && ihash((xc * 4) | 0, (zr * 4) | 0, 503) < 0.0004) {
                    celAmber[base + i] = 1;
                    hc += QUANT;
                }
                celH[base + i] = hc;
            }
        }

        MAXROW = widest + 1;
        rowTX = new Float32Array(MAXROW * 6);
        rowTY = new Float32Array(MAXROW * 6);
        rowBand = new Uint8Array(MAXROW);
        rowHband = new Uint8Array(MAXROW);
        order = new Uint16Array(MAXROW);
        bucket = new Uint16Array(NBANDS + 2);
        wallN = new Int32Array(NC * 2);
        var quads = MAXROW * 4 * NC * 2;
        wallX = new Float32Array(quads * 4);
        wallY = new Float32Array(quads * 4);
    }

    /* ------------------------------------------------------------------ *
     * LUTs and gradients, rebuilt with the viewport, never during a draw.
     * ------------------------------------------------------------------ */
    function buildLuts() {
        var b, c, fs;

        for (b = 0; b <= AMBER; b++) {
            if (b === AMBER) {
                cTmp[0] = AMBER_C[0];
                cTmp[1] = AMBER_C[1];
                cTmp[2] = AMBER_C[2];
            } else {
                paletteAt((b / NSUB | 0) / (NB - 1), cTmp);
                // A tone step inside the height step: dry ground reads a shade
                // lighter, wet ground a shade darker, so a plateau is never one
                // flat colour.
                var tone = TONE[b % NSUB];
                cTmp[0] *= tone;
                cTmp[1] *= tone;
                cTmp[2] *= tone;
            }
            var cr = cTmp[0];
            var cg = cTmp[1];
            var cb = cTmp[2];
            for (fs = 0; fs < NF; fs++) {
                var t = (fs / (NF - 1)) * FOG_MAX;
                var mr = cr + (HAZE[0] - cr) * t;
                var mg = cg + (HAZE[1] - cg) * t;
                var mb = cb + (HAZE[2] - cb) * t;
                topLut[b * NF + fs] = css(mr, mg, mb);
                // The seam between columns: the same tone a step darker, so a
                // flat plateau still shows that it is made of hexagons.
                topEdge[b * NF + fs] = css(mr * 0.82 + 1, mg * 0.82 + 1, mb * 0.84 + 2);
            }
        }

        // Wall faces: the same ramp, pushed toward shadow but never toward
        // black. The lit side carries a small lift so a stack of terraces reads
        // as ribbed surfaces instead of as slots between floating tops.
        for (c = 0; c < NC; c++) {
            paletteAt((c * 2 + 1) / (NC * 2), cTmp);
            var lr = cTmp[0] * 1.22 + 10;
            var lg = cTmp[1] * 1.20 + 9;
            var lb = cTmp[2] * 1.16 + 8;
            var dr = cTmp[0] * 0.70 + 8;
            var dg = cTmp[1] * 0.70 + 8;
            var db = cTmp[2] * 0.76 + 9;
            for (fs = 0; fs < NF; fs++) {
                var ft = (fs / (NF - 1)) * FOG_MAX;
                wallLit[c * NF + fs] = css(
                    lr + (HAZE[0] - lr) * ft,
                    lg + (HAZE[1] - lg) * ft,
                    lb + (HAZE[2] - lb) * ft);
                wallDark[c * NF + fs] = css(
                    dr + (HAZE[0] - dr) * ft,
                    dg + (HAZE[1] - dg) * ft,
                    db + (HAZE[2] - db) * ft);
            }
        }

        skyGrad = ctx.createLinearGradient(0, 0, 0, farY > 8 ? farY : 8);
        for (var s = 0; s < SKY_T.length; s++) {
            skyGrad.addColorStop(SKY_T[s], css(SKY_C[s][0], SKY_C[s][1], SKY_C[s][2]));
        }

        titleY0 = H * 0.30;
        titleY1 = H * 0.66;
        titleGrad = ctx.createLinearGradient(0, titleY0, 0, titleY1);
        titleGrad.addColorStop(0, 'rgba(0,0,0,0)');
        titleGrad.addColorStop(0.34, 'rgba(0,0,0,0.36)');
        titleGrad.addColorStop(0.66, 'rgba(0,0,0,0.36)');
        titleGrad.addColorStop(1, 'rgba(0,0,0,0)');
    }

    /* Height of a column in an adjacent row, or -1 when the lattice has no
     * column there: an absent neighbour draws no wall at all. */
    function nearHeight(base, count, left, j) {
        if (j < 0 || j >= count) {
            return -1;
        }
        return celH[base + (j - left)];
    }

    function projectVert(x, z, k, h, out) {
        var pz = z + R * HEX_Z[k];
        var dy = h - CAM_Y;
        var zc = pz * pcos - dy * psin;
        if (zc < 4) {
            zc = 4;
        }
        var yc = pz * psin + dy * pcos;
        var inv = f / zc;
        out[0] = cx + (x + R * HEX_X[k]) * inv;
        out[1] = cy - yc * inv;
    }

    var vA = new Float32Array(2);
    var vB = new Float32Array(2);
    /* Neighbour height across each of the six edges, for the cell being drawn.
     * Written and read inside one cell, so it never leaks between cells. */
    var nb6 = new Float32Array(6);
    /* Height-class histogram for the row being drawn: its most common class sets
     * the tone of the underlay, so a crack reads as a shadow of that ground.
     * Cleared after every row. */
    var clsHist = new Int32Array(NC);

    /* One wall quad: the top edge k1-k2 down to hn, the height the neighbour
     * across it tops out at. Three quads per slot at most, so the stride is
     * three rows of wall boxes. */
    function addWall(cls, shade, tx, ty, o, k1, k2, x, z, hn) {
        var slot = cls * 2 + shade;
        var p = wallN[slot];
        if (p >= 3 * MAXROW) {
            return;
        }
        projectVert(x, z, k1, hn, vA);
        projectVert(x, z, k2, hn, vB);
        var q = (slot * 3 * MAXROW + p) * 4;
        var wx = wallX;
        var wy = wallY;
        wx[q] = tx[o + k1];
        wy[q] = ty[o + k1];
        wx[q + 1] = tx[o + k2];
        wy[q + 1] = ty[o + k2];
        wx[q + 2] = vB[0];
        wy[q + 2] = vB[1];
        wx[q + 3] = vA[0];
        wy[q + 3] = vA[1];
        wallN[slot] = p + 1;
    }

    /* ------------------------------------------------------------------ *
     * One row of the landscape.
     * ------------------------------------------------------------------ */
    function paintRow(r) {
        var base = rowStart[r];
        var n = rowCount[r];
        var z = rowZ[r];
        var shift = rowShift[r];
        var fog = rowFog[r];
        var b0 = rowBase[r];
        var tx = rowTX;
        var ty = rowTY;
        var i, k;

        // ---- project every top, and band it
        var rowMinX = 1e9;
        var rowMaxX = -1e9;
        for (i = 0; i < n; i++) {
            var x = (b0 + i) * CELLW + shift;
            var h = celH[base + i];
            var dy = h - CAM_Y;
            var hpC = dy * pcos;
            var hpS = dy * psin;
            var o = i * 6;
            var xmin = 1e9;
            var xmax = -1e9;
            for (k = 0; k < 6; k++) {
                var pz = z + R * HEX_Z[k];
                var zc = pz * pcos - hpS;
                if (zc < 4) {
                    zc = 4;
                }
                var inv = f / zc;
                var sx = cx + (x + R * HEX_X[k]) * inv;
                var sy = cy - (pz * psin + hpC) * inv;
                tx[o + k] = sx;
                ty[o + k] = sy;
                if (sx < xmin) {
                    xmin = sx;
                }
                if (sx > xmax) {
                    xmax = sx;
                }
            }
            if (xmin < rowMinX) {
                rowMinX = xmin;
            }
            if (xmax > rowMaxX) {
                rowMaxX = xmax;
            }

            // Band: the square root of relative height, so the lowland keeps
            // several steps of its own instead of collapsing into one. Within a
            // step, a moisture field picks one of NSUB tones.
            var u = h / HMAX;
            u = u > 1 ? 1 : u;
            var band = (Math.sqrt(u) * (NB - 1) + 0.5) | 0;
            if (band > NB - 1) {
                band = NB - 1;
            }
            rowHband[i] = band;
            clsHist[(band * NC / NB) | 0]++;
            if (celAmber[base + i]) {
                rowBand[i] = AMBER;
            } else {
                // Erosion, sampled at the same scale as the terrain uses it:
                // ground that has been worn down reads a shade lighter, wet
                // hollows a shade darker, so a plateau is never one flat colour.
                var eroTint = fbm(x * 0.0120, z * 0.0120, 41, 2);
                rowBand[i] = band * NSUB +
                    (eroTint < 0.44 ? 0 : eroTint > 0.56 ? 2 : 1);
            }
        }

        if (rowMinX > W || rowMaxX < 0) {
            return;
        }

        // The row's most common height class: the underlay and the hex seam both
        // take their tone from it, so a crack reads as a shadow of this ground.
        var domCls = 0;
        for (k = 1; k < NC; k++) {
            if (clsHist[k] > clsHist[domCls]) {
                domCls = k;
            }
        }
        for (k = 0; k < NC; k++) {
            clsHist[k] = 0;
        }

        // ---- underlay: this row's columns, whole hexagon plus everything below
        // it, in the row's own shadow tone. Drawn before the row's own faces, so
        // it can only ever show through a crack - where it reads as a shadow
        // line instead of a hole. Starting at the full hexagon rather than just
        // its lower edge also closes the sub-pixel seam against the top face.
        ctx.beginPath();
        for (i = 0; i < n; i++) {
            var ou = i * 6;
            // the hexagon itself, closing any sub-pixel seam against the top face
            ctx.moveTo(tx[ou], ty[ou]);
            ctx.lineTo(tx[ou + 1], ty[ou + 1]);
            ctx.lineTo(tx[ou + 2], ty[ou + 2]);
            ctx.lineTo(tx[ou + 3], ty[ou + 3]);
            ctx.lineTo(tx[ou + 4], ty[ou + 4]);
            ctx.lineTo(tx[ou + 5], ty[ou + 5]);
            ctx.closePath();
            // and everything below its lower edge, down to the bottom of frame
            ctx.moveTo(tx[ou + 3], ty[ou + 3]);
            ctx.lineTo(tx[ou + 4], ty[ou + 4]);
            ctx.lineTo(tx[ou + 5], ty[ou + 5]);
            ctx.lineTo(tx[ou + 5], H);
            ctx.lineTo(tx[ou + 3], H);
            ctx.closePath();
        }
        ctx.fillStyle = wallDark[domCls * NF + fog];
        ctx.fill();

        // ---- walls, one buffer per height class and shade
        var rn = r + 1 < rowN ? r + 1 : r;      // nearer row
        var rf = r > 0 ? r - 1 : r;             // farther row
        var nbBase = rowStart[rn];
        var nbCount = rowCount[rn];
        var nbLeft = rowBase[rn];
        var fBase = rowStart[rf];
        var fCount = rowCount[rf];
        var fLeft = rowBase[rf];
        // Rows r-1 and r+1 sit on the same lattice phase, so one offset rule
        // serves both: +-CELLW/2 across, one column either way.
        var dPlus = (shift - rowShift[rn]) > 0;
        for (k = 0; k < NC * 2; k++) {
            wallN[k] = 0;
        }

        for (i = 0; i < n; i++) {
            var hi = celH[base + i];
            var xi = (b0 + i) * CELLW + shift;
            var oi = i * 6;
            var cls = (rowHband[i] * NC / NB) | 0;
            if (cls >= NC) {
                cls = NC - 1;
            }

            // Pass one: which of the six faces the camera is actually on the
            // outside of. The outward normal against the vector to the camera
            // (the eye sits at world x = 0, z = 0) is the whole test.
            var vb = hi;
            for (k = 0; k < 6; k++) {
                nb6[k] = -1;
                if (HEX_NX[k] * -xi + HEX_NZ[k] * -z <= 0) {
                    continue;                       // back-facing or edge-on
                }
                var side = ENB_SIDE[k];
                var rr = ENB_ROW[k];
                var hv;
                if (rr === 0) {
                    var js = i + side;
                    hv = (js >= 0 && js < n) ? celH[base + js] : -1;
                } else {
                    // Rows r-1 and r+1 share a lattice phase: one offset rule.
                    var jn = dPlus ? (side > 0 ? i + 1 : i) : (side > 0 ? i : i - 1);
                    hv = rr > 0
                        ? nearHeight(nbBase, nbCount, nbLeft, jn)
                        : nearHeight(fBase, fCount, fLeft, jn);
                }
                nb6[k] = hv;
                if (hv >= 0 && hv < vb) {
                    vb = hv;                        // floor for a face that steps down
                }
            }

            // Pass two. A visible face spans between this column's top and the
            // stone across it, in whichever direction that is:
            //   - neighbour lower: the riser hangs below this top, and every such
            //     face uses one shared floor so their bottoms meet at a corner;
            //   - neighbour higher: the riser is the step face looking back at
            //     the camera, and it rises from this top to the neighbour's. That
            //     case used to be skipped, which is what left the slots.
            for (k = 0; k < 6; k++) {
                var hk = nb6[k];
                if (hk < 0) {
                    continue;
                }
                var dh = hk - hi;
                if (dh > -QUANT * 0.5 && dh < QUANT * 0.5) {
                    continue;                       // same level: nothing to face
                }
                var k2 = k + 1 === 6 ? 0 : k + 1;
                addWall(cls, ENB_SHADE[k], tx, ty, oi, k, k2, xi, z,
                    dh < 0 ? vb : hk);
            }
        }

        for (k = 0; k < NC * 2; k++) {
            var cnt = wallN[k];
            if (cnt === 0) {
                continue;
            }
            var wq = k * 3 * MAXROW;
            ctx.beginPath();
            for (i = 0; i < cnt; i++) {
                var q = (wq + i) * 4;
                ctx.moveTo(wallX[q], wallY[q]);
                ctx.lineTo(wallX[q + 1], wallY[q + 1]);
                ctx.lineTo(wallX[q + 2], wallY[q + 2]);
                ctx.lineTo(wallX[q + 3], wallY[q + 3]);
                ctx.closePath();
            }
            var cs = k >> 1;
            ctx.fillStyle = (k & 1) ? wallDark[cs * NF + fog] : wallLit[cs * NF + fog];
            ctx.fill();
        }

        // ---- tops, counting-sorted so each band is one path
        var buck = bucket;
        for (k = 0; k <= NBANDS; k++) {
            buck[k] = 0;
        }
        for (i = 0; i < n; i++) {
            buck[rowBand[i]]++;
        }
        var acc = 0;
        for (k = 0; k <= NBANDS; k++) {
            var c = buck[k];
            buck[k] = acc;
            acc += c;
        }
        for (i = 0; i < n; i++) {
            var bd = rowBand[i];
            order[buck[bd]++] = i;
        }

        var from = 0;
        for (k = 0; k <= NBANDS; k++) {
            var to = buck[k];
            if (to > from) {
                ctx.beginPath();
                for (i = from; i < to; i++) {
                    var ot = order[i] * 6;
                    ctx.moveTo(tx[ot], ty[ot]);
                    ctx.lineTo(tx[ot + 1], ty[ot + 1]);
                    ctx.lineTo(tx[ot + 2], ty[ot + 2]);
                    ctx.lineTo(tx[ot + 3], ty[ot + 3]);
                    ctx.lineTo(tx[ot + 4], ty[ot + 4]);
                    ctx.lineTo(tx[ot + 5], ty[ot + 5]);
                    ctx.closePath();
                }
                ctx.fillStyle = topLut[k * NF + fog];
                ctx.fill();
                ctx.strokeStyle = topEdge[k * NF + fog];
                ctx.lineWidth = 1;
                ctx.stroke();
            }
            from = to;
        }
    }

    /* ------------------------------------------------------------------ *
     * The picture: one call, no loop.
     * ------------------------------------------------------------------ */
    function draw() {
        ctx.globalCompositeOperation = 'source-over';
        if (DEBUG_HOLES) {
            // Everything the terrain does not paint stays this colour.
            ctx.fillStyle = DEBUG_FILL;
            ctx.fillRect(0, 0, W, H);
        } else {
            ctx.fillStyle = BACKDROP;
            ctx.fillRect(0, 0, W, H);
            ctx.fillStyle = skyGrad;
            ctx.fillRect(0, 0, W, H);
        }

        for (var r = 0; r < rowN; r++) {
            paintRow(r);
        }

        if (!DEBUG_HOLES) {
            ctx.fillStyle = titleGrad;
            ctx.fillRect(0, titleY0, W, titleY1 - titleY0);
        }
    }

    function resize() {
        var w = window.innerWidth;
        var h = window.innerHeight;
        if (w < 2 || h < 2) {
            return;
        }
        W = w;
        H = h;
        canvas.width = w;
        canvas.height = h;

        cx = w * 0.5;
        cy = h * 0.5;
        f = h * 0.95;
        pcos = 1 / Math.sqrt(1 + TAN_PITCH * TAN_PITCH);
        psin = TAN_PITCH * pcos;

        var zcFar = Z_FAR * pcos + CAM_Y * psin;
        var ycFar = Z_FAR * psin - CAM_Y * pcos;
        farY = cy - f * ycFar / zcFar;

        buildField();
        buildLuts();
        draw();
    }

    var resizeQueued = false;

    function queueResize() {
        if (resizeQueued) {
            return;
        }
        resizeQueued = true;
        window.requestAnimationFrame(function () {
            resizeQueued = false;
            resize();
        });
    }

    window.addEventListener('resize', queueResize, { passive: true });

    // The picture is a single still frame, so `prefers-reduced-motion: reduce`
    // is honoured by construction: there is no loop, no drift and no clock. A
    // hidden tab can come back with its backing store cleared, so repaint on
    // return; that is the only other draw.
    document.addEventListener('visibilitychange', function () {
        if (!document.hidden && W > 0) {
            draw();
        }
    });

    window.addEventListener('pagehide', function () {
        resizeQueued = false;
    });

    resize();
})();
