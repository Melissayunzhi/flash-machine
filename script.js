"use strict";

/* ============================================================
   FLASH MACHINE
   Photo    load a picture, prepare it, run it through a screen
   System   strange attractors, flow fields, trajectories
   Curve    plotted curves, spirographs, rosettes
   ============================================================ */

const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const clamp = (v,a,b) => v < a ? a : v > b ? b : v;
const TAU = Math.PI*2;
const ACCENT = '#33FF99';

const view    = $('#view');
const vctx    = view.getContext('2d', { willReadFrequently:true });
const overlay = $('#overlay');
const octx    = overlay.getContext('2d');

const state = {
  mode:'image',
  effect:'diffuse',
  activeEffects:['diffuse'],
  combine:false,
  srcImage:null,
  work:document.createElement('canvas'),
  mask:null,
  tool:'off',
  vector:null,
  pre:{ invert:false, bright:0, contrast:0, gamma:1, blur:0, noise:0 },
  fx:{}, fxAll:{},
  gen:{ system:'dejong', points:900000, exposure:1, gamma:0.55, format:'square', detail:1000, draw:'dots' },
  rot3d:{ x:0.35, y:0.6 },
  growth:{ playing:false, loop:false, duration:4 },
  spin:{ auto:false },
  genP:{}, genAll:{},
  curve:{ key:'spiro', copies:1, spin:0, weight:1.6, samples:12000, wobble:0, mirror:false, detail:1100, format:'square' },
  curveP:{}, curveAll:{},
  field:{ key:'liquid', contrast:1, lift:0, levels:0, invert:false, detail:800, format:'square' },
  fieldP:{}, fieldAll:{},
  seed:1337, running:null, inkPct:0, keepRender:false, customFn:null,
  pins:[], sheet:{ cols:3, gap:40, margin:60, width:2000 },
  layers:[]
};

function mulberry32(a){
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/* ============================================================
   CONTROL BUILDER
   ============================================================ */
function buildControls(host, schema, store, onChange){
  host.innerHTML = '';
  schema.forEach(c => {
    if (store[c.k] === undefined) store[c.k] = c.v;
    const row = document.createElement('div');
    row.className = 'row';
    if (c.t === 'check'){
      const lab = document.createElement('label'); lab.className = 'check';
      const inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = !!store[c.k];
      inp.addEventListener('change', () => { store[c.k] = inp.checked; onChange(); });
      lab.appendChild(inp); lab.appendChild(document.createTextNode(' ' + c.l));
      row.appendChild(lab);
    } else if (c.t === 'text'){
      const lab = document.createElement('label'); lab.className = 'lab'; lab.textContent = c.l;
      const inp = document.createElement('input');
      inp.type = 'text'; inp.value = store[c.k]; inp.spellcheck = false;
      inp.addEventListener('input', () => { store[c.k] = inp.value; onChange(); });
      row.appendChild(lab); row.appendChild(inp);
    } else if (c.t === 'select'){
      const lab = document.createElement('label'); lab.className = 'lab'; lab.textContent = c.l;
      const sel = document.createElement('select');
      c.opts.forEach(o => {
        const op = document.createElement('option');
        op.value = o[0]; op.textContent = o[1];
        if (String(store[c.k]) === String(o[0])) op.selected = true;
        sel.appendChild(op);
      });
      sel.addEventListener('change', () => {
        store[c.k] = isNaN(Number(sel.value)) ? sel.value : Number(sel.value);
        onChange();
      });
      row.appendChild(lab); row.appendChild(sel);
    } else {
      const lab = document.createElement('label'); lab.className = 'lab';
      const out = document.createElement('b');
      const fmt = v => (c.fmt ? c.fmt(v) : String(v));
      out.textContent = fmt(store[c.k]);
      lab.appendChild(document.createTextNode(c.l)); lab.appendChild(out);
      const inp = document.createElement('input');
      inp.type = 'range'; inp.min = c.min; inp.max = c.max; inp.step = c.step; inp.value = store[c.k];
      inp.addEventListener('input', () => {
        store[c.k] = Number(inp.value); out.textContent = fmt(store[c.k]); onChange();
      });
      row.appendChild(lab); row.appendChild(inp);
    }
    host.appendChild(row);
  });
}

/* ============================================================
   IMAGE PREPARATION
   ============================================================ */
const PRE_SCHEMA = [
  { k:'sym',      l:'Symmetry', t:'select', v:'none', opts:[['none','Off'],['lr','Mirror left to right'],['rl','Mirror right to left'],['tb','Mirror top to bottom'],['quad','Four ways'],['kal','Kaleidoscope']] },
  { k:'symN',     l:'Kaleidoscope wedges', t:'range', min:3, max:24, step:1, v:8 },
  { k:'warp',     l:'Warp', t:'select', v:'none', opts:[['none','Off'],['ripple','Ripple'],['swirl','Swirl'],['pinch','Pinch']] },
  { k:'warpAmt',  l:'Warp amount', t:'range', min:0, max:100, step:1, v:40, fmt:v=>v+'%' },
  { k:'bright',   l:'Brightness', t:'range', min:-100, max:100, step:1, v:0 },
  { k:'contrast', l:'Contrast',   t:'range', min:-100, max:200, step:1, v:0 },
  { k:'gamma',    l:'Midtones',   t:'range', min:0.2,  max:3,   step:0.05, v:1, fmt:v=>v.toFixed(2) },
  { k:'blur',     l:'Softness',   t:'range', min:0,    max:30,  step:1, v:0, fmt:v=>v+' px' },
  { k:'noise',    l:'Grain',      t:'range', min:0,    max:100, step:1, v:0 },
  { k:'vig',      l:'Vignette',   t:'range', min:0,    max:100, step:1, v:0, fmt:v=>v+'%' },
  { k:'vigSoft',  l:'Vignette softness', t:'range', min:5, max:100, step:1, v:55, fmt:v=>v+'%' },
  { k:'invert',   l:'Invert',     t:'check', v:false }
];

/* ---------- warp: ripple, swirl, pinch — resamples the grayscale before anything else runs ---------- */
function applyWarp(g,w,h,type,amt){
  if (type === 'none' || amt <= 0) return g;
  const out = new Float32Array(g.length);
  const cx=w/2, cy=h/2, maxR=Math.min(w,h)/2, k=amt/100;
  for (let y=0; y<h; y++){
    for (let x=0; x<w; x++){
      const dx=x-cx, dy=y-cy, r=Math.hypot(dx,dy), a=Math.atan2(dy,dx);
      let sx=x, sy=y;
      if (type === 'ripple'){
        const phase = Math.sin(r/maxR*10) * k*20;
        sx = x + Math.cos(a+Math.PI/2)*phase;
        sy = y + Math.sin(a+Math.PI/2)*phase;
      } else if (type === 'swirl'){
        const t = clamp(1 - r/maxR, 0, 1);
        const ang = a + t*t*k*4;
        sx = cx + Math.cos(ang)*r;
        sy = cy + Math.sin(ang)*r;
      } else if (type === 'pinch'){
        const t = clamp(r/maxR, 0, 1);
        const nr = Math.pow(t, 1+k*2) * maxR;
        sx = cx + Math.cos(a)*nr;
        sy = cy + Math.sin(a)*nr;
      }
      out[y*w+x] = bilinear(g, w, h, clamp(sx,0,w-1), clamp(sy,0,h-1));
    }
  }
  return out;
}

function grayFromWork(){
  const w = state.work.width, h = state.work.height;
  const d = state.work.getContext('2d').getImageData(0,0,w,h).data;
  const g = new Float32Array(w*h);
  for (let i=0, p=0; i<g.length; i++, p+=4){
    const a = d[p+3]/255;
    const lum = 0.2126*d[p] + 0.7152*d[p+1] + 0.0722*d[p+2];
    g[i] = lum*a + 255*(1-a);
  }
  return { g, w, h };
}

function boxBlur(g,w,h,r){
  if (r < 1) return g;
  const tmp = new Float32Array(g.length);
  for (let pass=0; pass<2; pass++){
    for (let y=0; y<h; y++){
      let sum=0; const row=y*w;
      for (let x=-r; x<=r; x++) sum += g[row + clamp(x,0,w-1)];
      for (let x=0; x<w; x++){
        tmp[row+x] = sum/(2*r+1);
        sum += g[row + clamp(x+r+1,0,w-1)] - g[row + clamp(x-r,0,w-1)];
      }
    }
    for (let x=0; x<w; x++){
      let sum=0;
      for (let y=-r; y<=r; y++) sum += tmp[clamp(y,0,h-1)*w + x];
      for (let y=0; y<h; y++){
        g[y*w+x] = sum/(2*r+1);
        sum += tmp[clamp(y+r+1,0,h-1)*w + x] - tmp[clamp(y-r,0,h-1)*w + x];
      }
    }
  }
  return g;
}

function prepare(){
  const { g, w, h } = grayFromWork();
  const p = state.pre;
  const cf = (259*(p.contrast+255)) / (255*(259-p.contrast));
  const ig = 1/p.gamma;
  for (let i=0; i<g.length; i++){
    let v = g[i] + p.bright;
    v = cf*(v-128) + 128;
    v = 255 * Math.pow(clamp(v,0,255)/255, ig);
    if (p.invert) v = 255 - v;
    g[i] = v;
  }
  let g2 = (p.warp && p.warp !== 'none' && p.warpAmt > 0) ? applyWarp(g, w, h, p.warp, p.warpAmt) : g;
  if (p.blur > 0) boxBlur(g2, w, h, p.blur);
  if (p.noise > 0){
    const n = p.noise * 1.2;
    for (let i=0; i<g2.length; i++) g2[i] = clamp(g2[i] + (Math.random()-0.5)*n, 0, 255);
  }
  if (p.vig > 0){
    const cx=w/2, cy=h/2, maxR=Math.hypot(cx,cy);
    const soft = Math.max(p.vigSoft,1)/100;
    for (let y=0; y<h; y++){
      for (let x=0; x<w; x++){
        const r = Math.hypot(x-cx,y-cy)/maxR;
        const t = clamp((r-(1-soft))/soft, 0, 1);
        const i = y*w+x;
        g2[i] = clamp(g2[i] - t*(p.vig/100)*255, 0, 255);
      }
    }
  }
  return { g:g2, w, h };
}

/* ---------- symmetry, folded into the photo before anything else ---------- */
function applySymmetry(cv, mode, n){
  if (mode === 'none') return;
  const w = cv.width, h = cv.height;
  const ctx = cv.getContext('2d');
  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  tmp.getContext('2d').drawImage(cv, 0, 0);

  if (mode === 'kal'){
    const wedges = Math.max(3, Math.round(n));
    const step = TAU/wedges;
    const cx = w/2, cy = h/2, R = Math.hypot(w,h);
    ctx.clearRect(0,0,w,h);
    for (let i=0; i<wedges; i++){
      ctx.save();
      ctx.translate(cx,cy);
      ctx.rotate(i*step);
      if (i & 1) ctx.scale(1,-1);
      ctx.beginPath();
      ctx.moveTo(0,0);
      ctx.arc(0, 0, R, -step/2, step/2);
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(tmp, -cx, -cy);
      ctx.restore();
    }
    return;
  }
  const half = (axis, keep) => {
    ctx.save();
    if (axis === 'x'){
      if (keep === 'right'){ ctx.translate(w,0); ctx.scale(-1,1); ctx.drawImage(tmp,0,0); ctx.restore(); ctx.save(); }
      ctx.beginPath();
      ctx.rect(keep === 'left' ? w/2 : 0, 0, w/2, h);
      ctx.clip();
      ctx.translate(w,0); ctx.scale(-1,1);
      ctx.drawImage(keep === 'right' ? tmp : tmp, 0, 0);
    } else {
      ctx.beginPath();
      ctx.rect(0, h/2, w, h/2);
      ctx.clip();
      ctx.translate(0,h); ctx.scale(1,-1);
      ctx.drawImage(tmp, 0, 0);
    }
    ctx.restore();
  };
  if (mode === 'lr') half('x','left');
  else if (mode === 'rl'){
    ctx.save(); ctx.beginPath(); ctx.rect(0,0,w/2,h); ctx.clip();
    ctx.translate(w,0); ctx.scale(-1,1); ctx.drawImage(tmp,0,0); ctx.restore();
  }
  else if (mode === 'tb') half('y','top');
  else if (mode === 'quad'){ half('x','left');
    const t2 = document.createElement('canvas'); t2.width = w; t2.height = h;
    t2.getContext('2d').drawImage(cv,0,0);
    ctx.save(); ctx.beginPath(); ctx.rect(0,h/2,w,h/2); ctx.clip();
    ctx.translate(0,h); ctx.scale(1,-1); ctx.drawImage(t2,0,0); ctx.restore();
  }
}

/* ---------- canvas helpers ---------- */
function inkImage(w,h){ return vctx.createImageData(w,h); }
function put(data,i,a){ const p=i*4; data[p]=0; data[p+1]=0; data[p+2]=0; data[p+3]=a; }
function beginCanvas(w,h){
  view.width = w; view.height = h;
  overlay.width = w; overlay.height = h;
  vctx.clearRect(0,0,w,h);
  vctx.fillStyle = '#000'; vctx.strokeStyle = '#000';
  vctx.lineCap = 'round'; vctx.lineJoin = 'round'; vctx.lineWidth = 1;
}
function sample(g,w,h,x,y){
  const xi = clamp(Math.round(x),0,w-1), yi = clamp(Math.round(y),0,h-1);
  return g[yi*w+xi];
}
function bilinear(g,w,h,x,y){
  const xi = clamp(Math.floor(x),0,w-2), yi = clamp(Math.floor(y),0,h-2);
  const fx = clamp(x-xi,0,1), fy = clamp(y-yi,0,1), i = yi*w+xi;
  return g[i]*(1-fx)*(1-fy) + g[i+1]*fx*(1-fy) + g[i+w]*(1-fx)*fy + g[i+w+1]*fx*fy;
}

/* ---------- block resolution for the dither family ---------- */
function coarsen(g,w,h,b){
  if (b <= 1) return { g, w, h };
  const w2 = Math.max(1, Math.ceil(w/b)), h2 = Math.max(1, Math.ceil(h/b));
  const out = new Float32Array(w2*h2);
  for (let y=0; y<h2; y++){
    for (let x=0; x<w2; x++){
      let s=0, n=0;
      for (let j=0; j<b; j++){
        const sy = y*b+j; if (sy>=h) break;
        for (let i2=0; i2<b; i2++){
          const sx = x*b+i2; if (sx>=w) break;
          s += g[sy*w+sx]; n++;
        }
      }
      out[y*w2+x] = n ? s/n : 255;
    }
  }
  return { g:out, w:w2, h:h2 };
}

// mask holds ink alpha 0-255 on a w2 x h2 grid; blit it at block size b onto a W x H sheet
function blitMask(mask,w2,h2,b,W,H){
  if (b > 1){ W = w2*b; H = h2*b; }
  beginCanvas(W,H);
  if (b <= 1){
    const img = inkImage(W,H), d = img.data;
    for (let i=0; i<mask.length && i<W*H; i++) if (mask[i]) put(d, i, mask[i]);
    vctx.putImageData(img,0,0);
    state.vector = null;
    return;
  }
  const items = [];
  let last = -1;
  for (let y=0; y<h2; y++){
    for (let x=0; x<w2; x++){
      const a = mask[y*w2+x];
      if (!a) continue;
      if (a !== last){ vctx.fillStyle = a>=250 ? '#000' : 'rgba(0,0,0,'+(a/255).toFixed(3)+')'; last = a; }
      vctx.fillRect(x*b, y*b, b, b);
      items.push([x*b, y*b, b, b, a/255]);
    }
  }
  vctx.fillStyle = '#000';
  state.vector = { kind:'rects', w:W, h:H, items };
}

/* ============================================================
   TREATMENTS
   ============================================================ */
const EFFECTS = {
  threshold: { label:'Threshold', note:'Hard black and white, the classic photocopy cut.', controls:[
    { k:'cut',   l:'Cutoff', t:'range', min:0, max:255, step:1, v:128 },
    { k:'edge',  l:'Edge softness', t:'range', min:0, max:80, step:1, v:0 },
    { k:'block', l:'Pixel size', t:'range', min:1, max:48, step:1, v:1, fmt:v=>v+' px' }
  ]},
  pixelate: { label:'Pixelate', note:'The photo dropped to a grid of flat blocks, each one the average tone underneath. Open the gap for a visible pixel grid, or posterise for a stepped, retro-console look. Exports as vector blocks.', controls:[
    { k:'size',   l:'Block size', t:'range', min:2, max:120, step:1, v:18, fmt:v=>v+' px' },
    { k:'gap',    l:'Grid gap', t:'range', min:0, max:40, step:0.5, v:0, fmt:v=>v.toFixed(1)+' px' },
    { k:'levels', l:'Posterise', t:'range', min:0, max:16, step:1, v:0, fmt:v=>v<2?'off':v+' steps' },
    { k:'gamma',  l:'Tone curve', t:'range', min:0.3, max:3, step:0.05, v:1, fmt:v=>v.toFixed(2) },
    { k:'cut',    l:'Skip blocks lighter than', t:'range', min:0, max:255, step:1, v:255 }
  ]},
  ordered: { label:'Ordered dither', note:'A fixed screen laid over the whole picture. Bayer scatters the dots, clustered dot grows them like print, lines give you a stripe screen. Pixel size averages the photo into blocks first, so every mark comes out whole.', controls:[
    { k:'pattern', l:'Screen', t:'select', v:'bayer', opts:[['bayer','Bayer'],['cluster','Clustered dot'],['lines','Lines'],['diagonal','Diagonal'],['cross','Crosshatch'],['random','Random noise']] },
    { k:'size',   l:'Screen size', t:'range', min:2, max:16, step:1, v:8, fmt:v=>v+' × '+v },
    { k:'scale',  l:'Screen scale', t:'range', min:1, max:24, step:1, v:1, fmt:v=>v+'×' },
    { k:'lock',   l:'Pixel size follows screen scale', t:'check', v:true },
    { k:'block',  l:'Pixel size', t:'range', min:1, max:48, step:1, v:1, fmt:v=>v+' px' },
    { k:'cut',    l:'Cutoff', t:'range', min:0, max:255, step:1, v:128 }
  ]},
  diffuse: { label:'Error diffusion', note:'Every pixel passes its rounding error to the ones it has not reached yet. Atkinson keeps highlights open, Stucki and Jarvis hold detail, Floyd is the sharpest.', controls:[
    { k:'kernel', l:'Kernel', t:'select', v:'atkinson', opts:[['floyd','Floyd–Steinberg'],['atkinson','Atkinson'],['jarvis','Jarvis'],['stucki','Stucki'],['burkes','Burkes'],['sierra3','Sierra 3'],['sierra2','Sierra 2'],['sierra','Sierra Lite'],['fan','Fan']] },
    { k:'cut',    l:'Cutoff', t:'range', min:0, max:255, step:1, v:128 },
    { k:'strength', l:'Error passed on', t:'range', min:0, max:150, step:1, v:100, fmt:v=>v+'%' },
    { k:'noise',  l:'Cutoff jitter', t:'range', min:0, max:100, step:1, v:0 },
    { k:'block',  l:'Pixel size', t:'range', min:1, max:48, step:1, v:1, fmt:v=>v+' px' },
    { k:'serp',   l:'Serpentine scan', t:'check', v:true }
  ]},
  halftone: { label:'Halftone Screen', note:'A grid of marks sized by the tone underneath. Bars join up into continuous lines, which is the default, and the grid angle turns the whole field. Benday staggers the rows. Everything here exports as vector.', controls:[
    { k:'count', l:'Cells down the sheet', t:'range', min:8, max:400, step:1, v:90 },
    { k:'grid',  l:'Grid', t:'select', v:'regular', opts:[['regular','Regular'],['benday','Benday, staggered'],['hex','Hexagonal']] },
    { k:'shape', l:'Mark', t:'select', v:'bar', opts:[['bar','Bar, joins into lines'],['dot','Round dot'],['square','Square'],['diamond','Diamond'],['cross','Cross'],['ring','Ring'],['line','Continuous line'],['star','Star'],['sparkle','Sparkle'],['heart','Heart'],['cloud','Cloud']] },
    { k:'angle', l:'Grid angle', t:'range', min:0, max:180, step:1, v:0, fmt:v=>v+'°' },
    { k:'scale', l:'Mark weight', t:'range', min:0.1, max:2.5, step:0.05, v:1, fmt:v=>v.toFixed(2) },
    { k:'min',   l:'Smallest mark', t:'range', min:0, max:100, step:1, v:7, fmt:v=>v+'%' },
    { k:'cut',   l:'Skip cells lighter than', t:'range', min:0, max:255, step:1, v:255 },
    { k:'gamma', l:'Tone curve', t:'range', min:0.3, max:3, step:0.05, v:1, fmt:v=>v.toFixed(2) }
  ]},
  dotmatrix: { label:'Dot Matrix', note:'A regular grid of fixed-size dots, switched on and off by a dither pattern — an LED sign or a dot-matrix printer reading the photo, not a halftone that grows and shrinks.', controls:[
    { k:'count',  l:'Cells down the sheet', t:'range', min:8, max:200, step:1, v:60 },
    { k:'shape',  l:'Dot', t:'select', v:'circle', opts:[['circle','Round'],['square','Square']] },
    { k:'size',   l:'Dot size', t:'range', min:10, max:100, step:1, v:65, fmt:v=>v+'%' },
    { k:'pattern',l:'Dither', t:'select', v:'bayer', opts:[['bayer','Bayer'],['cluster','Clustered'],['lines','Lines'],['random','Random']] },
    { k:'matrixSize', l:'Dither tile', t:'range', min:2, max:16, step:1, v:8, fmt:v=>v+' × '+v },
    { k:'cut',    l:'Skip lighter than', t:'range', min:0, max:255, step:1, v:255 },
    { k:'gamma',  l:'Tone curve', t:'range', min:0.3, max:3, step:0.05, v:1, fmt:v=>v.toFixed(2) }
  ]},
  crosshatch: { label:'Crosshatch', note:'Layers of straight hatching, each one switching on further into the shadows.', controls:[
    { k:'spacing', l:'Line spacing', t:'range', min:3, max:60, step:1, v:9, fmt:v=>v+' px' },
    { k:'angle',   l:'First angle', t:'range', min:0, max:180, step:1, v:35, fmt:v=>v+'°' },
    { k:'spread',  l:'Angle between layers', t:'range', min:5, max:90, step:1, v:45, fmt:v=>v+'°' },
    { k:'layers',  l:'Layers', t:'range', min:1, max:5, step:1, v:3 },
    { k:'weight',  l:'Line weight', t:'range', min:0.3, max:6, step:0.1, v:1.2, fmt:v=>v.toFixed(1)+' px' },
    { k:'gamma',   l:'Tone curve', t:'range', min:0.3, max:3, step:0.05, v:1, fmt:v=>v.toFixed(2) }
  ]},
  engrave: { label:'Engrave', note:'Hatching that bends around the shapes in the photo, the way a banknote is cut.', controls:[
    { k:'spacing', l:'Line spacing', t:'range', min:3, max:40, step:1, v:9, fmt:v=>v+' px' },
    { k:'length',  l:'Line length', t:'range', min:5, max:300, step:5, v:70, fmt:v=>v+' px' },
    { k:'smooth',  l:'Field smoothing', t:'range', min:1, max:30, step:1, v:6, fmt:v=>v+' px' },
    { k:'weight',  l:'Line weight', t:'range', min:0.2, max:6, step:0.1, v:1.4, fmt:v=>v.toFixed(1)+' px' },
    { k:'dir',     l:'Direction', t:'select', v:'along', opts:[['along','Follow the edges'],['across','Cut across the edges'],['fixed','Straight, tone only']] },
    { k:'cutoff',  l:'Ignore lighter than', t:'range', min:0, max:255, step:1, v:225 },
    { k:'gamma',   l:'Tone curve', t:'range', min:0.3, max:3, step:0.05, v:1, fmt:v=>v.toFixed(2) }
  ]},
  ridge: { label:'Ridge lines', note:'One family of lines pushed out of shape by the tone underneath. Rows give you the ridgeline look, rings give you a target.', controls:[
    { k:'layout',  l:'Layout', t:'select', v:'rows', opts:[['rows','Rows'],['cols','Columns'],['rings','Rings'],['rays','Rays from centre']] },
    { k:'spacing', l:'Spacing', t:'range', min:4, max:80, step:1, v:14, fmt:v=>v+' px' },
    { k:'mode',    l:'Tone controls', t:'select', v:'displace', opts:[['displace','Displacement'],['weight','Line weight'],['both','Both']] },
    { k:'amp',     l:'Displacement', t:'range', min:0, max:120, step:1, v:22, fmt:v=>v+' px' },
    { k:'weight',  l:'Line weight', t:'range', min:0.3, max:8, step:0.1, v:1.4, fmt:v=>v.toFixed(1)+' px' },
    { k:'floor',   l:'Break where lighter than', t:'range', min:0, max:255, step:1, v:248 },
    { k:'gamma',   l:'Tone curve', t:'range', min:0.3, max:3, step:0.05, v:1, fmt:v=>v.toFixed(2) }
  ]},
  spiral: { label:'Spiral screen', note:'One continuous spiral running from the middle out, swelling where the picture is dark. Crop it to a disc and it becomes a badge. A single unbroken path for a plotter.', controls:[
    { k:'spacing', l:'Turn spacing', t:'range', min:3, max:60, step:0.5, v:9, fmt:v=>v.toFixed(1)+' px' },
    { k:'wmin',    l:'Thinnest', t:'range', min:0, max:6, step:0.05, v:0.3, fmt:v=>v.toFixed(2)+' px' },
    { k:'wmax',    l:'Thickest', t:'range', min:0.5, max:40, step:0.5, v:8, fmt:v=>v.toFixed(1)+' px' },
    { k:'crop',    l:'Shape', t:'select', v:'circle', opts:[['sheet','Fill the sheet'],['circle','Crop to a disc']] },
    { k:'outer',   l:'Disc size', t:'range', min:10, max:145, step:1, v:94, fmt:v=>v+'%' },
    { k:'inner',   l:'Cut out the middle', t:'range', min:0, max:90, step:1, v:0, fmt:v=>v+'%' },
    { k:'ring',    l:'Draw the outer edge', t:'check', v:false },
    { k:'angle',   l:'Rotate', t:'range', min:0, max:360, step:1, v:0, fmt:v=>v+'°' },
    { k:'gamma',   l:'Tone curve', t:'range', min:0.3, max:3, step:0.05, v:1, fmt:v=>v.toFixed(2) }
  ]},
  rings: { label:'Rings', note:'Concentric rings from the centre, each one thickening where the photo is dark — growth rings, vinyl grooves, sonar. A cousin of the spiral screen, but broken into separate circles.', controls:[
    { k:'spacing', l:'Ring spacing', t:'range', min:3, max:60, step:0.5, v:10, fmt:v=>v.toFixed(1)+' px' },
    { k:'wmin',    l:'Thinnest', t:'range', min:0, max:6, step:0.05, v:0.3, fmt:v=>v.toFixed(2)+' px' },
    { k:'wmax',    l:'Thickest', t:'range', min:0.5, max:30, step:0.5, v:6, fmt:v=>v.toFixed(1)+' px' },
    { k:'res',     l:'Circumference detail', t:'range', min:1, max:10, step:0.5, v:2, fmt:v=>v+' px' },
    { k:'crop',    l:'Shape', t:'select', v:'circle', opts:[['sheet','Fill the sheet'],['circle','Crop to a disc']] },
    { k:'outer',   l:'Disc size', t:'range', min:10, max:145, step:1, v:94, fmt:v=>v+'%' },
    { k:'spin',    l:'Rotate', t:'range', min:0, max:360, step:1, v:0, fmt:v=>v+'°' },
    { k:'cut',     l:'Skip lighter than', t:'range', min:0, max:255, step:1, v:255 },
    { k:'gamma',   l:'Tone curve', t:'range', min:0.3, max:3, step:0.05, v:1, fmt:v=>v.toFixed(2) }
  ]},
  stitch: { label:'Cross stitch', note:'Counted stitches on a square count. Light cells get a single half stitch, dark cells get the full cross.', controls:[
    { k:'count',  l:'Stitches down the sheet', t:'range', min:10, max:200, step:1, v:52 },
    { k:'angle',  l:'Cloth angle', t:'range', min:0, max:180, step:1, v:0, fmt:v=>v+'°' },
    { k:'weight', l:'Thread weight', t:'range', min:0.3, max:8, step:0.1, v:1.6, fmt:v=>v.toFixed(1)+' px' },
    { k:'half',   l:'Half stitch below', t:'range', min:0, max:100, step:1, v:45, fmt:v=>v+'%' },
    { k:'skip',   l:'Bare cloth below', t:'range', min:0, max:100, step:1, v:12, fmt:v=>v+'%' },
    { k:'weave',  l:'Weight follows tone', t:'check', v:true },
    { k:'cloth',  l:'Show the cloth grid', t:'check', v:false }
  ]},
  mosaic: { label:'Mosaic', note:'Irregular tiles set by hand, each one filled with the tone underneath and separated by grout. Raise irregularity for a rougher, stained-glass set.', controls:[
    { k:'size',   l:'Tile size', t:'range', min:6, max:120, step:1, v:28, fmt:v=>v+' px' },
    { k:'jitter', l:'Irregularity', t:'range', min:0, max:100, step:1, v:35, fmt:v=>v+'%' },
    { k:'grout',  l:'Grout width', t:'range', min:0, max:12, step:0.5, v:2, fmt:v=>v.toFixed(1)+' px' },
    { k:'groutStyle', l:'Grout', t:'select', v:'gap', opts:[['gap','Gap, no ink'],['ink','Ink, dark seams']] },
    { k:'gamma',  l:'Tone curve', t:'range', min:0.3, max:3, step:0.05, v:1, fmt:v=>v.toFixed(2) },
    { k:'cut',    l:'Skip tiles lighter than', t:'range', min:0, max:255, step:1, v:255 }
  ]},
  lace: { label:'Lace', note:'A net of eyelets and threads, thickest where the photo is darkest. Turn petals to zero for plain pearls, or up for a fuller filigree.', controls:[
    { k:'count',  l:'Cells down the sheet', t:'range', min:8, max:200, step:1, v:44 },
    { k:'angle',  l:'Grid angle', t:'range', min:0, max:180, step:1, v:0, fmt:v=>v+'°' },
    { k:'scale',  l:'Motif size', t:'range', min:0.2, max:1.4, step:0.02, v:0.9, fmt:v=>v.toFixed(2) },
    { k:'min',    l:'Smallest motif', t:'range', min:0, max:100, step:1, v:20, fmt:v=>v+'%' },
    { k:'petals', l:'Petals', t:'range', min:0, max:12, step:1, v:6 },
    { k:'weight', l:'Thread weight', t:'range', min:0.2, max:4, step:0.1, v:0.9, fmt:v=>v.toFixed(1)+' px' },
    { k:'cut',    l:'Skip cells lighter than', t:'range', min:0, max:255, step:1, v:235 },
    { k:'gamma',  l:'Tone curve', t:'range', min:0.3, max:3, step:0.05, v:1, fmt:v=>v.toFixed(2) }
  ]},
  graph: { label:'Graph', note:'Nodes placed by darkness, wired together like a network diagram or a state graph. Link distance sets the mesh, max links keeps it from turning into a hairball.', controls:[
    { k:'gap',    l:'Node spacing', t:'range', min:4, max:60, step:1, v:16, fmt:v=>v+' px' },
    { k:'count',  l:'Node limit', t:'range', min:50, max:6000, step:50, v:900 },
    { k:'gamma',  l:'Tone curve', t:'range', min:0.3, max:4, step:0.05, v:1.2, fmt:v=>v.toFixed(2) },
    { k:'cut',    l:'Ignore lighter than', t:'range', min:0, max:255, step:1, v:245 },
    { k:'link',   l:'Link distance', t:'range', min:10, max:220, step:2, v:70, fmt:v=>v+' px' },
    { k:'links',  l:'Max links per node', t:'range', min:1, max:8, step:1, v:3 },
    { k:'nodeSize', l:'Node size', t:'range', min:0.5, max:8, step:0.1, v:2, fmt:v=>v.toFixed(1)+' px' },
    { k:'weight', l:'Line weight', t:'range', min:0.2, max:4, step:0.1, v:0.8, fmt:v=>v.toFixed(1)+' px' }
  ]},
  scanlines: { label:'Scanlines', note:'Solid horizontal rows, thickening where the photo is dark, with the odd row dropped out — a CRT screen reading the picture.', controls:[
    { k:'spacing', l:'Row spacing', t:'range', min:2, max:30, step:0.5, v:6, fmt:v=>v.toFixed(1)+' px' },
    { k:'wmin',    l:'Thinnest', t:'range', min:0, max:4, step:0.05, v:0.2, fmt:v=>v.toFixed(2)+' px' },
    { k:'wmax',    l:'Thickest', t:'range', min:0.5, max:20, step:0.5, v:5, fmt:v=>v.toFixed(1)+' px' },
    { k:'res',     l:'Detail', t:'range', min:1, max:10, step:1, v:2, fmt:v=>v+' px' },
    { k:'dropout', l:'Row dropout', t:'range', min:0, max:60, step:1, v:8, fmt:v=>v+'%' },
    { k:'cut',     l:'Skip lighter than', t:'range', min:0, max:255, step:1, v:255 },
    { k:'gamma',   l:'Tone curve', t:'range', min:0.3, max:3, step:0.05, v:1, fmt:v=>v.toFixed(2) }
  ]},
  glitch: { label:'Glitch', note:'Horizontal bands sheared sideways at random, the way a bad signal tears a picture apart. Raise the chance for a rougher break-up.', controls:[
    { k:'band',   l:'Band height', t:'range', min:2, max:80, step:1, v:14, fmt:v=>v+' px' },
    { k:'shift',  l:'Max shift', t:'range', min:2, max:200, step:1, v:50, fmt:v=>v+' px' },
    { k:'chance', l:'Chance a band glitches', t:'range', min:0, max:100, step:1, v:45, fmt:v=>v+'%' },
    { k:'gamma',  l:'Tone curve', t:'range', min:0.3, max:3, step:0.05, v:1, fmt:v=>v.toFixed(2) }
  ]},
  ascii: { label:'ASCII', note:'Every cell becomes the character closest to its tone. Write your own ramp if you want it in your own alphabet. Exports as real text you can still edit.', controls:[
    { k:'cols',  l:'Columns', t:'range', min:10, max:300, step:1, v:80 },
    { k:'ramp',  l:'Characters', t:'select', v:'classic', opts:[['classic','. : - = + * # % @'],['soft',', ; o x % #'],['blocks','Block shading'],['round','. o O 0 @'],['binary','Full block only'],['code','Code punctuation'],['bars','Bars and slashes'],['stars','Sparse dots and stars'],['custom','Write my own']] },
    { k:'chars', l:'Your ramp, light to dark', t:'text', v:' .:-=+*#%@' },
    { k:'font',  l:'Typeface', t:'select', v:'mono', opts:[['mono','Monospace'],['sans','Sans'],['serif','Serif'],['narrow','Condensed'],['round','Rounded']] },
    { k:'bold',  l:'Bold', t:'check', v:false },
    { k:'aspect',l:'Cell shape', t:'range', min:0.3, max:1.6, step:0.02, v:0.58, fmt:v=>v.toFixed(2) },
    { k:'rowgap',l:'Line spacing', t:'range', min:0.5, max:2.2, step:0.02, v:1, fmt:v=>v.toFixed(2)+'×' },
    { k:'fit',   l:'Character size', t:'range', min:0.3, max:2, step:0.05, v:1, fmt:v=>v.toFixed(2) },
    { k:'tonesize', l:'Size follows tone', t:'range', min:0, max:100, step:1, v:0 },
    { k:'gamma', l:'Tone curve', t:'range', min:0.3, max:3, step:0.05, v:1, fmt:v=>v.toFixed(2) },
    { k:'jitter',l:'Position wobble', t:'range', min:0, max:100, step:1, v:0 },
    { k:'flip',  l:'Dark characters on light', t:'check', v:true }
  ]},
  scope: { label:'Oscilloscope', note:'Each row becomes a trace, rising and falling with the tone underneath — a readout off a signal, not a picture. Turn on the graticule for the screen grid.', controls:[
    { k:'channels', l:'Channels', t:'range', min:1, max:16, step:1, v:6 },
    { k:'amp',    l:'Amplitude', t:'range', min:0, max:100, step:1, v:70, fmt:v=>v+'%' },
    { k:'res',    l:'Trace resolution', t:'range', min:1, max:20, step:1, v:3, fmt:v=>v+' px' },
    { k:'gamma',  l:'Tone curve', t:'range', min:0.3, max:3, step:0.05, v:1, fmt:v=>v.toFixed(2) },
    { k:'weight', l:'Trace weight', t:'range', min:0.3, max:5, step:0.1, v:1.3, fmt:v=>v.toFixed(1)+' px' },
    { k:'grid',   l:'Graticule grid', t:'check', v:true },
    { k:'gridCols', l:'Grid columns', t:'range', min:2, max:20, step:1, v:10 }
  ]},
  stipple: { label:'Stipple', note:'A stamp placed by darkness. Even spacing pushes them apart so nothing clumps, which is what dotwork actually wants. Swap the stamp for a custom dither shape. The best plotter export in here.', controls:[
    { k:'shape',  l:'Stamp', t:'select', v:'circle', opts:[['circle','Circle'],['square','Square'],['diamond','Diamond'],['cross','Cross'],['star','Star'],['sparkle','Sparkle'],['heart','Heart'],['cloud','Cloud']] },
    { k:'spacing',l:'Placement', t:'select', v:'even', opts:[['even','Even spacing'],['scatter','Free scatter']] },
    { k:'gap',    l:'Closest spacing', t:'range', min:1, max:40, step:0.5, v:4, fmt:v=>v.toFixed(1)+' px' },
    { k:'count',  l:'Dot limit', t:'range', min:2000, max:400000, step:1000, v:120000, fmt:v=>(v/1000)+'k' },
    { k:'gamma',  l:'Tone curve', t:'range', min:0.3, max:4, step:0.05, v:1.1, fmt:v=>v.toFixed(2) },
    { k:'auto',   l:'Dot size follows spacing', t:'check', v:true },
    { k:'dot',    l:'Dot size', t:'range', min:0.3, max:14, step:0.1, v:1.2, fmt:v=>v.toFixed(1)+' px' },
    { k:'sizevar',l:'Size follows tone', t:'range', min:0, max:100, step:1, v:0 },
    { k:'wobble', l:'Size randomness', t:'range', min:0, max:100, step:1, v:0 },
    { k:'cutoff', l:'Ignore lighter than', t:'range', min:0, max:255, step:1, v:250 }
  ]},
  edge: { label:'Edge trace', note:'Sobel outline. Soften the photo first for thicker, calmer lines.', controls:[
    { k:'thresh', l:'Line threshold', t:'range', min:1, max:200, step:1, v:40 },
    { k:'gain',   l:'Line strength', t:'range', min:0.2, max:4, step:0.1, v:1, fmt:v=>v.toFixed(1) },
    { k:'thin',   l:'Keep strongest only', t:'check', v:false }
  ]},
  contour: { label:'Contour bands', note:'Posterises tone into layers and draws the boundaries. Topographic, foil-like.', controls:[
    { k:'levels', l:'Layers', t:'range', min:2, max:24, step:1, v:6 },
    { k:'offset', l:'Layer offset', t:'range', min:0, max:100, step:1, v:0 },
    { k:'fill',   l:'Fill alternate layers', t:'check', v:false }
  ]},
  trace: { label:'Outline trace', note:'Walks the boundary between light and dark and hands you real closed paths. This is the one to cut a stencil from.', controls:[
    { k:'levels', l:'Bands', t:'range', min:1, max:8, step:1, v:1 },
    { k:'cut',    l:'Cutoff', t:'range', min:10, max:245, step:1, v:128 },
    { k:'grid',   l:'Coarseness', t:'range', min:1, max:12, step:1, v:3, fmt:v=>v+' px' },
    { k:'weight', l:'Line weight', t:'range', min:0.3, max:8, step:0.1, v:1.6, fmt:v=>v.toFixed(1)+' px' },
    { k:'minlen', l:'Drop paths shorter than', t:'range', min:0, max:200, step:5, v:20, fmt:v=>v+' px' }
  ]},
  relief: { label:'Relief / Emboss', note:'Reads the photo as a raised surface and lights it from one side. Plaster, stamped leather, pressed paper, embossed card.', controls:[
    { k:'depth', l:'Depth', t:'range', min:0.2, max:20, step:0.2, v:4, fmt:v=>v.toFixed(1) },
    { k:'light', l:'Light direction', t:'range', min:0, max:360, step:1, v:315, fmt:v=>v+'°' },
    { k:'elev',  l:'Light height', t:'range', min:5, max:85, step:1, v:40, fmt:v=>v+'°' },
    { k:'soft',  l:'Bevel width', t:'range', min:0, max:30, step:1, v:3, fmt:v=>v+' px' },
    { k:'base',  l:'Surface tone', t:'range', min:0, max:70, step:1, v:0, fmt:v=>v+'%' },
    { k:'gain',  l:'Contrast', t:'range', min:0.2, max:4, step:0.05, v:1.4, fmt:v=>v.toFixed(2) },
    { k:'sunk',  l:'Sunk instead of raised', t:'check', v:false }
  ]},
  burn: { label:'Spray burn', note:'Scatters ink with a soft falloff. The airbrushed shadow in your moth prints.', controls:[
    { k:'count',  l:'Particles', t:'range', min:5000, max:400000, step:1000, v:80000, fmt:v=>(v/1000)+'k' },
    { k:'radius', l:'Spread', t:'range', min:0, max:120, step:0.5, v:6, fmt:v=>v.toFixed(1)+' px' },
    { k:'gamma',  l:'Tone curve', t:'range', min:0.3, max:4, step:0.05, v:1.6, fmt:v=>v.toFixed(2) },
    { k:'dot',    l:'Particle size', t:'range', min:0.3, max:8, step:0.1, v:0.8, fmt:v=>v.toFixed(1)+' px' }
  ]}
};

// display order for the Treatment grid — grouped by family so the two
// columns read as related pairs, rather than the dict's insertion order
const EFFECT_ORDER = (() => {
  const named = [
    'threshold', 'ordered', 'diffuse', 'pixelate',
    'halftone', 'dotmatrix', 'rings', 'spiral', 'mosaic',
    'crosshatch', 'engrave', 'ridge', 'scope', 'scanlines', 'glitch',
    'stitch', 'lace', 'graph',
    'stipple', 'burn',
    'edge', 'contour', 'trace', 'relief',
    'ascii'
  ].filter(k => EFFECTS[k]);
  const seen = new Set(named);
  return named.concat(Object.keys(EFFECTS).filter(k => !seen.has(k)));
})();

const MATRIX_CACHE = {};
function bayerMatrix(n){
  if (n <= 1) return [[0]];
  const s = bayerMatrix(n/2), m = [];
  for (let y=0; y<n; y++){
    m[y] = [];
    for (let x=0; x<n; x++){
      const q = s[y%(n/2)][x%(n/2)]*4;
      m[y][x] = q + [[0,2],[3,1]][y < n/2 ? 0 : 1][x < n/2 ? 0 : 1];
    }
  }
  return m;
}
// rank every cell in the tile, then hand out thresholds in that order
function rankMatrix(n, weight){
  const cells = [];
  for (let y=0; y<n; y++) for (let x=0; x<n; x++) cells.push([x,y,weight(x,y,n)]);
  cells.sort((a,b) => a[2]-b[2]);
  const m = Array.from({length:n}, () => new Array(n).fill(0));
  cells.forEach(([x,y],i) => { m[y][x] = i; });
  return m;
}
function getMatrix(pattern, n){
  const key = pattern + n;
  if (MATRIX_CACHE[key]) return MATRIX_CACHE[key];
  let m;
  if (pattern === 'bayer'){
    const p = clamp(Math.pow(2, Math.round(Math.log2(n))), 2, 16);
    m = bayerMatrix(p);
  } else if (pattern === 'cluster'){
    const c = (n-1)/2;
    m = rankMatrix(n, (x,y) => Math.hypot(x-c, y-c) + Math.atan2(y-c, x-c)*1e-4);
  } else if (pattern === 'lines'){
    const c = (n-1)/2;
    m = rankMatrix(n, (x,y) => Math.abs(y-c)*n + (x*5)%n * 1e-3);
  } else if (pattern === 'diagonal'){
    m = rankMatrix(n, (x,y) => ((x+y)%n) + ((x-y+2*n)%n)*1e-3);
  } else {
    const c = (n-1)/2;
    m = rankMatrix(n, (x,y) => Math.min(Math.abs(x-c), Math.abs(y-c)) + ((x+y)%n)*1e-3);
  }
  MATRIX_CACHE[key] = m;
  return m;
}

const KERNELS = {
  floyd:    { div:16, k:[[1,0,7],[-1,1,3],[0,1,5],[1,1,1]] },
  atkinson: { div:8,  k:[[1,0,1],[2,0,1],[-1,1,1],[0,1,1],[1,1,1],[0,2,1]] },
  jarvis:   { div:48, k:[[1,0,7],[2,0,5],[-2,1,3],[-1,1,5],[0,1,7],[1,1,5],[2,1,3],[-2,2,1],[-1,2,3],[0,2,5],[1,2,3],[2,2,1]] },
  stucki:   { div:42, k:[[1,0,8],[2,0,4],[-2,1,2],[-1,1,4],[0,1,8],[1,1,4],[2,1,2],[-2,2,1],[-1,2,2],[0,2,4],[1,2,2],[2,2,1]] },
  burkes:   { div:32, k:[[1,0,8],[2,0,4],[-2,1,2],[-1,1,4],[0,1,8],[1,1,4],[2,1,2]] },
  sierra3:  { div:32, k:[[1,0,5],[2,0,3],[-2,1,2],[-1,1,4],[0,1,5],[1,1,4],[2,1,2],[-1,2,2],[0,2,3],[1,2,2]] },
  sierra2:  { div:16, k:[[1,0,4],[2,0,3],[-2,1,1],[-1,1,2],[0,1,3],[1,1,2],[2,1,1]] },
  sierra:   { div:4,  k:[[1,0,2],[-1,1,1],[0,1,1]] },
  fan:      { div:16, k:[[1,0,7],[-2,1,1],[-1,1,3],[0,1,5]] }
};

/* ============================================================
   STAMP SHAPES
   A small library of normalised (-1..1) outlines shared by any
   treatment that places a mark by tone — the "dither shape".
   ============================================================ */
const STAMP_SHAPES = {
  circle: () => { const n=16, pts=[]; for(let i=0;i<n;i++){ const a=i/n*TAU; pts.push([Math.cos(a),Math.sin(a)]); } return pts; },
  square: () => [[-1,-1],[1,-1],[1,1],[-1,1]],
  diamond: () => [[0,-1],[1,0],[0,1],[-1,0]],
  cross: () => { const t=0.34; return [[-t,-1],[t,-1],[t,-t],[1,-t],[1,t],[t,t],[t,1],[-t,1],[-t,t],[-1,t],[-1,-t],[-t,-t]]; },
  star: () => { const spikes=5, pts=[]; for(let i=0;i<spikes*2;i++){ const a=i/(spikes*2)*TAU - Math.PI/2; const r=(i%2===0)?1:0.42; pts.push([Math.cos(a)*r, Math.sin(a)*r]); } return pts; },
  sparkle: () => { const spikes=4, pts=[]; for(let i=0;i<spikes*2;i++){ const a=i/(spikes*2)*TAU; const r=(i%2===0)?1:0.16; pts.push([Math.cos(a)*r, Math.sin(a)*r]); } return pts; },
  heart: () => { const n=28, pts=[]; for(let i=0;i<n;i++){ const t=i/n*TAU; const x=16*Math.pow(Math.sin(t),3); const y=-(13*Math.cos(t)-5*Math.cos(2*t)-2*Math.cos(3*t)-Math.cos(4*t)); pts.push([x/17, y/17]); } return pts; },
  cloud: () => { const n=24, pts=[]; for(let i=0;i<n;i++){ const a=i/n*TAU; const bump=1+0.18*Math.sin(a*3+0.6)+0.12*Math.sin(a*5-1.1); pts.push([Math.cos(a)*bump, Math.sin(a)*bump*0.72]); } return pts; }
};
const STAMP_CACHE = {};
function stampPoints(shape){
  if (!STAMP_CACHE[shape]) STAMP_CACHE[shape] = (STAMP_SHAPES[shape] || STAMP_SHAPES.circle)();
  return STAMP_CACHE[shape];
}
// absolute canvas-space points for a stamp at (cx,cy) with radius r
function stampAbsPoints(shape, cx, cy, r){
  return stampPoints(shape).map(([x,y]) => [cx+x*r, cy+y*r]);
}
function fillStamp(shape, cx, cy, r){
  const pts = stampPoints(shape);
  vctx.beginPath();
  pts.forEach(([x,y],i) => { const px=cx+x*r, py=cy+y*r; i===0 ? vctx.moveTo(px,py) : vctx.lineTo(px,py); });
  vctx.closePath();
  vctx.fill();
}

/* ---------- stroke plumbing shared by the line treatments ---------- */
function strokePts(pts, w){
  if (pts.length < 2) return;
  vctx.lineWidth = w;
  vctx.beginPath();
  vctx.moveTo(pts[0][0], pts[0][1]);
  for (let i=1; i<pts.length; i++) vctx.lineTo(pts[i][0], pts[i][1]);
  vctx.stroke();
}

/* ---------- dither family ---------- */
function fxThreshold(g,w,h,o){
  const b = Math.round(o.block);
  const c = coarsen(g,w,h,b);
  const mask = new Uint8Array(c.w*c.h);
  const soft = Math.max(o.edge, 0.0001);
  for (let i=0; i<mask.length; i++){
    const t = clamp((o.cut + soft/2 - c.g[i]) / soft, 0, 1);
    if (t > 0) mask[i] = Math.round(t*255);
  }
  blitMask(mask, c.w, c.h, b, w, h);
}

function fxPixelate(g,w,h,o){
  const b = Math.max(1, Math.round(o.size));
  const c = coarsen(g,w,h,b);
  const gap = clamp(o.gap, 0, b-0.5);
  const steps = o.levels >= 2 ? Math.round(o.levels) : 0;
  const W = c.w*b, H = c.h*b;
  beginCanvas(W,H);
  const items = [];
  const sz = b - gap;
  vctx.fillStyle = '#000';
  for (let y=0; y<c.h; y++){
    for (let x=0; x<c.w; x++){
      const avg = c.g[y*c.w+x];
      if (avg > o.cut) continue;
      let t = Math.pow(1 - avg/255, o.gamma);
      if (steps) t = Math.round(t*(steps-1))/(steps-1);
      const a = clamp(t,0,1);
      if (a <= 0.004 || sz <= 0) continue;
      vctx.fillStyle = a >= 0.99 ? '#000' : 'rgba(0,0,0,'+a.toFixed(3)+')';
      const px = x*b + gap/2, py = y*b + gap/2;
      vctx.fillRect(px, py, sz, sz);
      items.push([px, py, sz, sz, a]);
    }
  }
  vctx.fillStyle = '#000';
  state.vector = { kind:'rects', w:W, h:H, items };
}

function fxOrdered(g,w,h,o){
  const b = Math.round(o.lock ? o.scale : o.block);
  const c = coarsen(g,w,h,b);
  const mask = new Uint8Array(c.w*c.h);
  const s = o.lock ? 1 : Math.max(1, Math.round(o.scale));
  const shift = o.cut - 128;
  if (o.pattern === 'random'){
    for (let i=0; i<mask.length; i++) if (c.g[i] + shift < Math.random()*255) mask[i] = 255;
    blitMask(mask, c.w, c.h, b, w, h);
    return;
  }
  const m = getMatrix(o.pattern, Math.max(2, Math.round(o.size)));
  const n = m.length, area = n*n;
  for (let y=0; y<c.h; y++){
    const my = m[Math.floor(y/s)%n];
    for (let x=0; x<c.w; x++){
      const i = y*c.w+x;
      const t = (my[Math.floor(x/s)%n] + 0.5)/area * 255;
      if (c.g[i] + shift < t) mask[i] = 255;
    }
  }
  blitMask(mask, c.w, c.h, b, w, h);
}

function fxDiffuse(g,w,h,o){
  const b = Math.round(o.block);
  const c = coarsen(g,w,h,b);
  const mask = new Uint8Array(c.w*c.h);
  const buf = Float32Array.from(c.g);
  const K = KERNELS[o.kernel] || KERNELS.floyd;
  const amount = o.strength/100;
  const jitter = o.noise*1.28;
  for (let y=0; y<c.h; y++){
    const rev = o.serp && (y & 1);
    for (let n=0; n<c.w; n++){
      const x = rev ? c.w-1-n : n;
      const i = y*c.w+x;
      const old = buf[i];
      const cut = o.cut + (jitter ? (Math.random()-0.5)*jitter : 0);
      const nv = old < cut ? 0 : 255;
      if (nv === 0) mask[i] = 255;
      const err = (old - nv) * amount;
      if (err === 0) continue;
      for (const [dx,dy,wt] of K.k){
        const sx = x + (rev ? -dx : dx), sy = y + dy;
        if (sx<0 || sx>=c.w || sy>=c.h) continue;
        buf[sy*c.w+sx] += err * wt / K.div;
      }
    }
  }
  blitMask(mask, c.w, c.h, b, w, h);
}

/* ---------- screens and hatching ---------- */
function latticeBounds(w,h,cs,sn,stepU,stepV){
  stepV = stepV || stepU;
  let u0=1e9, u1=-1e9, v0=1e9, v1=-1e9;
  const cx=w/2, cy=h/2;
  for (const [px,py] of [[0,0],[w,0],[0,h],[w,h]]){
    const dx=px-cx, dy=py-cy;
    const u=( dx*cs + dy*sn)/stepU, v=(-dx*sn + dy*cs)/stepV;
    u0=Math.min(u0,u); u1=Math.max(u1,u); v0=Math.min(v0,v); v1=Math.max(v1,v);
  }
  return [Math.floor(u0)-1, Math.ceil(u1)+1, Math.floor(v0)-1, Math.ceil(v1)+1, cx, cy];
}

function fxScreen(g,w,h,o){
  beginCanvas(w,h);
  const items = [];
  const cellU = Math.max(2, h/Math.round(o.count));
  const cellV = o.grid === 'hex' ? cellU*0.866 : cellU;
  const rad = o.angle*Math.PI/180, cs = Math.cos(rad), sn = Math.sin(rad);
  const [u0,u1,v0,v1,cx,cy] = latticeBounds(w,h,cs,sn,cellU,cellV);
  if ((u1-u0)*(v1-v0) > 900000){
    setStatus('Too many cells for this working width');
    state.vector = null; return;
  }
  const ex0 = cs, ex1 = sn, ey0 = -sn, ey1 = cs;
  const half = cellU*0.5;
  const minS = o.min/100 * half;

  const quad = (px,py,ax,ay) => [
    [px + ex0*ax + ey0*ay, py + ex1*ax + ey1*ay],
    [px - ex0*ax + ey0*ay, py - ex1*ax + ey1*ay],
    [px - ex0*ax - ey0*ay, py - ex1*ax - ey1*ay],
    [px + ex0*ax - ey0*ay, py + ex1*ax - ey1*ay]
  ];
  const fillPoly = pts => {
    vctx.beginPath();
    vctx.moveTo(pts[0][0], pts[0][1]);
    for (let i=1; i<pts.length; i++) vctx.lineTo(pts[i][0], pts[i][1]);
    vctx.closePath(); vctx.fill();
    items.push({ t:'poly', p:pts });
  };

  // the continuous line screen keeps its own path building
  if (o.shape === 'line'){
    const flush = run => {
      for (let i=0; i<run.length-1; i++){
        const a = run[i], b = run[i+1];
        const th = (a[2]+b[2])/2;
        if (th < 0.1) continue;
        vctx.lineWidth = th; vctx.lineCap = 'butt';
        vctx.beginPath(); vctx.moveTo(a[0],a[1]); vctx.lineTo(b[0],b[1]); vctx.stroke();
        items.push({ t:'seg', p:[a[0],a[1],b[0],b[1]], w:th });
      }
    };
    for (let v=v0; v<=v1; v++){
      let run = [];
      const off = (o.grid !== 'regular' && (v & 1)) ? 0.5 : 0;
      for (let u=u0; u<=u1; u++){
        const px = cx + (u+off)*cellU*cs - v*cellV*sn;
        const py = cy + (u+off)*cellU*sn + v*cellV*cs;
        if (px < -cellU || py < -cellU || px > w+cellU || py > h+cellU){
          if (run.length){ flush(run); run = []; }
          continue;
        }
        const lum = sample(g,w,h,px,py);
        const tone = lum > o.cut ? 0 : Math.pow(1 - lum/255, o.gamma);
        run.push([px, py, Math.max(tone*cellV*o.scale, tone > 0 ? minS*2 : 0)]);
      }
      if (run.length) flush(run);
    }
    vctx.lineCap = 'round';
    state.vector = { kind:'marks', w, h, items };
    return;
  }

  for (let v=v0; v<=v1; v++){
    const off = (o.grid !== 'regular' && (v & 1)) ? 0.5 : 0;
    for (let u=u0; u<=u1; u++){
      const px = cx + (u+off)*cellU*cs - v*cellV*sn;
      const py = cy + (u+off)*cellU*sn + v*cellV*cs;
      if (px < -cellU || py < -cellU || px > w+cellU || py > h+cellU) continue;
      const lum = sample(g,w,h,px,py);
      if (lum > o.cut) continue;
      const tone = Math.pow(1 - lum/255, o.gamma);
      let sz = tone * half * o.scale;
      if (sz < minS) sz = minS;
      if (sz < 0.08) continue;
      if (o.shape === 'dot'){
        if (sz < 0.6) vctx.fillRect(px-sz, py-sz, sz*2, sz*2);
        else { vctx.beginPath(); vctx.arc(px,py,sz,0,TAU); vctx.fill(); }
        items.push({ t:'circle', x:px, y:py, r:sz });
      } else if (o.shape === 'square'){
        fillPoly(quad(px,py,sz,sz));
      } else if (o.shape === 'diamond'){
        fillPoly([[px+ex0*sz,py+ex1*sz],[px+ey0*sz,py+ey1*sz],[px-ex0*sz,py-ex1*sz],[px-ey0*sz,py-ey1*sz]]);
      } else if (o.shape === 'bar'){
        fillPoly(quad(px,py,sz,cellV*0.5));
      } else if (o.shape === 'cross'){
        const arm = Math.max(sz*0.32, 0.2);
        fillPoly(quad(px,py,sz,arm));
        fillPoly(quad(px,py,arm,sz));
      } else if (o.shape === 'ring'){
        const lw = Math.max(0.4, sz*0.42);
        vctx.lineWidth = lw;
        vctx.beginPath(); vctx.arc(px,py,Math.max(sz-lw/2,0.2),0,TAU); vctx.stroke();
        items.push({ t:'ring', x:px, y:py, r:Math.max(sz-lw/2,0.2), w:lw });
      } else if (STAMP_SHAPES[o.shape]){
        fillStamp(o.shape, px, py, sz);
        items.push({ p: stampAbsPoints(o.shape, px, py, sz) });
      }
    }
  }
  state.vector = { kind:'marks', w, h, items };
}

/* ---------- dot matrix: fixed-size dots, switched by a dither pattern ---------- */
function fxDotMatrix(g,w,h,o){
  beginCanvas(w,h);
  const items = [];
  const cell = Math.max(3, h/Math.round(o.count));
  const cols = Math.ceil(w/cell)+1, rows = Math.ceil(h/cell)+1;
  const m = o.pattern === 'random' ? null : getMatrix(o.pattern, Math.max(2, Math.round(o.matrixSize)));
  const n = m ? m.length : 1, area = n*n;
  const r = cell*0.5*(o.size/100);
  vctx.fillStyle = '#000';
  for (let gy=0; gy<rows; gy++){
    for (let gx=0; gx<cols; gx++){
      const px = gx*cell + cell/2, py = gy*cell + cell/2;
      if (px >= w || py >= h) continue;
      const lum = sample(g,w,h,px,py);
      if (lum > o.cut) continue;
      const tone = Math.pow(1 - lum/255, o.gamma);
      const on = o.pattern === 'random'
        ? Math.random() < tone
        : tone > (m[gy%n][gx%n] + 0.5)/area;
      if (!on || r < 0.15) continue;
      if (o.shape === 'square'){
        vctx.fillRect(px-r, py-r, r*2, r*2);
        items.push({ p:[[px-r,py-r],[px+r,py-r],[px+r,py+r],[px-r,py+r]] });
      } else {
        if (r < 0.6) vctx.fillRect(px-r, py-r, r*2, r*2);
        else { vctx.beginPath(); vctx.arc(px,py,r,0,TAU); vctx.fill(); }
        items.push({ t:'circle', x:px, y:py, r });
      }
    }
  }
  state.vector = { kind:'marks', w, h, items };
}

function fxCrosshatch(g,w,h,o){
  beginCanvas(w,h);
  const items = [];
  const layers = Math.round(o.layers);
  vctx.lineWidth = o.weight; vctx.lineCap = 'butt';
  for (let L=0; L<layers; L++){
    const rad = (o.angle + L*o.spread)*Math.PI/180;
    const cs = Math.cos(rad), sn = Math.sin(rad);
    const [u0,u1,v0,v1,cx,cy] = latticeBounds(w,h,cs,sn,o.spacing);
    const need = (L+1)/(layers+1);
    for (let v=v0; v<=v1; v++){
      let runStart = null, prev = null;
      const close = () => {
        if (runStart && prev && (Math.abs(prev[0]-runStart[0])+Math.abs(prev[1]-runStart[1])) > 1){
          vctx.beginPath(); vctx.moveTo(runStart[0],runStart[1]); vctx.lineTo(prev[0],prev[1]); vctx.stroke();
          items.push([runStart[0],runStart[1],prev[0],prev[1],o.weight]);
        }
        runStart = null;
      };
      for (let t=u0*o.spacing; t<=u1*o.spacing; t++){
        const px = cx + t*cs - (v*o.spacing)*sn;
        const py = cy + t*sn + (v*o.spacing)*cs;
        if (px<0 || py<0 || px>=w || py>=h){ close(); continue; }
        const tone = Math.pow(1 - g[(py|0)*w + (px|0)]/255, o.gamma);
        if (tone > need){ if (!runStart) runStart = [px,py]; prev = [px,py]; }
        else close();
      }
      close();
    }
  }
  vctx.lineCap = 'round';
  state.vector = { kind:'segs', w, h, items };
}

/* ---------- mosaic ---------- */
function fxMosaic(g,w,h,o){
  beginCanvas(w,h);
  const cell = Math.max(4, o.size);
  const jitter = clamp(o.jitter,0,100)/100;
  const grout = o.grout;
  const gamma = o.gamma;
  const groutInk = o.groutStyle === 'ink';
  const salt = (state.seed>>>0);
  const seedCache = new Map();
  function hash(cx,cy,s){
    let n = Math.imul(cx|0, 374761393) + Math.imul(cy|0, 668265263) + Math.imul(s|0, 2246822519) + Math.imul(salt, 3266489917);
    n = Math.imul(n ^ (n>>>13), 1274126177);
    return ((n ^ (n>>>16))>>>0) / 4294967296;
  }
  function seedPos(cx,cy){
    const key = cx+','+cy;
    let v = seedCache.get(key);
    if (!v){
      const hx = hash(cx,cy,1), hy = hash(cx,cy,2);
      v = [ (cx+0.5+(hx-0.5)*jitter)*cell, (cy+0.5+(hy-0.5)*jitter)*cell ];
      seedCache.set(key, v);
    }
    return v;
  }
  function nearest(px,py){
    const cx0 = Math.floor(px/cell), cy0 = Math.floor(py/cell);
    let best=Infinity, best2=Infinity, bx=0, by=0;
    for (let dy=-1; dy<=1; dy++){
      for (let dx=-1; dx<=1; dx++){
        const cx=cx0+dx, cy=cy0+dy;
        const s = seedPos(cx,cy);
        const ddx = px-s[0], ddy = py-s[1], d2 = ddx*ddx+ddy*ddy;
        if (d2<best){ best2=best; best=d2; bx=cx; by=cy; }
        else if (d2<best2) best2=d2;
      }
    }
    return { key: bx+','+by, d:Math.sqrt(best), d2:Math.sqrt(best2) };
  }
  const sums = new Map(), counts = new Map();
  const stride = Math.max(1, Math.floor(Math.min(w,h)/500));
  for (let y=0; y<h; y+=stride){
    for (let x=0; x<w; x+=stride){
      const n = nearest(x,y);
      sums.set(n.key, (sums.get(n.key)||0) + g[y*w+x]);
      counts.set(n.key, (counts.get(n.key)||0) + 1);
    }
  }
  const img = inkImage(w,h), d = img.data;
  for (let y=0; y<h; y++){
    for (let x=0; x<w; x++){
      const n = nearest(x,y);
      const i = y*w+x;
      if (n.d2 - n.d < grout){
        if (groutInk) put(d,i,255);
        continue;
      }
      const avg = counts.has(n.key) ? sums.get(n.key)/counts.get(n.key) : g[i];
      if (avg > o.cut) continue;
      const tone = Math.pow(1 - avg/255, gamma);
      const a = Math.round(clamp(tone,0,1)*255);
      if (a > 2) put(d,i,a);
    }
  }
  vctx.putImageData(img,0,0);
  state.vector = null;
}

function fxEngrave(g,w,h,o){
  beginCanvas(w,h);
  const items = [];
  const field = Float32Array.from(g);
  boxBlur(field, w, h, Math.round(o.smooth));
  const s = o.spacing;
  const steps = Math.max(2, Math.round(o.length/1.5));
  const fixed = 35*Math.PI/180;
  for (let sy=s/2; sy<h; sy+=s){
    for (let sx=(Math.round(sy/s)%2)*s/2 + s/2; sx<w; sx+=s){
      const lum = bilinear(g,w,h,sx,sy);
      if (lum > o.cutoff) continue;
      const tone = Math.pow(1 - lum/255, o.gamma);
      const pts = [];
      for (let dir=-1; dir<=1; dir+=2){
        let x = sx, y = sy;
        const run = [];
        for (let i=0; i<steps/2; i++){
          let ang;
          if (o.dir === 'fixed') ang = fixed;
          else {
            const gx = bilinear(field,w,h,x+1,y) - bilinear(field,w,h,x-1,y);
            const gy = bilinear(field,w,h,x,y+1) - bilinear(field,w,h,x,y-1);
            const m = Math.hypot(gx,gy);
            if (m < 0.6) ang = fixed;
            else ang = o.dir === 'across' ? Math.atan2(gy,gx) : Math.atan2(gx,-gy);
          }
          x += Math.cos(ang)*1.5*dir; y += Math.sin(ang)*1.5*dir;
          if (x<0||y<0||x>=w||y>=h) break;
          if (bilinear(g,w,h,x,y) > o.cutoff) break;
          run.push([x,y]);
        }
        if (dir === -1) { run.reverse(); pts.push(...run); pts.push([sx,sy]); }
        else pts.push(...run);
      }
      if (pts.length < 2) continue;
      const wgt = o.weight * (0.25 + tone);
      strokePts(pts, wgt);
      items.push({ p:pts, w:wgt });
    }
  }
  state.vector = { kind:'strokes', w, h, items };
}

function fxRidge(g,w,h,o){
  beginCanvas(w,h);
  const items = [];
  const sp = o.spacing, cx = w/2, cy = h/2;
  const tracks = [];
  if (o.layout === 'rows' || o.layout === 'cols'){
    const along = o.layout === 'rows' ? w : h;
    const across = o.layout === 'rows' ? h : w;
    for (let v = sp/2; v < across; v += sp){
      const pts = [];
      for (let t=0; t<=along; t++){
        if (o.layout === 'rows') pts.push([t, v, 0, -1]);
        else pts.push([v, t, -1, 0]);
      }
      tracks.push(pts);
    }
  } else if (o.layout === 'rings'){
    const maxR = Math.hypot(w,h)/2;
    for (let r = sp; r < maxR; r += sp){
      const pts = [];
      const n = Math.max(24, Math.round(TAU*r));
      for (let i=0; i<=n; i++){
        const a = i/n*TAU;
        pts.push([cx + Math.cos(a)*r, cy + Math.sin(a)*r, Math.cos(a), Math.sin(a)]);
      }
      tracks.push(pts);
    }
  } else {
    const maxR = Math.hypot(w,h)/2;
    const count = Math.max(6, Math.round(TAU*maxR/sp));
    for (let i=0; i<count; i++){
      const a = i/count*TAU, ca = Math.cos(a), sa = Math.sin(a);
      const pts = [];
      for (let r=0; r<=maxR; r++) pts.push([cx+ca*r, cy+sa*r, -sa, ca]);
      tracks.push(pts);
    }
  }
  const useDisp = o.mode !== 'weight', useW = o.mode !== 'displace';
  for (const track of tracks){
    let poly = [];
    let lastW = -1;
    const flush = () => {
      if (poly.length > 1){
        if (useW){
          for (let i=0; i<poly.length-1; i++){
            vctx.lineWidth = poly[i][2];
            vctx.beginPath(); vctx.moveTo(poly[i][0],poly[i][1]); vctx.lineTo(poly[i+1][0],poly[i+1][1]); vctx.stroke();
            items.push([poly[i][0],poly[i][1],poly[i+1][0],poly[i+1][1],poly[i][2]]);
          }
        } else {
          const p = poly.map(q=>[q[0],q[1]]);
          strokePts(p, o.weight);
          items.push({ p, w:o.weight });
        }
      }
      poly = [];
    };
    for (const [px,py,nx,ny] of track){
      if (px<0||py<0||px>=w||py>=h){ flush(); continue; }
      const lum = g[(py|0)*w+(px|0)];
      if (lum > o.floor){ flush(); continue; }
      const tone = Math.pow(1 - lum/255, o.gamma);
      const dx = useDisp ? nx*tone*o.amp : 0;
      const dy = useDisp ? ny*tone*o.amp : 0;
      const lw = useW ? Math.max(0.12, o.weight*(0.1 + tone*1.4)) : o.weight;
      poly.push([px+dx, py+dy, lw]);
    }
    flush();
  }
  state.vector = useW ? { kind:'segs', w, h, items } : { kind:'strokes', w, h, items };
}

/* ---------- dot treatments ---------- */
function stippleDot(x,y,r,items,shape){
  if (!shape || shape === 'circle'){
    if (r < 0.6) vctx.fillRect(x-r,y-r,r*2,r*2);
    else { vctx.beginPath(); vctx.arc(x,y,r,0,TAU); vctx.fill(); }
    items.push([x,y,r]);
  } else {
    fillStamp(shape, x, y, r);
    items.push({ p: stampAbsPoints(shape, x, y, r) });
  }
}

function fxStipple(g,w,h,o){
  beginCanvas(w,h);
  const items = [];
  const total = o.count;

  if (o.spacing === 'even'){
    // grow the dot field outwards from seeds so it packs properly,
    // with the spacing opening up as the picture gets lighter
    const gap = o.gap, capR = gap*6, cell = Math.max(1.5, gap);
    const gw = Math.ceil(w/cell)+1, gh = Math.ceil(h/cell)+1;
    const bins = new Array(gw*gh);
    const active = [];
    let placed = 0, budget = 2500000;

    const toneAt = (x,y) => {
      const lum = g[(y|0)*w + (x|0)];
      if (lum > o.cutoff) return -1;
      const t = Math.pow(1 - lum/255, o.gamma);
      return t <= 0.002 ? -1 : t;
    };
    const needAt = (x,y) => {
      const t = toneAt(x,y);
      return t < 0 ? -1 : Math.min(gap/Math.sqrt(t), capR);
    };
    const fits = (x,y,r) => {
      const bx0 = (x/cell)|0, by0 = (y/cell)|0, span = Math.ceil(r/cell);
      const rr = r*r;
      for (let by=by0-span; by<=by0+span; by++){
        if (by < 0 || by >= gh) continue;
        const row = by*gw;
        for (let bx=bx0-span; bx<=bx0+span; bx++){
          if (bx < 0 || bx >= gw) continue;
          const list = bins[row+bx];
          if (!list) continue;
          for (let k=0; k<list.length; k+=2){
            const dx = list[k]-x, dy = list[k+1]-y;
            if (dx*dx + dy*dy < rr) return false;
          }
        }
      }
      return true;
    };
    const accept = (x,y,t) => {
      const bi = ((y/cell)|0)*gw + ((x/cell)|0);
      if (bins[bi]) bins[bi].push(x,y); else bins[bi] = [x,y];
      active.push(x,y);
      const dia = o.auto ? gap*0.95 : o.dot;
      const wob = 1 + (o.wobble/100)*(Math.random()-0.5)*1.6;
      const r = dia*0.5*(1 + (o.sizevar/100)*(clamp(t,0,1)-0.5)*1.6)*wob;
      if (r > 0) stippleDot(x,y,r,items,o.shape);
      placed++;
    };
    const seed = () => {
      for (let t=0; t<3000 && budget>0; t++){
        budget--;
        const x = Math.random()*w, y = Math.random()*h;
        const r = needAt(x,y);
        if (r < 0 || !fits(x,y,r)) continue;
        accept(x, y, toneAt(x,y));
        return true;
      }
      return false;
    };

    while (placed < total && budget > 0){
      if (!active.length && !seed()) break;
      if (!active.length) break;
      const idx = ((Math.random()*(active.length/2))|0)*2;
      const px = active[idx], py = active[idx+1];
      const pr = needAt(px,py);
      let found = false;
      for (let k=0; k<10 && budget>0; k++){
        budget--;
        const a = Math.random()*TAU, d = (pr < 0 ? gap : pr)*(1 + Math.random());
        const x = px + Math.cos(a)*d, y = py + Math.sin(a)*d;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const r = needAt(x,y);
        if (r < 0 || !fits(x,y,r)) continue;
        accept(x, y, toneAt(x,y));
        found = true;
        break;
      }
      if (!found){
        const last = active.length-2;
        active[idx] = active[last]; active[idx+1] = active[last+1];
        active.length = last;
      }
    }
  } else {
    const maxTries = total*25;
    let placed = 0, tries = 0;
    while (placed < total && tries < maxTries){
      tries++;
      const x = Math.random()*w, y = Math.random()*h;
      const lum = g[(y|0)*w + (x|0)];
      if (lum > o.cutoff) continue;
      const tone = Math.pow(1 - lum/255, o.gamma);
      if (Math.random() > tone) continue;
      const wob = 1 + (o.wobble/100)*(Math.random()-0.5)*1.6;
      const r = o.dot*0.5*(1 + (o.sizevar/100)*(tone-0.5)*1.6)*wob;
      if (r <= 0) continue;
      stippleDot(x,y,r,items,o.shape);
      placed++;
    }
  }
  state.vector = { kind: (o.shape && o.shape !== 'circle') ? 'marks' : 'circles', w, h, items };
}

function fxBurn(g,w,h,o){
  beginCanvas(w,h);
  const items = [];
  const total = o.count, maxTries = total*20;
  let placed = 0, tries = 0;
  while (placed < total && tries < maxTries){
    tries++;
    const x = Math.random()*w, y = Math.random()*h;
    const lum = g[(y|0)*w + (x|0)];
    const tone = Math.pow(1 - lum/255, o.gamma);
    if (Math.random() > tone) continue;
    const u = Math.random(), v = Math.random();
    const gs = Math.sqrt(-2*Math.log(u+1e-9));
    const px = x + gs*Math.cos(TAU*v)*o.radius*0.5;
    const py = y + gs*Math.sin(TAU*v)*o.radius*0.5;
    if (px<0||py<0||px>w||py>h) continue;
    const r = o.dot*0.5;
    if (r < 0.6) vctx.fillRect(px-r,py-r,r*2,r*2);
    else { vctx.beginPath(); vctx.arc(px,py,r,0,TAU); vctx.fill(); }
    items.push([px,py,r]);
    placed++;
  }
  state.vector = { kind:'circles', w, h, items };
}

/* ---------- graph: nodes by darkness, wired to their neighbours ---------- */
function fxGraph(g,w,h,o){
  beginCanvas(w,h);
  const gap = o.gap, cell = Math.max(1.5, gap);
  const gw = Math.ceil(w/cell)+1, gh = Math.ceil(h/cell)+1;
  const bins = new Array(gw*gh);
  const nodes = [];
  const total = o.count, maxTries = total*40;
  let placed = 0, tries = 0;

  const fits = (x,y) => {
    const bx0 = (x/cell)|0, by0 = (y/cell)|0;
    for (let by=by0-1; by<=by0+1; by++){
      if (by < 0 || by >= gh) continue;
      const row = by*gw;
      for (let bx=bx0-1; bx<=bx0+1; bx++){
        if (bx < 0 || bx >= gw) continue;
        const list = bins[row+bx];
        if (!list) continue;
        for (const j of list){
          const dx = nodes[j].x-x, dy = nodes[j].y-y;
          if (dx*dx+dy*dy < gap*gap) return false;
        }
      }
    }
    return true;
  };

  while (placed < total && tries < maxTries){
    tries++;
    const x = Math.random()*w, y = Math.random()*h;
    const lum = g[(y|0)*w + (x|0)];
    if (lum > o.cut) continue;
    const tone = Math.pow(1 - lum/255, o.gamma);
    if (Math.random() > tone) continue;
    if (!fits(x,y)) continue;
    const bi = ((y/cell)|0)*gw + ((x/cell)|0);
    if (bins[bi]) bins[bi].push(nodes.length); else bins[bi] = [nodes.length];
    nodes.push({ x, y });
    placed++;
  }

  const linkR = o.link, linkR2 = linkR*linkR, maxLinks = Math.round(o.links);
  const seen = new Set();
  const items = [];
  vctx.lineWidth = o.weight;
  vctx.lineCap = 'round';
  for (let i=0; i<nodes.length; i++){
    const a = nodes[i];
    const bx0=(a.x/cell)|0, by0=(a.y/cell)|0, span=Math.ceil(linkR/cell);
    const cand = [];
    for (let by=by0-span; by<=by0+span; by++){
      if (by < 0 || by >= gh) continue;
      const row = by*gw;
      for (let bx=bx0-span; bx<=bx0+span; bx++){
        if (bx < 0 || bx >= gw) continue;
        const list = bins[row+bx];
        if (!list) continue;
        for (const j of list){
          if (j === i) continue;
          const b = nodes[j], dx=b.x-a.x, dy=b.y-a.y, d2=dx*dx+dy*dy;
          if (d2 <= linkR2) cand.push([j,d2]);
        }
      }
    }
    cand.sort((p,q) => p[1]-q[1]);
    for (let k=0; k<Math.min(maxLinks, cand.length); k++){
      const j = cand[k][0];
      const key = i<j ? i+'_'+j : j+'_'+i;
      if (seen.has(key)) continue;
      seen.add(key);
      const b = nodes[j];
      vctx.beginPath(); vctx.moveTo(a.x,a.y); vctx.lineTo(b.x,b.y); vctx.stroke();
      items.push({ t:'seg', p:[a.x,a.y,b.x,b.y], w:o.weight });
    }
  }

  const nr = o.nodeSize;
  vctx.fillStyle = '#000';
  nodes.forEach(n => {
    if (nr < 0.6) vctx.fillRect(n.x-nr, n.y-nr, nr*2, nr*2);
    else { vctx.beginPath(); vctx.arc(n.x,n.y,nr,0,TAU); vctx.fill(); }
    items.push({ t:'circle', x:n.x, y:n.y, r:nr });
  });

  state.vector = { kind:'marks', w, h, items };
}

/* ---------- scanlines: solid rows, thickness set by tone ---------- */
function fxScanlines(g,w,h,o){
  beginCanvas(w,h);
  const items = [];
  const step = o.spacing;
  vctx.lineCap = 'butt';
  for (let y=step/2; y<h; y+=step){
    if (Math.random()*100 < o.dropout) continue;
    let run = [], runW = -1;
    const flush = () => {
      if (run.length > 1 && runW > 0.04){
        vctx.lineWidth = runW;
        vctx.beginPath();
        vctx.moveTo(run[0][0], run[0][1]);
        for (let i=1; i<run.length; i++) vctx.lineTo(run[i][0], run[i][1]);
        vctx.stroke();
        items.push({ p:run, w:runW });
      }
      run = [];
    };
    const yi = Math.min(h-1, Math.round(y));
    for (let x=0; x<w; x+=Math.max(1,o.res)){
      const lum = sample(g,w,h,x,yi);
      if (lum > o.cut){ flush(); runW=-1; continue; }
      const tone = Math.pow(1 - lum/255, o.gamma);
      const lw = clamp(o.wmin + tone*(o.wmax-o.wmin), 0, step);
      if (Math.abs(lw-runW) > 1e-6){
        const tail = run.length ? run[run.length-1] : null;
        flush();
        runW = lw;
        if (tail) run.push(tail);
      }
      run.push([x,y]);
    }
    flush();
  }
  state.vector = { kind:'strokes', w, h, items };
}

/* ---------- glitch: bands sheared sideways ---------- */
function fxGlitch(g,w,h,o){
  beginCanvas(w,h);
  const img = inkImage(w,h), d = img.data;
  const bandH = Math.max(2, Math.round(o.band));
  const rng = mulberry32((state.seed ^ 0x9E3779B9) >>> 0);
  let y = 0;
  while (y < h){
    const bh = Math.min(h-y, bandH + Math.floor(rng()*bandH));
    const glitchy = rng()*100 < o.chance;
    const shift = glitchy ? Math.round((rng()-0.5)*2*o.shift) : 0;
    for (let yy=y; yy<y+bh; yy++){
      for (let x=0; x<w; x++){
        let sx = ((x - shift) % w + w) % w;
        const lum = g[yy*w + sx];
        let a = clamp(Math.pow(1 - lum/255, o.gamma), 0, 1);
        if (glitchy && rng() < 0.06) a = rng() < 0.5 ? 0 : 1;
        const alpha = Math.round(a*255);
        if (alpha > 2) put(d, yy*w+x, alpha);
      }
    }
    y += bh;
  }
  vctx.putImageData(img,0,0);
  state.vector = null;
}

/* ---------- outline treatments ---------- */
function fxEdge(g,w,h,o){
  beginCanvas(w,h);
  const img = inkImage(w,h), d = img.data;
  for (let y=1; y<h-1; y++){
    for (let x=1; x<w-1; x++){
      const i = y*w+x;
      const a=g[i-w-1], b=g[i-w], c=g[i-w+1], e=g[i-1], f=g[i+1], p=g[i+w-1], q=g[i+w], r=g[i+w+1];
      const gx = (c+2*f+r) - (a+2*e+p);
      const gy = (p+2*q+r) - (a+2*b+c);
      const m = Math.hypot(gx,gy) * o.gain;
      if (o.thin){ if (m > o.thresh) put(d,i,255); }
      else {
        const al = clamp((m - o.thresh)/Math.max(o.thresh,1)*255, 0, 255);
        if (al > 2) put(d,i,Math.round(al));
      }
    }
  }
  vctx.putImageData(img,0,0);
  state.vector = null;
}

function fxContour(g,w,h,o){
  beginCanvas(w,h);
  const img = inkImage(w,h), d = img.data;
  const n = o.levels, off = o.offset/100;
  const lv = new Uint8Array(w*h);
  for (let i=0; i<g.length; i++) lv[i] = clamp(Math.floor((g[i]/255)*n + off), 0, n);
  for (let y=0; y<h; y++){
    for (let x=0; x<w; x++){
      const i = y*w+x, here = lv[i];
      const right = x<w-1 ? lv[i+1] : here;
      const down  = y<h-1 ? lv[i+w] : here;
      if (here !== right || here !== down) put(d,i,255);
      else if (o.fill && (here & 1)) put(d,i,255);
    }
  }
  vctx.putImageData(img,0,0);
  state.vector = null;
}

/* marching squares, then stitch the segments into paths */
function marchingSquares(g,w,h,iso){
  const segs = [];
  const at = (x,y) => g[y*w+x];
  const lerp = (a,b) => Math.abs(b-a) < 1e-9 ? 0.5 : (iso-a)/(b-a);
  for (let y=0; y<h-1; y++){
    for (let x=0; x<w-1; x++){
      const v00=at(x,y), v10=at(x+1,y), v11=at(x+1,y+1), v01=at(x,y+1);
      let idx = 0;
      if (v00 < iso) idx |= 1;
      if (v10 < iso) idx |= 2;
      if (v11 < iso) idx |= 4;
      if (v01 < iso) idx |= 8;
      if (idx === 0 || idx === 15) continue;
      const T = [x+lerp(v00,v10), y];
      const R = [x+1, y+lerp(v10,v11)];
      const B = [x+lerp(v01,v11), y+1];
      const L = [x, y+lerp(v00,v01)];
      const push = (a,b) => segs.push([a[0],a[1],b[0],b[1]]);
      switch (idx){
        case 1: case 14: push(L,T); break;
        case 2: case 13: push(T,R); break;
        case 3: case 12: push(L,R); break;
        case 4: case 11: push(R,B); break;
        case 6: case 9:  push(T,B); break;
        case 7: case 8:  push(L,B); break;
        case 5:  push(L,T); push(R,B); break;
        case 10: push(L,B); push(T,R); break;
      }
    }
  }
  return segs;
}

function stitch(segs, tol){
  const key = (x,y) => Math.round(x/tol) + ',' + Math.round(y/tol);
  const map = new Map();
  const add = (k,i) => { const a = map.get(k); if (a) a.push(i); else map.set(k,[i]); };
  segs.forEach((s,i) => { add(key(s[0],s[1]),i); add(key(s[2],s[3]),i); });
  const used = new Uint8Array(segs.length);
  const out = [];
  const near = (a,b) => Math.abs(a[0]-b[0]) < tol && Math.abs(a[1]-b[1]) < tol;
  for (let i=0; i<segs.length; i++){
    if (used[i]) continue;
    used[i] = 1;
    const s = segs[i];
    const pts = [[s[0],s[1]],[s[2],s[3]]];
    for (let dir=0; dir<2; dir++){
      let end = dir ? pts[0] : pts[pts.length-1];
      for (let guard=0; guard<200000; guard++){
        const list = map.get(key(end[0],end[1]));
        if (!list) break;
        let nxt = -1;
        for (const j of list) if (!used[j]){ nxt = j; break; }
        if (nxt < 0) break;
        used[nxt] = 1;
        const t = segs[nxt];
        const a = [t[0],t[1]], b = [t[2],t[3]];
        const step = near(a,end) ? b : a;
        if (dir) pts.unshift(step); else pts.push(step);
        end = step;
      }
    }
    out.push(pts);
  }
  return out;
}

function fxTrace(g,w,h,o){
  const b = Math.round(o.grid);
  const c = coarsen(g,w,h,b);
  beginCanvas(w,h);
  const items = [];
  const n = Math.round(o.levels);
  for (let L=0; L<n; L++){
    const iso = n === 1 ? o.cut : (o.cut * (L+1)/n + 255*0.08);
    const polys = stitch(marchingSquares(c.g, c.w, c.h, clamp(iso,2,253)), 0.35);
    for (const p of polys){
      let len = 0;
      for (let i=1; i<p.length; i++) len += Math.hypot(p[i][0]-p[i-1][0], p[i][1]-p[i-1][1]);
      if (len*b < o.minlen) continue;
      const pts = p.map(q => [q[0]*b + b/2, q[1]*b + b/2]);
      strokePts(pts, o.weight);
      items.push({ p:pts, w:o.weight });
    }
  }
  state.vector = { kind:'strokes', w, h, items };
}

/* ---------- spiral screen ---------- */
function fxSpiral(g,w,h,o){
  beginCanvas(w,h);
  const items = [];
  const cx = w/2, cy = h/2;
  const disc = o.crop === 'circle';
  const rOut = disc ? Math.min(w,h)/2 * (o.outer/100) : Math.hypot(w,h)/2;
  const rIn = disc ? rOut*(o.inner/100) : Math.min(w,h)/2*(o.inner/100);
  const maxR = rOut + o.spacing;
  const b = o.spacing/TAU;
  const rot = o.angle*Math.PI/180;
  const cs = Math.cos(rot), sn = Math.sin(rot);
  const levels = 16;
  const span = Math.max(o.wmax - o.wmin, 0.001);
  let th = Math.max(rIn/Math.max(b,1e-6), 0.5);
  let run = [], runW = -1;
  const flush = () => {
    if (run.length > 1 && runW > 0.04){
      vctx.lineWidth = runW;
      vctx.beginPath();
      vctx.moveTo(run[0][0], run[0][1]);
      for (let i=1; i<run.length; i++) vctx.lineTo(run[i][0], run[i][1]);
      vctx.stroke();
      items.push({ p:run, w:runW });
    }
    run = [];
  };
  let guard = 0;
  while (b*th < maxR && guard++ < 400000){
    const r = b*th;
    const px0 = Math.cos(th)*r, py0 = Math.sin(th)*r;
    const px = cx + px0*cs - py0*sn, py = cy + px0*sn + py0*cs;
    th += 1.7/Math.max(r, 1.5);
    if (px < 0 || py < 0 || px >= w || py >= h || r > rOut || r < rIn){ flush(); runW = -1; continue; }
    const tone = Math.pow(1 - g[(py|0)*w + (px|0)]/255, o.gamma);
    const raw = o.wmin + tone*span;
    const q = Math.round(raw/span*levels)/levels*span + o.wmin;
    if (Math.abs(q - runW) > 1e-6){
      const tail = run.length ? run[run.length-1] : null;
      flush();
      runW = q;
      if (tail) run.push(tail);
    }
    run.push([px,py]);
  }
  flush();
  if (o.ring){
    const edge = (rad2, lw) => {
      if (rad2 <= 0.5) return;
      const pts = [];
      const n = Math.max(48, Math.round(rad2*1.2));
      for (let i=0; i<=n; i++){
        const a = i/n*TAU;
        pts.push([cx + Math.cos(a)*rad2, cy + Math.sin(a)*rad2]);
      }
      strokePts(pts, lw);
      items.push({ p:pts, w:lw });
    };
    edge(rOut, o.wmax*0.6);
    if (rIn > 0.5) edge(rIn, o.wmax*0.6);
  }
  state.vector = { kind:'strokes', w, h, items };
}

/* ---------- rings: concentric circles, thickness set by tone ---------- */
function fxRings(g,w,h,o){
  beginCanvas(w,h);
  const items = [];
  const cx = w/2, cy = h/2;
  const disc = o.crop === 'circle';
  const maxR = disc ? Math.min(w,h)/2 * (o.outer/100) : Math.hypot(w,h)/2;
  const spacing = o.spacing;
  const spin = o.spin*Math.PI/180;
  vctx.lineCap = 'butt';
  for (let r=spacing; r<maxR; r+=spacing){
    const n = Math.max(24, Math.round(TAU*r/Math.max(1,o.res)));
    let run = [], runW = -1;
    const flush = () => {
      if (run.length > 1 && runW > 0.04){
        vctx.lineWidth = runW;
        vctx.beginPath();
        vctx.moveTo(run[0][0], run[0][1]);
        for (let i=1; i<run.length; i++) vctx.lineTo(run[i][0], run[i][1]);
        vctx.stroke();
        items.push({ p:run, w:runW });
      }
      run = [];
    };
    for (let i=0; i<=n; i++){
      const a = i/n*TAU + spin;
      const px = cx+Math.cos(a)*r, py = cy+Math.sin(a)*r;
      if (px<0 || py<0 || px>=w || py>=h){ flush(); runW=-1; continue; }
      const lum = sample(g,w,h,px,py);
      if (lum > o.cut){ flush(); runW=-1; continue; }
      const tone = Math.pow(1 - lum/255, o.gamma);
      const lw = clamp(o.wmin + tone*(o.wmax-o.wmin), 0, 40);
      if (Math.abs(lw-runW) > 1e-6){
        const tail = run.length ? run[run.length-1] : null;
        flush();
        runW = lw;
        if (tail) run.push(tail);
      }
      run.push([px,py]);
    }
    flush();
  }
  state.vector = { kind:'strokes', w, h, items };
}

/* ---------- cross stitch ---------- */
function fxStitch(g,w,h,o){
  beginCanvas(w,h);
  const items = [];
  const cell = Math.max(3, h/Math.round(o.count));
  const rad = o.angle*Math.PI/180, cs = Math.cos(rad), sn = Math.sin(rad);
  const [u0,u1,v0,v1,cx,cy] = latticeBounds(w,h,cs,sn,cell);
  if ((u1-u0)*(v1-v0) > 400000){ setStatus('Too many stitches for this working width'); state.vector = null; return; }
  const ex0 = cs, ex1 = sn, ey0 = -sn, ey1 = cs;
  const arm = cell*0.42;
  const skip = o.skip/100, half = o.half/100;
  vctx.lineCap = 'round';
  const line = (ax,ay,bx,by,lw) => {
    vctx.lineWidth = lw;
    vctx.beginPath(); vctx.moveTo(ax,ay); vctx.lineTo(bx,by); vctx.stroke();
    items.push([ax,ay,bx,by,lw]);
  };
  if (o.cloth){
    const lw = Math.max(0.3, cell*0.05);
    for (let v=v0; v<=v1; v++){
      const a = [cx + u0*cell*cs - (v+0.5)*cell*sn, cy + u0*cell*sn + (v+0.5)*cell*cs];
      const b = [cx + u1*cell*cs - (v+0.5)*cell*sn, cy + u1*cell*sn + (v+0.5)*cell*cs];
      line(a[0],a[1],b[0],b[1],lw);
    }
    for (let u=u0; u<=u1; u++){
      const a = [cx + (u+0.5)*cell*cs - v0*cell*sn, cy + (u+0.5)*cell*sn + v0*cell*cs];
      const b = [cx + (u+0.5)*cell*cs - v1*cell*sn, cy + (u+0.5)*cell*sn + v1*cell*cs];
      line(a[0],a[1],b[0],b[1],lw);
    }
  }
  for (let v=v0; v<=v1; v++){
    for (let u=u0; u<=u1; u++){
      const px = cx + u*cell*cs - v*cell*sn;
      const py = cy + u*cell*sn + v*cell*cs;
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      const tone = 1 - sample(g,w,h,px,py)/255;
      if (tone < skip) continue;
      const lw = o.weave ? Math.max(0.3, o.weight*(0.45 + tone)) : o.weight;
      const a = [px - ex0*arm - ey0*arm, py - ex1*arm - ey1*arm];
      const c = [px + ex0*arm + ey0*arm, py + ex1*arm + ey1*arm];
      line(a[0],a[1],c[0],c[1],lw);
      if (tone >= half){
        const b2 = [px + ex0*arm - ey0*arm, py + ex1*arm - ey1*arm];
        const d2 = [px - ex0*arm + ey0*arm, py - ex1*arm + ey1*arm];
        line(b2[0],b2[1],d2[0],d2[1],lw);
      }
    }
  }
  state.vector = { kind:'segs', w, h, items };
}

/* ---------- lace ---------- */
function fxLace(g,w,h,o){
  beginCanvas(w,h);
  const items = [];
  const cellU = Math.max(6, h/Math.round(o.count));
  const rad = o.angle*Math.PI/180, cs = Math.cos(rad), sn = Math.sin(rad);
  const [u0,u1,v0,v1,cx,cy] = latticeBounds(w,h,cs,sn,cellU);
  const pos = (u,v) => [cx + u*cellU*cs - v*cellU*sn, cy + u*cellU*sn + v*cellU*cs];
  const info = new Map();
  const at = (u,v) => {
    const key = u+','+v;
    if (info.has(key)) return info.get(key);
    const [px,py] = pos(u,v);
    let rec = null;
    if (px>=0 && py>=0 && px<w && py<h){
      const lum = sample(g,w,h,px,py);
      if (lum <= o.cut){
        const tone = Math.pow(1 - lum/255, o.gamma);
        const sz = Math.max(o.min/100 * cellU*0.5, tone * cellU*0.5 * o.scale);
        if (sz > 0.3) rec = { px, py, sz };
      }
    }
    info.set(key, rec);
    return rec;
  };
  const addStroke = pts => { strokePts(pts, o.weight); items.push({ p:pts, w:o.weight }); };
  const ring = (px,py,r) => {
    const pts = [];
    const n = 20;
    for (let i=0; i<=n; i++){ const a = i/n*TAU; pts.push([px+Math.cos(a)*r, py+Math.sin(a)*r]); }
    addStroke(pts);
  };
  const thread = (a,b) => {
    const mx=(a.px+b.px)/2, my=(a.py+b.py)/2;
    const dx=b.px-a.px, dy=b.py-a.py, len=Math.hypot(dx,dy)||1;
    const nx=-dy/len, ny=dx/len, bulge=cellU*0.1;
    const bx=mx+nx*bulge, by=my+ny*bulge;
    const pts = [];
    const n = 10;
    for (let i=0; i<=n; i++){
      const t = i/n;
      pts.push([
        (1-t)*(1-t)*a.px + 2*(1-t)*t*bx + t*t*b.px,
        (1-t)*(1-t)*a.py + 2*(1-t)*t*by + t*t*b.py
      ]);
    }
    addStroke(pts);
  };
  const petals = Math.round(o.petals);
  for (let v=v0; v<=v1; v++){
    for (let u=u0; u<=u1; u++){
      const a = at(u,v);
      if (!a) continue;
      ring(a.px, a.py, a.sz*0.55);
      for (let i=0; i<petals; i++){
        const ang = i/petals*TAU;
        const x1 = a.px+Math.cos(ang)*a.sz*0.55, y1 = a.py+Math.sin(ang)*a.sz*0.55;
        const x2 = a.px+Math.cos(ang)*a.sz, y2 = a.py+Math.sin(ang)*a.sz;
        addStroke([[x1,y1],[x2,y2]]);
      }
      const r = at(u+1, v); if (r) thread(a, r);
      const dn = at(u, v+1); if (dn) thread(a, dn);
    }
  }
  state.vector = { kind:'strokes', w, h, items };
}

/* ---------- ascii ---------- */
const RAMPS = {
  classic: ' .:-=+*#%@',
  soft:    ' .,:;ox%#@',
  blocks:  ' ░▒▓█',
  round:   ' .oO0@',
  binary:  ' █',
  code:    ' .`^",;/|)i1}?LCJUYX0Z#MW&8%B@',
  bars:    ' .─│╱╲┼█',
  stars:   ' .·*✴✶●'
};
const ASCII_FONTS = {
  mono:   '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  sans:   '"Helvetica Neue", Helvetica, Arial, sans-serif',
  serif:  'Georgia, "Times New Roman", serif',
  narrow: '"Arial Narrow", "Helvetica Neue", Impact, sans-serif',
  round:  '"Trebuchet MS", Verdana, sans-serif'
};
function fxAscii(g,w,h,o){
  beginCanvas(w,h);
  const items = [];
  const cols = Math.round(o.cols);
  const cw = w/cols;
  const chh = cw/Math.max(o.aspect, 0.05) * o.rowgap;
  const rows = Math.ceil(h/chh);
  const ramp = (o.ramp === 'custom' ? (o.chars || ' .:-=+*#%@') : (RAMPS[o.ramp] || RAMPS.classic));
  const n = Math.max(ramp.length - 1, 1);
  const family = ASCII_FONTS[o.font] || ASCII_FONTS.mono;
  const weight = o.bold ? '700 ' : '';
  const base = chh*0.95*o.fit;
  const wob = o.jitter/100 * cw * 0.5;
  vctx.textAlign = 'center';
  vctx.textBaseline = 'middle';
  for (let r=0; r<rows; r++){
    for (let c=0; c<cols; c++){
      let sum = 0, k = 0;
      for (let sy=0; sy<3; sy++) for (let sx=0; sx<3; sx++){
        sum += sample(g,w,h, (c + (sx+0.5)/3)*cw, (r + (sy+0.5)/3)*chh); k++;
      }
      const lum = sum/k;
      let t = Math.pow(clamp(1 - lum/255, 0, 1), o.gamma);
      if (!o.flip) t = 1-t;
      const glyph = ramp[clamp(Math.round(t*n), 0, n)];
      if (!glyph || glyph === ' ') continue;
      const size = base * (1 + (o.tonesize/100)*(t-0.5)*1.6);
      if (size < 0.6) continue;
      let x = (c+0.5)*cw, y = (r+0.5)*chh;
      if (wob){ x += (Math.random()-0.5)*wob; y += (Math.random()-0.5)*wob; }
      vctx.font = weight + (Math.round(size*100)/100) + 'px ' + family;
      vctx.fillText(glyph, x, y);
      items.push({ x, y, s:glyph, size });
    }
  }
  vctx.textAlign = 'start'; vctx.textBaseline = 'alphabetic';
  state.vector = { kind:'glyphs', w, h, items, family, weight: o.bold ? 700 : 400 };
}

/* ---------- oscilloscope: rows read as traces, plus a graticule ---------- */
function fxScope(g,w,h,o){
  beginCanvas(w,h);
  const items = [];
  const addStroke = (pts, lw) => {
    vctx.lineWidth = lw;
    vctx.beginPath();
    vctx.moveTo(pts[0][0], pts[0][1]);
    for (let i=1; i<pts.length; i++) vctx.lineTo(pts[i][0], pts[i][1]);
    vctx.stroke();
    items.push({ p:pts, w:lw });
  };
  const rows = Math.max(1, Math.round(o.channels));
  const rowH = h/rows;
  const amp = clamp(o.amp,0,100)/100 * rowH*0.48;

  if (o.grid){
    const dashLW = Math.max(0.3, o.weight*0.3);
    vctx.save();
    vctx.setLineDash([2,5]);
    const cols = Math.max(2, Math.round(o.gridCols));
    for (let c=1; c<cols; c++){ const x=c/cols*w; addStroke([[x,0],[x,h]], dashLW); }
    for (let r=0; r<rows; r++){ const y=(r+0.5)*rowH; addStroke([[0,y],[w,y]], dashLW); }
    vctx.restore();
    vctx.setLineDash([]);
  }

  const steps = Math.max(24, Math.round(w/Math.max(1,o.res)));
  for (let r=0; r<rows; r++){
    const base = (r+0.5)*rowH;
    const pts = [];
    for (let i=0; i<=steps; i++){
      const x = i/steps*w;
      const lum = bilinear(g,w,h,x, base);
      const tone = Math.pow(1 - lum/255, o.gamma);
      pts.push([x, base - (tone-0.5)*2*amp]);
    }
    addStroke(pts, o.weight);
  }
  state.vector = { kind:'strokes', w, h, items };
}

/* ---------- relief ---------- */
function fxRelief(g,w,h,o){
  beginCanvas(w,h);
  const hgt = Float32Array.from(g);
  if (!o.sunk) for (let i=0; i<hgt.length; i++) hgt[i] = 255 - hgt[i];
  if (o.soft > 0) boxBlur(hgt, w, h, Math.round(o.soft));
  const az = o.light*Math.PI/180, el = o.elev*Math.PI/180;
  const lx = Math.cos(az)*Math.cos(el), ly = Math.sin(az)*Math.cos(el), lz = Math.sin(el);
  const k = o.depth/60;
  const flat = Math.max(lz, 0.001);
  const base = o.base/100;
  const img = inkImage(w,h), d = img.data;
  for (let y=1; y<h-1; y++){
    for (let x=1; x<w-1; x++){
      const i = y*w+x;
      const gx = (hgt[i+1] - hgt[i-1])*k;
      const gy = (hgt[i+w] - hgt[i-w])*k;
      const inv = 1/Math.sqrt(gx*gx + gy*gy + 1);
      const diff = (-gx*lx - gy*ly + lz)*inv;
      let val = clamp(diff/flat, 0, 2);
      val = clamp((val-1)*o.gain + 1, 0, 1);
      const a = clamp(1 - val + base, 0, 1);
      if (a > 0.004) put(d, i, Math.round(a*255));
    }
  }
  vctx.putImageData(img,0,0);
  state.vector = null;
}

const RUNNERS = {
  threshold:fxThreshold, pixelate:fxPixelate, ordered:fxOrdered, diffuse:fxDiffuse, halftone:fxScreen,
  dotmatrix:fxDotMatrix, spiral:fxSpiral, rings:fxRings, crosshatch:fxCrosshatch, engrave:fxEngrave, ridge:fxRidge,
  stitch:fxStitch, mosaic:fxMosaic, lace:fxLace, graph:fxGraph, scanlines:fxScanlines, glitch:fxGlitch,
  ascii:fxAscii, scope:fxScope, stipple:fxStipple, edge:fxEdge, contour:fxContour, trace:fxTrace,
  relief:fxRelief, burn:fxBurn
};

function renderImage(){
  if (!state.srcImage){
    beginCanvas(1000,1000);
    state.vector = null;
    setStatus('Drop a photo on the left, or switch to System');
    updateReadout();
    return;
  }
  const targetW = Number($('#res').value);
  const ratio = state.srcImage.naturalHeight / state.srcImage.naturalWidth;
  const w = Math.round(targetW), h = Math.max(1, Math.round(targetW*ratio));
  state.work.width = w; state.work.height = h;
  const wctx = state.work.getContext('2d', { willReadFrequently:true });
  wctx.clearRect(0,0,w,h);
  wctx.drawImage(state.srcImage, 0, 0, w, h);
  if (state.mask){
    wctx.globalCompositeOperation = 'destination-out';
    wctx.drawImage(state.mask, 0, 0, w, h);
    wctx.globalCompositeOperation = 'source-over';
  }
  if (state.pre.sym && state.pre.sym !== 'none') applySymmetry(state.work, state.pre.sym, state.pre.symN);
  const t0 = performance.now();
  const { g } = prepare();
  let label;
  if (state.activeEffects.length <= 1){
    const key = state.activeEffects[0] || state.effect;
    RUNNERS[key](g, w, h, state.fxAll[key]);
    label = EFFECTS[key].label;
  } else {
    const snaps = [];
    let lastVector = null;
    state.activeEffects.forEach(key => {
      RUNNERS[key](g, w, h, state.fxAll[key] || (state.fxAll[key] = {}));
      lastVector = state.vector;
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(view, 0, 0);
      snaps.push(c);
    });
    beginCanvas(w,h);
    snaps.forEach(c => vctx.drawImage(c,0,0));
    state.vector = lastVector;
    label = state.activeEffects.map(k => EFFECTS[k].label).join(' + ');
  }
  compositeLayers();
  setStatus(label + ' · ' + Math.round(performance.now()-t0) + ' ms');
  measureInk();
  updateReadout();
}

/* ============================================================
   SYSTEMS — attractors, flows, pendulums
   ============================================================ */
const D = (k,l,min,max,step,v) => ({ k, l, t:'range', min, max, step, v, fmt:x=>Number(x).toFixed(3) });

const SYSTEMS = {
  dejong: { label:'De Jong attractor', kind:'map', suggest:{draw:'dots',points:900000,exposure:1,gamma:0.55}, start:[0.1,0.1],
    note:'Four dials, endless variety. The dense wing shapes in your particle prints.',
    dials:[D('a','a',-3,3,0.001,1.641), D('b','b',-3,3,0.001,1.902), D('c','c',-3,3,0.001,0.316), D('d','d',-3,3,0.001,1.525)],
    f:(x,y,p)=>[Math.sin(p.a*y)-Math.cos(p.b*x), Math.sin(p.c*x)-Math.cos(p.d*y)] },

  clifford: { label:'Clifford attractor', kind:'map', suggest:{draw:'dots',points:900000,exposure:1,gamma:0.55}, start:[0.1,0.1],
    note:'Softer, more looping than De Jong. Good for shoulder and spine shapes.',
    dials:[D('a','a',-2.5,2.5,0.001,-1.4), D('b','b',-2.5,2.5,0.001,1.6), D('c','c',-2.5,2.5,0.001,1.0), D('d','d',-2.5,2.5,0.001,0.7)],
    f:(x,y,p)=>[Math.sin(p.a*y)+p.c*Math.cos(p.a*x), Math.sin(p.b*x)+p.d*Math.cos(p.b*y)] },

  svensson: { label:'Svensson attractor', kind:'map', suggest:{draw:'dots',points:900000,exposure:1,gamma:0.55}, start:[0.1,0.1],
    note:'Sharp folds and hard creases. Reads well small.',
    dials:[D('a','a',-3,3,0.001,1.4), D('b','b',-3,3,0.001,1.56), D('c','c',-3,3,0.001,1.4), D('d','d',-3,3,0.001,-6.56)],
    f:(x,y,p)=>[p.d*Math.sin(p.a*x)-Math.sin(p.b*y), p.c*Math.cos(p.a*x)+Math.cos(p.b*y)] },

  bedhead: { label:'Bedhead attractor', kind:'map', suggest:{draw:'dots',points:1400000,exposure:1.2,gamma:0.5}, start:[1,1],
    note:'Fine filament structure. Push the point count up.',
    dials:[D('a','a',-1,1,0.001,0.65), D('b','b',0.35,1,0.001,0.7686)],
    f:(x,y,p)=>[Math.sin(x*y/p.b)*y + Math.cos(p.a*x-y), x + Math.sin(y)/p.b] },

  hopalong: { label:'Hopalong', kind:'map', suggest:{draw:'dots',points:900000,exposure:0.8,gamma:0.55}, start:[0,0],
    note:'Concentric shells and rings. Very plotter friendly.',
    dials:[D('a','a',-10,10,0.001,2), D('b','b',-10,10,0.001,1), D('c','c',-10,10,0.001,0)],
    f:(x,y,p)=>[y - Math.sign(x)*Math.sqrt(Math.abs(p.b*x - p.c)), p.a - x] },

  gumowski: { label:'Gumowski–Mira', kind:'map', suggest:{draw:'dots',points:900000,exposure:1,gamma:0.55}, start:[1,1],
    note:'Organic, cell-like clusters. Small changes swing it hard.',
    dials:[D('a','a',-1,1,0.001,0.008), D('b','b',-1,1,0.001,0.05), D('m','mu',-1,1,0.001,-0.496)],
    f:(x,y,p)=>{
      const G = v => p.m*v + 2*(1-p.m)*v*v/(1+v*v);
      const nx = y + p.a*(1 - p.b*y*y)*y + G(x);
      return [nx, -x + G(nx)];
    } },

  tinkerbell: { label:'Tinkerbell map', kind:'map', suggest:{draw:'dots',points:900000,exposure:0.8,gamma:0.55}, start:[-0.72,-0.64],
    note:'A single continuous ribbon that folds over itself.',
    dials:[D('a','a',0.6,1.05,0.001,0.9), D('b','b',-0.75,-0.45,0.001,-0.6013), D('c','c',1.4,2.6,0.001,2), D('d','d',0.3,0.7,0.001,0.5)],
    f:(x,y,p)=>[x*x - y*y + p.a*x + p.b*y, 2*x*y + p.c*x + p.d*y] },

  ikeda: { label:'Ikeda map', kind:'map', suggest:{draw:'dots',points:900000,exposure:1,gamma:0.55}, start:[0.1,0.1],
    note:'A laser cavity model. Spiral in-fall with a long tail.',
    dials:[D('u','u',0.7,0.903,0.0005,0.9)],
    f:(x,y,p)=>{
      const t = 0.4 - 6/(1 + x*x + y*y);
      return [1 + p.u*(x*Math.cos(t) - y*Math.sin(t)), p.u*(x*Math.sin(t) + y*Math.cos(t))];
    } },

  henon: { label:'Hénon map', kind:'map', suggest:{draw:'dots',points:900000,exposure:1,gamma:0.55}, start:[0.1,0.1],
    note:'The textbook horseshoe. Thin, banded, quiet.',
    dials:[D('a','a',0.5,1.6,0.0001,1.4), D('b','b',0,0.5,0.0001,0.3)],
    f:(x,y,p)=>[1 - p.a*x*x + y, p.b*x] },

  lorenz: { label:'Lorenz system', kind:'ode', suggest:{draw:'lines',points:160000,exposure:0.5,gamma:0.55}, start:[0.1,0,20], dim:3,
    note:'The butterfly. Try the line draw mode for a single continuous stroke.',
    dials:[D('s','sigma',1,20,0.01,10), D('r','rho',10,60,0.01,28), D('b','beta',0.5,5,0.001,2.667),
           { k:'dt', l:'Step', t:'range', min:0.001, max:0.02, step:0.001, v:0.006, fmt:v=>v.toFixed(3) }],
    f:(x,y,z,p)=>[p.s*(y-x), x*(p.r-z)-y, x*y - p.b*z] },

  rossler: { label:'Rössler system', kind:'ode', suggest:{draw:'lines',points:160000,exposure:0.5,gamma:0.55}, start:[1,1,1], dim:3,
    note:'One spiralling band that jumps out and folds back.',
    dials:[D('a','a',0.05,0.5,0.001,0.2), D('b','b',0.05,2,0.001,0.2), D('c','c',2,18,0.01,5.7),
           { k:'dt', l:'Step', t:'range', min:0.002, max:0.05, step:0.001, v:0.02, fmt:v=>v.toFixed(3) }],
    f:(x,y,z,p)=>[-y-z, x + p.a*y, p.b + z*(x - p.c)] },

  aizawa: { label:'Aizawa system', kind:'ode', suggest:{draw:'lines',points:200000,exposure:0.5,gamma:0.55}, start:[0.1,0,0], dim:3,
    note:'A wound sphere with a spike through it. Dense and ornamental.',
    dials:[D('a','a',0.5,1.2,0.001,0.95), D('b','b',0.4,0.8,0.001,0.7), D('c','c',0.1,1,0.001,0.6),
           D('d','d',3,4,0.001,3.5), D('e','e',0.1,0.5,0.001,0.25), D('f','f',0.05,0.5,0.001,0.1),
           { k:'dt', l:'Step', t:'range', min:0.002, max:0.05, step:0.001, v:0.01, fmt:v=>v.toFixed(3) }],
    f:(x,y,z,p)=>[(z-p.b)*x - p.d*y, p.d*x + (z-p.b)*y, p.c + p.a*z - z*z*z/3 - (x*x+y*y)*(1+p.e*z) + p.f*z*x*x*x] },

  harmonograph: { label:'Harmonograph', kind:'param', suggest:{draw:'lines',points:240000,exposure:0.7,gamma:0.55},
    note:'Four decaying pendulums, the way plotter drawings were made before plotters.',
    dials:[D('f1','freq 1',0.5,8,0.001,2.01), D('f2','freq 2',0.5,8,0.001,3), D('f3','freq 3',0.5,8,0.001,3.01), D('f4','freq 4',0.5,8,0.001,2),
           { k:'dec', l:'Decay', t:'range', min:0, max:0.02, step:0.0001, v:0.004, fmt:v=>v.toFixed(4) },
           { k:'ph', l:'Phase', t:'range', min:0, max:6.283, step:0.001, v:1.5, fmt:v=>v.toFixed(2) },
           { k:'dt', l:'Step', t:'range', min:0.0005, max:0.02, step:0.0005, v:0.004, fmt:v=>v.toFixed(4) }],
    f:(t,p)=>{
      const e1 = Math.exp(-p.dec*t), e2 = Math.exp(-p.dec*1.3*t);
      return [ Math.sin(p.f1*t + p.ph)*e1 + Math.sin(p.f2*t)*e2,
               Math.sin(p.f3*t)*e1 + Math.sin(p.f4*t + p.ph)*e2 ];
    } },

  lissajous: { label:'Lissajous weave', kind:'param', suggest:{draw:'lines',points:40000,exposure:0.5,gamma:0.55},
    note:'Two frequencies plus slow drift. Clean enough to trace by hand.',
    dials:[D('fx','x frequency',0.5,12,0.001,3), D('fy','y frequency',0.5,12,0.001,4),
           D('drift','Drift',0,0.03,0.0001,0.006), D('ph','Phase',0,6.283,0.001,0),
           { k:'dt', l:'Step', t:'range', min:0.0005, max:0.02, step:0.0005, v:0.003, fmt:v=>v.toFixed(4) }],
    f:(t,p)=>[ Math.sin(p.fx*t + p.ph + p.drift*t), Math.sin(p.fy*t) ] },

  flow: { label:'Flow field', kind:'flow', suggest:{draw:'lines',points:500000,exposure:0.8,gamma:0.55},
    note:'Particles carried by a noise field. Smoke, hair, water. One strand starts where the last one ended, so iterations divided by strand length gives you the strand count.',
    dials:[{ k:'scale', l:'Field size', t:'range', min:0.3, max:8, step:0.1, v:2, fmt:v=>v.toFixed(1) },
           { k:'turn', l:'Turbulence', t:'range', min:0.5, max:8, step:0.1, v:2, fmt:v=>v.toFixed(1) },
           { k:'speed', l:'Speed', t:'range', min:0.0005, max:0.02, step:0.0005, v:0.004, fmt:v=>v.toFixed(4) },
           { k:'life', l:'Strand length', t:'range', min:10, max:600, step:10, v:180, fmt:v=>v }] },

  custom: { label:'Your own formula', kind:'map', suggest:{draw:'dots',points:900000,exposure:1,gamma:0.55}, start:[0.1,0.1], custom:true,
    note:'Write the two lines yourself. The dials below are a, b, c and d.',
    dials:[D('a','a',-5,5,0.001,1.4), D('b','b',-5,5,0.001,1.9), D('c','c',-5,5,0.001,0.3), D('d','d',-5,5,0.001,1.5)],
    f:(x,y,p)=>[x,y] }
};

/* ---------- value noise for the flow field ---------- */
let NOISE_SEED = 1;
function nhash(x,y){
  let n = (x|0)*374761393 + (y|0)*668265263 + NOISE_SEED*1442695040;
  n = (n ^ (n >> 13)) * 1274126177;
  return ((n ^ (n >> 16)) >>> 0) / 4294967296;
}
function vnoise(x,y){
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x-xi, yf = y-yi;
  const u = xf*xf*(3-2*xf), v = yf*yf*(3-2*yf);
  const a = nhash(xi,yi), b = nhash(xi+1,yi), c = nhash(xi,yi+1), d = nhash(xi+1,yi+1);
  return a + (b-a)*u + (c-a)*v + (a-b-c+d)*u*v;
}

/* ---------- iterators ---------- */
function project3D(x,y,z,rot){
  const cy=Math.cos(rot.y), sy=Math.sin(rot.y);
  const x1 = x*cy - z*sy;
  const z1 = x*sy + z*cy;
  const cx=Math.cos(rot.x), sx=Math.sin(rot.x);
  const y1 = y*cx - z1*sx;
  return [x1, y1];
}

function makeIter(sys, p, rng){
  if (sys.kind === 'map'){
    let x = sys.start[0], y = sys.start[1];
    const fn = sys.custom ? (state.customFn || sys.f) : sys.f;
    return { step(){
      let r;
      try { r = fn(x,y,p); } catch(e){ r = [NaN,NaN]; }
      x = r[0]; y = r[1];
      if (!isFinite(x) || !isFinite(y) || Math.abs(x) > 1e6 || Math.abs(y) > 1e6){
        x = (rng()-0.5)*0.2; y = (rng()-0.5)*0.2;
        return [x,y,true];
      }
      return [x,y,false];
    }};
  }
  if (sys.kind === 'ode'){
    let x = sys.start[0], y = sys.start[1], z = sys.start[2];
    return { step(){
      const dt = p.dt, f = sys.f;
      const k1 = f(x,y,z,p);
      const k2 = f(x+dt/2*k1[0], y+dt/2*k1[1], z+dt/2*k1[2], p);
      const k3 = f(x+dt/2*k2[0], y+dt/2*k2[1], z+dt/2*k2[2], p);
      const k4 = f(x+dt*k3[0],   y+dt*k3[1],   z+dt*k3[2],   p);
      x += dt/6*(k1[0]+2*k2[0]+2*k3[0]+k4[0]);
      y += dt/6*(k1[1]+2*k2[1]+2*k3[1]+k4[1]);
      z += dt/6*(k1[2]+2*k2[2]+2*k3[2]+k4[2]);
      if (!isFinite(x)||!isFinite(y)||!isFinite(z)){ x=sys.start[0]; y=sys.start[1]; z=sys.start[2]; }
      const pr = project3D(x,y,z,state.rot3d);
      return [pr[0], pr[1], false];
    }};
  }
  if (sys.kind === 'param'){
    let t = 0;
    return { step(){
      t += p.dt;
      const r = sys.f(t,p);
      return [r[0], r[1], false];
    }};
  }
  // flow field: one strand at a time, so a line drawing gets continuous hairs
  let x = rng(), y = rng(), left = 0;
  return { step(){
    let fresh = false;
    if (left-- <= 0 || x < -0.1 || x > 1.1 || y < -0.1 || y > 1.1){
      x = rng(); y = rng(); left = p.life; fresh = true;
    }
    const ang = vnoise(x*p.scale*6, y*p.scale*6) * 6.2832 * p.turn;
    x += Math.cos(ang)*p.speed;
    y += Math.sin(ang)*p.speed;
    return [x, y, fresh];
  }};
}

/* ---------- density splatting ---------- */
function splat(dens,W,H,x,y,a){
  const xi = Math.floor(x), yi = Math.floor(y);
  if (xi < 0 || yi < 0 || xi >= W-1 || yi >= H-1) return 0;
  const fx = x-xi, fy = y-yi, i = yi*W+xi;
  dens[i]        += a*(1-fx)*(1-fy);
  dens[i+1]      += a*fx*(1-fy);
  dens[i+W]      += a*(1-fx)*fy;
  dens[i+W+1]    += a*fx*fy;
  return a;
}
function splatLine(dens,W,H,x0,y0,x1,y1,maxLen){
  const dx = x1-x0, dy = y1-y0;
  const len = Math.hypot(dx,dy);
  if (!(len >= 0) || len > maxLen) return 0;
  const n = Math.max(1, Math.ceil(len*2));
  const a = len/n, ix = dx/n, iy = dy/n;
  let laid = 0;
  for (let i=1; i<=n; i++) laid += splat(dens, W, H, x0+ix*i, y0+iy*i, a);
  return laid;
}

/* ---------- generator run loop ---------- */
function formatDims(){
  const d = state.gen.detail;
  if (state.gen.format === 'portrait') return [Math.round(d*0.75), d];
  if (state.gen.format === 'tall')     return [Math.round(d*0.62), d];
  if (state.gen.format === 'wide')     return [d, Math.round(d*0.66)];
  return [d,d];
}

function stopRun(){
  if (state.running){ cancelAnimationFrame(state.running.raf); state.running = null; }
}

function runGenerator(){
  stopRun();
  const sys = SYSTEMS[state.gen.system];
  const p = state.genP;
  const [W,H] = formatDims();
  const rng = mulberry32(state.seed);
  NOISE_SEED = state.seed;

  // find the bounds by sampling first
  let bIt = makeIter(sys, p, mulberry32(state.seed));
  let minx=1e9, maxx=-1e9, miny=1e9, maxy=-1e9;
  const warm = sys.kind === 'flow' ? 0 : 500;
  for (let i=0; i<warm; i++) bIt.step();
  const probe = sys.kind === 'flow' ? 30000 : 20000;
  for (let i=0; i<probe; i++){
    const s = bIt.step();
    if (!isFinite(s[0]) || !isFinite(s[1])) continue;
    if (s[0]<minx) minx=s[0]; if (s[0]>maxx) maxx=s[0];
    if (s[1]<miny) miny=s[1]; if (s[1]>maxy) maxy=s[1];
  }
  const flat = !(maxx - minx > 1e-6) && !(maxy - miny > 1e-6);
  if (!(maxx > minx)) { minx-=1; maxx+=1; }
  if (!(maxy > miny)) { miny-=1; maxy+=1; }
  if (flat) setStatus('These dials settle on a single point — press Shuffle');
  const spanX = maxx-minx, spanY = maxy-miny;
  const pad = 0.06;
  const sc = Math.min(W*(1-pad*2)/spanX, H*(1-pad*2)/spanY);
  const ox = W/2 - (minx+maxx)/2*sc;
  const oy = H/2 - (miny+maxy)/2*sc;

  const lineMode = state.gen.draw === 'lines';
  const total = state.gen.points;
  const dens = new Float32Array(W*H);
  const maxSeg = Math.hypot(W,H) * 0.5;
  const vec = [];
  const stride  = Math.max(1, Math.floor(total/16000));
  const strideL = Math.max(1, Math.ceil(total/40000));

  beginCanvas(W,H);
  const it = makeIter(sys, p, rng);
  for (let i=0; i<warm; i++) it.step();

  let done = 0, lastX = null, lastY = null, ink = 0, poly = [], polys = [];
  const chunk = state.growth.playing
    ? Math.max(300, Math.ceil(total / (state.growth.duration*60)))
    : 120000;
  const t0 = performance.now();

  function frame(){
    const end = Math.min(done + chunk, total);
    for (; done<end; done++){
      const s = it.step();
      const x = s[0]*sc + ox, y = s[1]*sc + oy;
      if (lineMode){
        if (s[2] || lastX === null){
          if (poly.length > 1) polys.push(poly);
          poly = [[x,y]];
        } else {
          ink += splatLine(dens, W, H, lastX, lastY, x, y, maxSeg);
          if (polys.length < 400 && done % strideL === 0) poly.push([x,y]);
        }
        lastX = x; lastY = y;
      } else if (x >= 0 && y >= 0 && x < W && y < H){
        dens[(y|0)*W + (x|0)] += 1;
        ink++;
        if (done % stride === 0 && vec.length < 16000) vec.push([x,y]);
      }
    }
    paintDensity(dens, W, H, ink);

    $('#progBar').style.width = (done/total*100) + '%';
    if (done < total){
      state.running = { raf: requestAnimationFrame(frame) };
    } else {
      state.running = null;
      $('#progBar').style.width = '0%';
      if (poly.length > 1) polys.push(poly);
      state.vector = lineMode
        ? { kind:'polys', w:W, h:H, items:polys }
        : { kind:'points', w:W, h:H, items:vec };
      setStatus(sys.label + ' · ' + Math.round(performance.now()-t0) + ' ms');
      measureInk();
      updateReadout();
      if (state.spin.auto && is3DSystem()){
        state.rot3d.y += 0.05;
        requestAnimationFrame(() => runGenerator());
        return;
      }
      if (state.growth.playing){
        if (state.growth.loop) requestAnimationFrame(() => runGenerator());
        else { state.growth.playing = false; updatePlayButton(); }
      }
    }
  }
  frame();
}

function paintDensity(dens, W, H, ink){
  const img = inkImage(W,H), d = img.data;
  const avg = Math.max(ink/(W*H), 0.02);
  const k = 0.6 * state.gen.exposure / avg;
  const gm = state.gen.gamma;
  for (let i=0; i<dens.length; i++){
    const v = dens[i];
    if (v <= 0) continue;
    let a = 1 - Math.exp(-v*k);
    a = Math.pow(a, gm);
    put(d, i, Math.round(clamp(a,0,1)*255));
  }
  vctx.putImageData(img,0,0);
}


/* ============================================================
   HUNTING FOR GOOD PARAMETERS
   ============================================================ */
function lyapunov(sys,p){
  if (sys.kind !== 'map') return 1;
  const f = sys.custom ? (state.customFn || sys.f) : sys.f;
  let x = sys.start[0], y = sys.start[1];
  for (let i=0; i<400; i++){
    const r = f(x,y,p); x = r[0]; y = r[1];
    if (!isFinite(x) || !isFinite(y) || Math.abs(x) > 1e5) return -1;
  }
  const d0 = 1e-8;
  let x2 = x + d0, y2 = y, sum = 0, n = 0;
  for (let i=0; i<1500; i++){
    let r = f(x,y,p); x = r[0]; y = r[1];
    let r2 = f(x2,y2,p); x2 = r2[0]; y2 = r2[1];
    if (!isFinite(x) || !isFinite(x2) || Math.abs(x) > 1e5) return -1;
    const d = Math.hypot(x2-x, y2-y);
    if (d === 0) return -1;
    sum += Math.log(d/d0); n++;
    x2 = x + (x2-x)*d0/d; y2 = y + (y2-y)*d0/d;
  }
  return n ? sum/n : -1;
}

// quick probe: is this parameter set worth rendering?
function probeScore(sys,p,seed){
  const lam = lyapunov(sys,p);
  if (lam < 0.012) return 0;
  const G = 40, N = 30000;
  const it = makeIter(sys, p, mulberry32(seed));
  for (let i=0; i<300; i++) it.step();
  const xs = new Float64Array(N), ys = new Float64Array(N);
  let minx=1e9, maxx=-1e9, miny=1e9, maxy=-1e9, got=0;
  for (let i=0; i<N; i++){
    const s = it.step();
    if (!isFinite(s[0]) || !isFinite(s[1]) || Math.abs(s[0]) > 1e5) continue;
    xs[got] = s[0]; ys[got] = s[1]; got++;
    if (s[0]<minx) minx=s[0]; if (s[0]>maxx) maxx=s[0];
    if (s[1]<miny) miny=s[1]; if (s[1]>maxy) maxy=s[1];
  }
  if (got < N*0.8) return 0;
  const spanX = maxx-minx, spanY = maxy-miny;
  if (!(spanX > 1e-6) || !(spanY > 1e-6)) return 0;
  const aspect = Math.max(spanX,spanY) / Math.min(spanX,spanY);
  if (aspect > 14) return 0;
  const grid = new Int32Array(G*G);
  for (let i=0; i<got; i++){
    const gx = clamp(Math.floor((xs[i]-minx)/spanX*(G-1)),0,G-1);
    const gy = clamp(Math.floor((ys[i]-miny)/spanY*(G-1)),0,G-1);
    grid[gy*G+gx]++;
  }
  let filled = 0, peak = 0, sum = 0;
  for (let i=0; i<grid.length; i++){ if (grid[i]) filled++; if (grid[i] > peak) peak = grid[i]; sum += grid[i]; }
  if (peak > got*0.25) return 0;
  const occ = filled/(G*G);

  // structure test: a real attractor jumps between full and empty cells,
  // a shapeless cloud drifts smoothly from one cell to the next
  let dsum = 0, dn = 0;
  for (let y=0; y<G; y++) for (let x=0; x<G-1; x++){
    const a = grid[y*G+x], b = grid[y*G+x+1];
    if (a || b){ dsum += Math.abs(a-b); dn++; }
  }
  for (let y=0; y<G-1; y++) for (let x=0; x<G; x++){
    const a = grid[y*G+x], b = grid[(y+1)*G+x];
    if (a || b){ dsum += Math.abs(a-b); dn++; }
  }
  const supportMean = sum/Math.max(filled,1);
  const contrast = (dsum/Math.max(dn,1)) / Math.max(supportMean,1e-9);

  const shape = occ < 0.04 ? occ/0.04*0.6 : occ <= 0.55 ? 1 : Math.max(0, (0.95-occ)/0.4);
  return shape * clamp(contrast/0.8, 0.25, 1.15) * clamp(lam*2, 0.2, 1);
}

function randomParams(sys,rnd){
  const p = {};
  sys.dials.forEach(d => {
    if (d.t !== 'range' || d.k === 'dt') { p[d.k] = state.genP[d.k] !== undefined ? state.genP[d.k] : d.v; return; }
    p[d.k] = Number((d.min + rnd()*(d.max-d.min)).toFixed(4));
  });
  sys.dials.forEach(d => { if (d.t === 'select') p[d.k] = state.genP[d.k] !== undefined ? state.genP[d.k] : d.v; });
  return p;
}

function hunt(sys, tries, rnd){
  let best = null, bestScore = -1;
  for (let i=0; i<tries; i++){
    const p = randomParams(sys, rnd);
    const sc = probeScore(sys, p, 99);
    if (sc > bestScore){ bestScore = sc; best = p; }
    if (bestScore > 0.85) break;
  }
  return { p:best, score:bestScore };
}

function renderThumb(sys, p, S, points){
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const ctx = c.getContext('2d');
  const rng = mulberry32(state.seed);
  const b = makeIter(sys, p, mulberry32(state.seed));
  const warm = sys.kind === 'flow' ? 0 : 400;
  for (let i=0; i<warm; i++) b.step();
  let minx=1e9, maxx=-1e9, miny=1e9, maxy=-1e9;
  for (let i=0; i<9000; i++){
    const s = b.step();
    if (!isFinite(s[0]) || !isFinite(s[1])) continue;
    if (s[0]<minx) minx=s[0]; if (s[0]>maxx) maxx=s[0];
    if (s[1]<miny) miny=s[1]; if (s[1]>maxy) maxy=s[1];
  }
  if (!(maxx>minx)){ minx-=1; maxx+=1; }
  if (!(maxy>miny)){ miny-=1; maxy+=1; }
  const sc = Math.min(S*0.88/(maxx-minx), S*0.88/(maxy-miny));
  const ox = S/2 - (minx+maxx)/2*sc, oy = S/2 - (miny+maxy)/2*sc;
  const dens = new Float32Array(S*S);
  const it = makeIter(sys, p, rng);
  for (let i=0; i<warm; i++) it.step();
  let ink = 0;
  for (let i=0; i<points; i++){
    const s = it.step();
    const x = s[0]*sc+ox, y = s[1]*sc+oy;
    if (x>=0 && y>=0 && x<S && y<S){ dens[(y|0)*S + (x|0)] += 1; ink++; }
  }
  const img = ctx.createImageData(S,S);
  const d = img.data;
  const avg = Math.max(ink/(S*S), 0.02), k = 0.6/avg;
  for (let i=0; i<dens.length; i++){
    const q = i*4;
    d[q] = d[q+1] = d[q+2] = 255;
    d[q+3] = 255;
    if (dens[i] > 0){
      const a = Math.pow(1 - Math.exp(-dens[i]*k), 0.55);
      const g = Math.round(255*(1-clamp(a,0,1)));
      d[q] = d[q+1] = d[q+2] = g;
    }
  }
  ctx.putImageData(img,0,0);
  return c;
}

function explore(){
  const sys = SYSTEMS[state.gen.system];
  const grid = $('#exploreGrid');
  grid.innerHTML = '';
  grid.classList.remove('empty');
  $('#exploreTag').textContent = 'working';
  setTimeout(() => {
    const rnd = mulberry32(Math.floor(Math.random()*1e9));
    let made = 0;
    for (let i=0; i<12; i++){
      const found = hunt(sys, sys.kind === 'map' ? 16 : 6, rnd);
      if (!found.p || found.score < 0.05) continue;
      const p = found.p;
      const cv = renderThumb(sys, p, 132, 26000);
      const b = document.createElement('button');
      b.type = 'button';
      b.title = 'Use this one';
      const img = document.createElement('img');
      img.src = cv.toDataURL('image/png');
      img.alt = '';
      b.appendChild(img);
      b.addEventListener('click', () => {
        Object.assign(state.genP, p);
        state.keepRender = true; selectSystem(state.gen.system); state.keepRender = false;
      });
      grid.appendChild(b);
      made++;
    }
    $('#exploreTag').textContent = made + ' found';
  }, 30);
}

function smartShuffle(){
  const sys = SYSTEMS[state.gen.system];
  const rnd = mulberry32(Math.floor(Math.random()*1e9));
  const found = hunt(sys, sys.kind === 'map' ? 70 : 22, rnd);
  if (!found.p || found.score < 0.05){
    setStatus('No lively set turned up, so your dials are untouched');
    return;
  }
  Object.assign(state.genP, found.p);
  state.keepRender = true; selectSystem(state.gen.system); state.keepRender = false;
  setStatus('Shuffled ' + sys.label);
}

/* ============================================================
   CURVES
   ============================================================ */
const T = (k,l,min,max,step,v,fmt) => ({ k, l, t:'range', min, max, step, v, fmt: fmt || (x=>Number(x).toFixed(2)) });
const TURNS = (v,max) => T('turns','Turns',1,max||60,1,v,x=>String(Math.round(x)));

const CURVES = {
  spiro: { label:'Spirograph', note:'The wheel inside a ring. Whole-number ratios close up, anything else keeps drifting.',
    dials:[T('R','Ring',20,200,1,120,x=>Math.round(x)), T('r','Wheel',3,120,1,37,x=>Math.round(x)),
           T('d','Pen offset',1,150,1,64,x=>Math.round(x)), TURNS(37,120)],
    f:(t,p)=>{ const k=(p.R-p.r)/p.r; return [ (p.R-p.r)*Math.cos(t) + p.d*Math.cos(k*t),
                                              (p.R-p.r)*Math.sin(t) - p.d*Math.sin(k*t) ]; } },

  epi: { label:'Epitrochoid', note:'The wheel rolling outside the ring. Petals and stars.',
    dials:[T('R','Ring',20,200,1,90,x=>Math.round(x)), T('r','Wheel',3,120,1,23,x=>Math.round(x)),
           T('d','Pen offset',1,150,1,50,x=>Math.round(x)), TURNS(23,120)],
    f:(t,p)=>{ const k=(p.R+p.r)/p.r; return [ (p.R+p.r)*Math.cos(t) - p.d*Math.cos(k*t),
                                              (p.R+p.r)*Math.sin(t) - p.d*Math.sin(k*t) ]; } },

  rose: { label:'Rose', note:'r = cos(k θ). An odd k gives you k petals, an even k gives you twice that.',
    dials:[T('k','Petal ratio',0.1,16,0.01,5), T('e','Petal fullness',0.2,3,0.01,1), TURNS(8,60)],
    f:(t,p)=>{ const r = Math.pow(Math.abs(Math.cos(p.k*t)), p.e) * Math.sign(Math.cos(p.k*t));
               return [r*Math.cos(t), r*Math.sin(t)]; } },

  superformula: { label:'Superformula', note:'One equation that covers most natural outlines. m sets the number of corners.',
    dials:[T('m','Corners',1,20,0.1,7), T('n1','Sharpness',0.2,12,0.05,0.6),
           T('n2','Bulge a',0.1,12,0.05,1.2), T('n3','Bulge b',0.1,12,0.05,1.8),
           T('a','Width',0.5,2,0.01,1), T('b','Height',0.5,2,0.01,1), TURNS(1,20)],
    f:(t,p)=>{
      const c1 = Math.pow(Math.abs(Math.cos(p.m*t/4)/p.a), p.n2);
      const c2 = Math.pow(Math.abs(Math.sin(p.m*t/4)/p.b), p.n3);
      const r = Math.pow(c1+c2, -1/p.n1);
      return [r*Math.cos(t), r*Math.sin(t)];
    } },

  spiral: { label:'Spiral', note:'Archimedean opens evenly, logarithmic opens faster the further out it goes.',
    dials:[{ k:'type', l:'Kind', t:'select', v:'log', opts:[['arch','Archimedean'],['log','Logarithmic']] },
           T('a','Start radius',0.5,40,0.5,6), T('b','Growth',0.01,1.2,0.005,0.14), TURNS(6,60)],
    f:(t,p)=>{ const r = p.type === 'log' ? p.a*Math.exp(p.b*t) : p.a + p.b*t*12;
               return [r*Math.cos(t), r*Math.sin(t)]; } },

  lissa: { label:'Lissajous', note:'Two frequencies at right angles. Simple ratios, clean knots.',
    dials:[T('fx','x frequency',1,16,0.01,3), T('fy','y frequency',1,16,0.01,4),
           T('ph','Phase',0,6.283,0.001,0.6), TURNS(1,40)],
    f:(t,p)=>[ Math.sin(p.fx*t + p.ph), Math.sin(p.fy*t) ] },

  epicycle: { label:'Epicycles', note:'Three circles turning on the end of each other, the way Fourier draws anything.',
    dials:[T('r1','Radius 1',0.1,3,0.01,1), T('f1','Speed 1',-12,12,0.1,1),
           T('r2','Radius 2',0.1,3,0.01,0.5), T('f2','Speed 2',-12,12,0.1,5),
           T('r3','Radius 3',0,3,0.01,0.28), T('f3','Speed 3',-16,16,0.1,-9), TURNS(1,40)],
    f:(t,p)=>[ p.r1*Math.cos(p.f1*t) + p.r2*Math.cos(p.f2*t) + p.r3*Math.cos(p.f3*t),
               p.r1*Math.sin(p.f1*t) + p.r2*Math.sin(p.f2*t) + p.r3*Math.sin(p.f3*t) ] },

  butterfly: { label:'Butterfly curve', note:"Fay's curve. Six petals and a long slow drift around them.",
    dials:[T('s','Twist',1,20,0.1,12), T('k','Lobes',1,10,0.1,4), TURNS(12,60)],
    f:(t,p)=>{ const r = Math.exp(Math.cos(t)) - 2*Math.cos(p.k*t) + Math.pow(Math.sin(t/p.s),5);
               return [Math.sin(t)*r, Math.cos(t)*r]; } },

  limacon: { label:'Limaçon', note:'One circle traced from a point off its centre. Hearts, kidneys, loops inside loops.',
    dials:[T('a','Offset',0,3,0.01,1), T('b','Radius',0.2,3,0.01,1.6), T('k','Symmetry',1,8,1,1,x=>Math.round(x)), TURNS(1,20)],
    f:(t,p)=>{ const r = p.a + p.b*Math.cos(p.k*t); return [r*Math.cos(t), r*Math.sin(t)]; } },

  cybersigil: { label:'Cybersigil', special:'sigil', note:'A random-walk tendril with sharp snapped turns, barb spikes and node dots — the angular circuitboard-glyph linework of cybersigilism. Reseed for a whole new glyph, or use Copies and Mirror below to array one arm into a full symmetric sigil.',
    dials:[
      { k:'branches',  l:'Tendrils', t:'range', min:1, max:6, step:1, v:2 },
      { k:'length',    l:'Segments', t:'range', min:3, max:40, step:1, v:14 },
      { k:'segLen',    l:'Segment length', t:'range', min:0.04, max:0.4, step:0.005, v:0.14, fmt:v=>v.toFixed(3) },
      { k:'angleStep', l:'Turn angle', t:'range', min:10, max:90, step:1, v:30, fmt:v=>v+'°' },
      { k:'straight',  l:'Bias to keep going straight', t:'range', min:0, max:100, step:1, v:35, fmt:v=>v+'%' },
      { k:'barbs',     l:'Barb chance', t:'range', min:0, max:100, step:1, v:40, fmt:v=>v+'%' },
      { k:'nodes',     l:'Node chance', t:'range', min:0, max:100, step:1, v:30, fmt:v=>v+'%' },
      { k:'nodeSize',  l:'Node size', t:'range', min:0.005, max:0.08, step:0.002, v:0.022, fmt:v=>v.toFixed(3) }
    ] },

  custom: { label:'Your own formula', custom:true, note:'Write x(t) and y(t). t runs from zero to two pi times the turns.',
    dials:[T('a','a',-8,8,0.01,3), T('b','b',-8,8,0.01,5), T('c','c',-8,8,0.01,1), T('d','d',-8,8,0.01,0.5), TURNS(8,120)],
    f:(t,p)=>[Math.cos(t), Math.sin(t)] }
};

const CURVE_SCHEMA = [
  { k:'copies',  l:'Copies around the centre', t:'range', min:1, max:36, step:1, v:1 },
  { k:'spin',    l:'Rotate', t:'range', min:0, max:360, step:1, v:0, fmt:v=>v+'°' },
  { k:'shrink',  l:'Each copy scaled', t:'range', min:0.6, max:1.4, step:0.005, v:1, fmt:v=>v.toFixed(3)+'×' },
  { k:'mirror',  l:'Mirror every copy', t:'check', v:false },
  { k:'weight',  l:'Line weight', t:'range', min:0.2, max:10, step:0.1, v:1.6, fmt:v=>v.toFixed(1)+' px' },
  { k:'wobble',  l:'Hand wobble', t:'range', min:0, max:30, step:0.5, v:0, fmt:v=>v.toFixed(1)+' px' },
  { k:'samples', l:'Smoothness', t:'range', min:600, max:60000, step:200, v:14000, fmt:v=>(v/1000).toFixed(1)+'k' },
  { k:'detail',  l:'Resolution', t:'range', min:500, max:2400, step:100, v:1100, fmt:v=>v+' px' },
  { k:'format',  l:'Format', t:'select', v:'square', opts:[['square','Square'],['portrait','Portrait 3:4'],['tall','Tall 5:8'],['wide','Landscape 3:2']] }
];

function curveDims(){
  const d = state.curve.detail;
  if (state.curve.format === 'portrait') return [Math.round(d*0.75), d];
  if (state.curve.format === 'tall')     return [Math.round(d*0.62), d];
  if (state.curve.format === 'wide')     return [d, Math.round(d*0.66)];
  return [d,d];
}

/* ---------- cybersigil: an angular random-walk tendril ---------- */
// one tendril, in local -1..1 space: spine + barb ticks + node rings,
// all returned as plain point-array "runs" so it flows through the
// same copies / mirror / wobble / stroke pipeline as every other curve
function sigilRun(rng, p){
  const runs = [];
  const turnSet = [-2,-1,-1,0,0,0,1,1,2];
  const baseAngle = (p.angleStep||30) * Math.PI/180;
  const straight = clamp((p.straight||35)/100, 0, 1);
  let x=0, y=0, ang = -Math.PI/2;
  const spine = [[x,y]];
  const segs = Math.max(3, Math.round(p.length||14));
  const nodeChance = clamp((p.nodes||30)/100, 0, 1);
  const barbChance = clamp((p.barbs||40)/100, 0, 1);
  for (let i=0; i<segs; i++){
    const turn = rng() < straight ? 0 : turnSet[Math.floor(rng()*turnSet.length)] * baseAngle;
    ang += turn;
    const len = (p.segLen||0.14) * (0.65+rng()*0.7) * (1 - i/segs*0.25);
    x += Math.cos(ang)*len; y += Math.sin(ang)*len;
    spine.push([x,y]);
    if (rng() < barbChance){
      const barbAng = ang + (rng()<0.5 ? 1 : -1) * (Math.PI/2) * (0.7+rng()*0.5);
      const blen = len * (0.4+rng()*0.5);
      runs.push([[x,y],[x+Math.cos(barbAng)*blen, y+Math.sin(barbAng)*blen]]);
    }
    if (rng() < nodeChance && i < segs-1){
      const r = (p.nodeSize||0.022) * (0.6+rng()*0.8);
      const n=10, circ=[];
      for (let k=0; k<=n; k++){ const a=k/n*TAU; circ.push([x+Math.cos(a)*r, y+Math.sin(a)*r]); }
      runs.push(circ);
    }
  }
  const r = (p.nodeSize||0.022) * 1.7, n=12, tip=[];
  for (let k=0; k<=n; k++){ const a=k/n*TAU; tip.push([x+Math.cos(a)*r, y+Math.sin(a)*r]); }
  runs.push(tip);
  runs.unshift(spine);
  return runs;
}
function buildCybersigil(p, seed){
  const rng = mulberry32(seed);
  const branches = Math.max(1, Math.round(p.branches||2));
  let runs = [];
  for (let b=0; b<branches; b++) runs = runs.concat(sigilRun(rng, p));
  return runs;
}

function runCurve(){
  stopRun();
  const cv = CURVES[state.curve.key];
  const p = state.curveP;
  const C = state.curve;
  const [W,H] = curveDims();

  let runs;
  if (cv.special === 'sigil'){
    runs = buildCybersigil(p, state.seed);
  } else {
    const N = Math.round(C.samples);
    const tmax = TAU * (p.turns || 1);
    const f = cv.custom ? (state.customCurve || cv.f) : cv.f;

    // one pass of the raw curve, split wherever the maths goes undefined
    runs = [];
    let run = [];
    for (let i=0; i<=N; i++){
      const t = i/N*tmax;
      let q;
      try { q = f(t,p); } catch(e){ q = null; }
      if (!q || !isFinite(q[0]) || !isFinite(q[1]) || Math.abs(q[0]) > 1e6 || Math.abs(q[1]) > 1e6){
        if (run.length > 1) runs.push(run);
        run = []; continue;
      }
      run.push([q[0], q[1]]);
    }
    if (run.length > 1) runs.push(run);
  }
  if (!runs.length){
    beginCanvas(W,H); state.vector = null;
    setStatus('That curve came out empty'); updateReadout(); return;
  }

  // rotate, scale and mirror the copies
  const copies = Math.max(1, Math.round(C.copies));
  const paths = [];
  for (let c=0; c<copies; c++){
    const ang = (c/copies)*TAU + C.spin*Math.PI/180;
    const ca = Math.cos(ang), sa = Math.sin(ang), k = Math.pow(C.shrink, c);
    for (const r of runs){
      paths.push(r.map(([x,y]) => [ (x*ca - y*sa)*k, (x*sa + y*ca)*k ]));
      if (C.mirror) paths.push(r.map(([x,y]) => [ -(x*ca - y*sa)*k, (x*sa + y*ca)*k ]));
    }
  }

  let minx=1e9, maxx=-1e9, miny=1e9, maxy=-1e9;
  for (const pa of paths) for (const [x,y] of pa){
    if (x<minx) minx=x; if (x>maxx) maxx=x;
    if (y<miny) miny=y; if (y>maxy) maxy=y;
  }
  const spanX = Math.max(maxx-minx, 1e-6), spanY = Math.max(maxy-miny, 1e-6);
  const pad = 0.07 + C.weight/Math.max(W,H);
  const sc = Math.min(W*(1-pad*2)/spanX, H*(1-pad*2)/spanY);
  const ox = W/2 - (minx+maxx)/2*sc, oy = H/2 - (miny+maxy)/2*sc;

  beginCanvas(W,H);
  const items = [];
  NOISE_SEED = state.seed;
  const t0 = performance.now();
  paths.forEach((pa,pi) => {
    const pts = pa.map(([x,y],i) => {
      let px = x*sc+ox, py = y*sc+oy;
      if (C.wobble > 0){
        px += (vnoise(i*0.03, pi*7.3) - 0.5) * C.wobble * 2;
        py += (vnoise(i*0.03 + 91.7, pi*7.3) - 0.5) * C.wobble * 2;
      }
      return [px,py];
    });
    strokePts(pts, C.weight);
    items.push({ p:pts, w:C.weight });
  });
  state.vector = { kind:'strokes', w:W, h:H, items };
  setStatus(cv.label + ' · ' + Math.round(performance.now()-t0) + ' ms · ' + paths.length + ' paths');
  measureInk();
  updateReadout();
}

/* ============================================================
   FIELDS — smooth grey surfaces to run a screen through
   ============================================================ */
function fbm(x,y,oct,gain,lac){
  let a = 0.5, f = 1, sum = 0, norm = 0;
  for (let i=0; i<oct; i++){
    sum += a*vnoise(x*f, y*f);
    norm += a;
    f *= (lac || 2); a *= (gain || 0.5);
  }
  return norm ? sum/norm : 0;
}

const FIELDS = {
  liquid: { label:'Liquid', note:'Noise folded back through itself twice. Slow, heavy, marbled.',
    dials:[ { k:'scale', l:'Field size', t:'range', min:0.5, max:14, step:0.1, v:3, fmt:v=>v.toFixed(1) },
            { k:'warp',  l:'Warp', t:'range', min:0, max:6, step:0.05, v:2.2, fmt:v=>v.toFixed(2) },
            { k:'oct',   l:'Detail', t:'range', min:1, max:7, step:1, v:4 } ],
    f:(x,y,p)=>{
      const s = p.scale, o = Math.round(p.oct);
      const q1 = fbm(x*s, y*s, o), q2 = fbm(x*s+5.2, y*s+1.3, o);
      const r1 = fbm(x*s + p.warp*q1 + 1.7, y*s + p.warp*q2 + 9.2, o);
      return fbm(x*s + p.warp*r1, y*s + p.warp*r1 + 3.1, o);
    } },

  mesh: { label:'Mesh gradient', note:'A handful of soft blobs blended together, the way a mesh gradient is built.',
    dials:[ { k:'blobs', l:'Blobs', t:'range', min:2, max:14, step:1, v:6 },
            { k:'soft',  l:'Softness', t:'range', min:0.08, max:1.2, step:0.01, v:0.42, fmt:v=>v.toFixed(2) } ],
    prep:(p)=>{
      const rng = mulberry32(state.seed);
      const n = Math.round(p.blobs), b = [];
      for (let i=0; i<n; i++) b.push([rng()*1.2-0.1, rng()*1.2-0.1, rng()<0.5?-1:1, p.soft*(0.5+rng())]);
      return b;
    },
    f:(x,y,p,b)=>{
      let v = 0;
      for (let i=0; i<b.length; i++){
        const dx = x-b[i][0], dy = y-b[i][1], sg = b[i][3];
        v += b[i][2]*Math.exp(-(dx*dx+dy*dy)/(2*sg*sg));
      }
      return 0.5 + v*0.35;
    } },

  waves: { label:'Waves', note:'Straight bands bent by noise. Turn the contrast up and it becomes a ridge map.',
    dials:[ { k:'freq',  l:'Band count', t:'range', min:0.5, max:40, step:0.5, v:6, fmt:v=>v.toFixed(1) },
            { k:'angle', l:'Angle', t:'range', min:0, max:180, step:1, v:20, fmt:v=>v+'°' },
            { k:'warp',  l:'Bend', t:'range', min:0, max:4, step:0.05, v:1.1, fmt:v=>v.toFixed(2) },
            { k:'scale', l:'Bend size', t:'range', min:0.5, max:10, step:0.1, v:2.4, fmt:v=>v.toFixed(1) } ],
    f:(x,y,p)=>{
      const a = p.angle*Math.PI/180;
      const d = x*Math.cos(a) + y*Math.sin(a);
      const n = fbm(x*p.scale, y*p.scale, 3);
      return 0.5 + 0.5*Math.sin((d + p.warp*n)*p.freq*TAU);
    } },

  rings: { label:'Ripples', note:'Rings spreading from a few points at once, interfering where they meet.',
    dials:[ { k:'freq',  l:'Ring count', t:'range', min:1, max:60, step:0.5, v:14, fmt:v=>v.toFixed(1) },
            { k:'drops', l:'Sources', t:'range', min:1, max:8, step:1, v:2 },
            { k:'warp',  l:'Bend', t:'range', min:0, max:2, step:0.02, v:0.3, fmt:v=>v.toFixed(2) } ],
    prep:(p)=>{
      const rng = mulberry32(state.seed);
      const n = Math.round(p.drops), c = [];
      for (let i=0; i<n; i++) c.push([0.15+rng()*0.7, 0.15+rng()*0.7]);
      return c;
    },
    f:(x,y,p,c)=>{
      const n = fbm(x*2.5, y*2.5, 3);
      let v = 0;
      for (let i=0; i<c.length; i++){
        const d = Math.hypot(x-c[i][0], y-c[i][1]);
        v += Math.sin((d + p.warp*n)*p.freq*TAU);
      }
      return 0.5 + 0.5*v/c.length;
    } },

  marble: { label:'Marble', note:'Bands pulled sideways by turbulence. Stone, end paper, smoke on water.',
    dials:[ { k:'freq',  l:'Vein count', t:'range', min:1, max:40, step:0.5, v:8, fmt:v=>v.toFixed(1) },
            { k:'amp',   l:'Turbulence', t:'range', min:0, max:4, step:0.05, v:1.4, fmt:v=>v.toFixed(2) },
            { k:'scale', l:'Grain size', t:'range', min:0.5, max:12, step:0.1, v:3.5, fmt:v=>v.toFixed(1) },
            { k:'oct',   l:'Detail', t:'range', min:1, max:7, step:1, v:5 },
            { k:'angle', l:'Angle', t:'range', min:0, max:180, step:1, v:70, fmt:v=>v+'°' } ],
    f:(x,y,p)=>{
      const a = p.angle*Math.PI/180;
      const d = x*Math.cos(a) + y*Math.sin(a);
      const n = fbm(x*p.scale, y*p.scale, Math.round(p.oct));
      return 0.5 + 0.5*Math.sin((d + p.amp*n)*p.freq*TAU);
    } },

  ramp: { label:'Ramp', note:'A plain gradient. The most useful thing in here once a dither is on top of it.',
    dials:[ { k:'kind',  l:'Kind', t:'select', v:'linear', opts:[['linear','Linear'],['radial','Radial'],['corner','Corner']] },
            { k:'angle', l:'Angle', t:'range', min:0, max:360, step:1, v:90, fmt:v=>v+'°' },
            { k:'bias',  l:'Midpoint', t:'range', min:0.1, max:4, step:0.05, v:1, fmt:v=>v.toFixed(2) } ],
    f:(x,y,p)=>{
      let t;
      if (p.kind === 'radial') t = 1 - Math.min(Math.hypot(x-0.5, y-0.5)*2, 1);
      else if (p.kind === 'corner') t = 1 - Math.min(Math.hypot(x, y), 1);
      else {
        const a = p.angle*Math.PI/180;
        t = (x*Math.cos(a) + y*Math.sin(a) + 1)/2;
      }
      return Math.pow(clamp(t,0,1), p.bias);
    } }
};

const FIELD_SCHEMA = [
  { k:'contrast', l:'Contrast', t:'range', min:0.2, max:6, step:0.05, v:1, fmt:v=>v.toFixed(2) },
  { k:'lift',     l:'Brightness', t:'range', min:-0.5, max:0.5, step:0.01, v:0, fmt:v=>v.toFixed(2) },
  { k:'levels',   l:'Posterise', t:'range', min:0, max:16, step:1, v:0, fmt:v=>v<2?'off':v+' steps' },
  { k:'invert',   l:'Invert', t:'check', v:false },
  { k:'detail',   l:'Resolution', t:'range', min:400, max:2000, step:100, v:900, fmt:v=>v+' px' },
  { k:'format',   l:'Format', t:'select', v:'square', opts:[['square','Square'],['portrait','Portrait 3:4'],['tall','Tall 5:8'],['wide','Landscape 3:2']] }
];

function fieldDims(){
  const d = state.field.detail;
  if (state.field.format === 'portrait') return [Math.round(d*0.75), d];
  if (state.field.format === 'tall')     return [Math.round(d*0.62), d];
  if (state.field.format === 'wide')     return [d, Math.round(d*0.66)];
  return [d,d];
}

function runField(){
  stopRun();
  const fd = FIELDS[state.field.key];
  const p = state.fieldP, F = state.field;
  const [W,H] = fieldDims();
  NOISE_SEED = state.seed;
  const ctxData = fd.prep ? fd.prep(p) : null;
  beginCanvas(W,H);
  const img = inkImage(W,H), d = img.data;
  const t0 = performance.now();
  const steps = F.levels >= 2 ? Math.round(F.levels) : 0;

  // sample the field coarsely first so every kind lands on a full spread
  let lo = 1e9, hi = -1e9;
  const SN = 40, ar = W/H;
  for (let j=0; j<SN; j++) for (let i=0; i<SN; i++){
    const v = fd.f(i/SN*ar, j/SN, p, ctxData);
    if (!isFinite(v)) continue;
    if (v < lo) lo = v; if (v > hi) hi = v;
  }
  const inv = hi-lo > 1e-6 ? 1/(hi-lo) : 1;

  for (let y=0; y<H; y++){
    const vy = y/H;
    for (let x=0; x<W; x++){
      let v = (fd.f(x/H, vy, p, ctxData) - lo)*inv;
      v = clamp((v - 0.5)*F.contrast + 0.5 + F.lift, 0, 1);
      if (steps) v = Math.round(v*(steps-1))/(steps-1);
      if (!F.invert) v = 1-v;
      if (v > 0.004) put(d, y*W+x, Math.round(v*255));
    }
  }
  vctx.putImageData(img,0,0);
  state.vector = null;
  setStatus(fd.label + ' · ' + Math.round(performance.now()-t0) + ' ms');
  measureInk();
  updateReadout();
}

/* ============================================================
   READOUTS
   ============================================================ */
function setStatus(t){ $('#status').innerHTML = t; }

function measureInk(){
  const w = view.width, h = view.height;
  const step = Math.max(1, Math.floor(Math.sqrt(w*h/40000)));
  let sum = 0, n = 0;
  try {
    const d = vctx.getImageData(0,0,w,h).data;
    for (let y=0; y<h; y+=step) for (let x=0; x<w; x+=step){ sum += d[(y*w+x)*4+3]; n++; }
  } catch(e){ return; }
  state.inkPct = n ? (sum/n/255*100) : 0;
}

function updateReadout(){
  $('#roSize').textContent = view.width + ' × ' + view.height;
  const cm = Number($('#skin').value);
  const dpi = Math.round(view.width / (cm/2.54));
  $('#roSkin').textContent = cm.toFixed(1) + ' cm · ' + dpi + ' dpi';
  $('#roInk').textContent = state.inkPct.toFixed(1) + '%';
  const v = state.vector;
  const noun = { polys:'paths', strokes:'paths', segs:'lines', rects:'blocks', points:'dots', circles:'dots', marks:'marks', glyphs:'characters' };
  $('#roVec').textContent = v ? v.items.length.toLocaleString() + ' ' + (noun[v.kind]||'shapes') : 'raster only';
  $('#svgBtn').disabled = !v;
}

/* ============================================================
   EXPORT
   ============================================================ */
function flatten(scale){
  const c = document.createElement('canvas');
  c.width = view.width*scale; c.height = view.height*scale;
  const x = c.getContext('2d');
  if (!$('#alphaBg').checked){ x.fillStyle = '#fff'; x.fillRect(0,0,c.width,c.height); }
  x.imageSmoothingEnabled = false;
  x.drawImage(view, 0, 0, c.width, c.height);
  return c;
}

function makeThumb(size){
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0,0,size,size);
  if (view.width && view.height){
    const k = Math.min(size/view.width, size/view.height);
    const dw = view.width*k, dh = view.height*k;
    x.drawImage(view, (size-dw)/2, (size-dh)/2, dw, dh);
  }
  return c.toDataURL('image/png');
}

function stamp(){
  const d = new Date(), pad = n => String(n).padStart(2,'0');
  return d.getFullYear()+pad(d.getMonth()+1)+pad(d.getDate())+'-'+pad(d.getHours())+pad(d.getMinutes())+pad(d.getSeconds());
}

function download(href, name){
  const a = document.createElement('a');
  a.href = href; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
}

function jobName(){
  return state.mode === 'image' ? state.effect
       : state.mode === 'curve' ? state.curve.key
       : state.mode === 'field' ? state.field.key
       : state.gen.system;
}

function exportPNG(scale){
  const name = 'flash-' + jobName() + '-' + stamp() + '.png';
  flatten(scale).toBlob(b => {
    const url = URL.createObjectURL(b);
    download(url, name);
    setTimeout(()=>URL.revokeObjectURL(url), 4000);
    setStatus('Saved <b>' + name + '</b>');
  });
}

function exportSVG(){
  const v = state.vector;
  if (!v) return;
  const f = n => Math.round(n*100)/100;
  let body = '';
  if (v.kind === 'circles' || v.kind === 'points'){
    const r0 = v.kind === 'points' ? 0.6 : null;
    body = '<g fill="#000">' + v.items.map(it =>
      '<circle cx="'+f(it[0])+'" cy="'+f(it[1])+'" r="'+f(r0 !== null ? r0 : it[2])+'"/>').join('') + '</g>';
  } else if (v.kind === 'rects'){
    body = '<g fill="#000">' + v.items.map(it =>
      '<rect x="'+f(it[0])+'" y="'+f(it[1])+'" width="'+f(it[2])+'" height="'+f(it[3])+'"'+
      (it[4] < 0.99 ? ' fill-opacity="'+f(it[4])+'"' : '')+'/>').join('') + '</g>';
  } else if (v.kind === 'marks'){
    body = '<g fill="#000">' + v.items.map(it => {
      if (it.t === 'circle') return '<circle cx="'+f(it.x)+'" cy="'+f(it.y)+'" r="'+f(it.r)+'"/>';
      if (it.t === 'ring')   return '<circle cx="'+f(it.x)+'" cy="'+f(it.y)+'" r="'+f(it.r)+'" fill="none" stroke="#000" stroke-width="'+f(it.w)+'"/>';
      if (it.t === 'seg')    return '<line x1="'+f(it.p[0])+'" y1="'+f(it.p[1])+'" x2="'+f(it.p[2])+'" y2="'+f(it.p[3])+'" stroke="#000" stroke-linecap="butt" stroke-width="'+f(it.w)+'"/>';
      return '<polygon points="' + it.p.map(q => f(q[0])+','+f(q[1])).join(' ') + '"/>';
    }).join('') + '</g>';
  } else if (v.kind === 'glyphs'){
    const esc = t => t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const fam = (v.family || 'monospace').replace(/"/g,"'");
    body = '<g fill="#000" font-family="'+fam+'" font-weight="'+(v.weight||400)+'" text-anchor="middle" dominant-baseline="central">' +
      v.items.map(it => '<text x="'+f(it.x)+'" y="'+f(it.y)+'" font-size="'+f(it.size)+'">'+esc(it.s)+'</text>').join('') + '</g>';
  } else if (v.kind === 'segs'){
    body = '<g stroke="#000" stroke-linecap="butt" fill="none">' + v.items.map(it =>
      '<line x1="'+f(it[0])+'" y1="'+f(it[1])+'" x2="'+f(it[2])+'" y2="'+f(it[3])+'" stroke-width="'+f(it[4])+'"/>').join('') + '</g>';
  } else if (v.kind === 'polys'){
    body = '<g stroke="#000" fill="none" stroke-width="0.7" stroke-linejoin="round">' + v.items.map(pl =>
      '<polyline points="' + pl.map(pt => f(pt[0])+','+f(pt[1])).join(' ') + '"/>').join('') + '</g>';
  } else if (v.kind === 'strokes'){
    body = '<g stroke="#000" fill="none" stroke-linejoin="round" stroke-linecap="round">' + v.items.map(st =>
      '<polyline points="' + st.p.map(pt => f(pt[0])+','+f(pt[1])).join(' ') + '" stroke-width="'+f(st.w)+'"/>').join('') + '</g>';
  }
  const bg = $('#alphaBg').checked ? '' : '<rect width="'+v.w+'" height="'+v.h+'" fill="#fff"/>';
  const svg = '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="'+v.w+'" height="'+v.h+'" viewBox="0 0 '+v.w+' '+v.h+'">'+bg+body+'</svg>';
  const blob = new Blob([svg], { type:'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const name = 'flash-' + jobName() + '-' + stamp() + '.svg';
  download(url, name);
  setTimeout(()=>URL.revokeObjectURL(url), 4000);
  setStatus('Saved <b>' + name + '</b> · ' + v.items.length.toLocaleString() + ' elements');
}

function sendToPhoto(){
  const c = document.createElement('canvas');
  c.width = view.width; c.height = view.height;
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0,0,c.width,c.height);
  x.drawImage(view,0,0);
  const img = new Image();
  img.onload = () => {
    state.srcImage = img;
    state.mask = null;
    state.layers = []; renderLayers();
    $('#thumb').src = img.src; $('#thumb').hidden = false;
    $('#srcTag').textContent = 'from ' + (state.mode === 'curve' ? 'curve' : state.mode === 'field' ? 'field' : 'system');
    $('#res').value = clamp(Math.round(img.naturalWidth/100)*100, 400, 4000);
    $('#resV').textContent = $('#res').value + ' px';
    setMode('image');
  };
  img.src = c.toDataURL('image/png');
}

/* ============================================================
   ERASER
   ============================================================ */
function makeMask(){
  if (!state.srcImage) return;
  const base = 1600;
  const w = base, h = Math.max(1, Math.round(base * state.srcImage.naturalHeight / state.srcImage.naturalWidth));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  state.mask = c;
}

let painting = false, lastPt = null;

function canvasPt(e){
  const r = view.getBoundingClientRect();
  return { x:(e.clientX-r.left)/r.width, y:(e.clientY-r.top)/r.height };
}

function paintAt(a,b){
  if (!state.mask) makeMask();
  if (!state.mask) return;
  const m = state.mask, ctx = m.getContext('2d');
  const size = Number($('#brush').value) / view.width * m.width;
  const soft = Number($('#feather').value)/100;
  ctx.globalCompositeOperation = state.tool === 'erase' ? 'source-over' : 'destination-out';
  const x0 = a.x*m.width, y0 = a.y*m.height, x1 = b.x*m.width, y1 = b.y*m.height;
  const steps = Math.max(1, Math.ceil(Math.hypot(x1-x0, y1-y0) / (size*0.25)));
  for (let i=0; i<=steps; i++){
    const t = i/steps, x = x0+(x1-x0)*t, y = y0+(y1-y0)*t;
    if (soft > 0.01){
      const grd = ctx.createRadialGradient(x,y,size*0.5*(1-soft),x,y,size*0.5);
      grd.addColorStop(0,'rgba(0,0,0,1)');
      grd.addColorStop(1,'rgba(0,0,0,0)');
      ctx.fillStyle = grd;
    } else ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.arc(x,y,size*0.5,0,TAU); ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
}

function drawBrushCursor(pt){
  octx.clearRect(0,0,overlay.width,overlay.height);
  if (state.tool === 'off' || !pt) return;
  const size = Number($('#brush').value);
  octx.strokeStyle = state.tool === 'erase' ? ACCENT : '#00000055';
  octx.lineWidth = Math.max(1, view.width/600);
  octx.setLineDash(state.tool === 'erase' ? [] : [6,6]);
  octx.beginPath();
  octx.arc(pt.x*overlay.width, pt.y*overlay.height, size/2, 0, TAU);
  octx.stroke();
  octx.setLineDash([]);
}

function bindEraser(){
  overlay.addEventListener('pointerdown', e => {
    if (state.tool === 'off' || state.mode !== 'image' || !state.srcImage) return;
    overlay.setPointerCapture(e.pointerId);
    painting = true;
    lastPt = canvasPt(e);
    paintAt(lastPt, lastPt);
    drawBrushCursor(lastPt);
  });
  overlay.addEventListener('pointermove', e => {
    const pt = canvasPt(e);
    if (painting){
      paintAt(lastPt, pt);
      lastPt = pt;
      octx.clearRect(0,0,overlay.width,overlay.height);
      octx.globalAlpha = 0.5;
      octx.drawImage(state.mask, 0, 0, overlay.width, overlay.height);
      octx.globalAlpha = 1;
      octx.fillStyle = ACCENT;
      octx.globalCompositeOperation = 'source-in';
      octx.fillRect(0,0,overlay.width,overlay.height);
      octx.globalCompositeOperation = 'source-over';
      drawBrushCursorOver(pt);
    } else drawBrushCursor(pt);
  });
  const stop = () => {
    if (!painting) return;
    painting = false;
    octx.clearRect(0,0,overlay.width,overlay.height);
    render();
  };
  overlay.addEventListener('pointerup', stop);
  overlay.addEventListener('pointercancel', stop);
  overlay.addEventListener('pointerleave', () => { if (!painting) octx.clearRect(0,0,overlay.width,overlay.height); });
}

function drawBrushCursorOver(pt){
  const size = Number($('#brush').value);
  octx.strokeStyle = ACCENT;
  octx.lineWidth = Math.max(1, view.width/600);
  octx.beginPath();
  octx.arc(pt.x*overlay.width, pt.y*overlay.height, size/2, 0, TAU);
  octx.stroke();
}

/* ============================================================
   3D SPIN
   Drag the sheet to orbit a 3D system (Lorenz, Rössler, Aizawa)
   around and find the best angle before you commit to it.
   ============================================================ */
let spinning = false, spinLast = null;
function is3DSystem(){
  return state.mode === 'generate' && SYSTEMS[state.gen.system] && SYSTEMS[state.gen.system].kind === 'ode';
}
function updateSpinUI(){
  const on = is3DSystem();
  $('#paper').classList.toggle('spinnable', on);
  $('#spin3d').hidden = !on;
  $('#autoSpinRow').hidden = !on;
}
function updatePlayButton(){
  $('#playGrowth').textContent = state.growth.playing ? '■ Stop' : '▶ Play growth';
  $('#playGrowth').setAttribute('aria-pressed', String(state.growth.playing));
}
function togglePlayGrowth(){
  state.growth.playing = !state.growth.playing;
  updatePlayButton();
  if (state.growth.playing) render();
  else stopRun();
}
function toggleAutoSpin(){
  state.spin.auto = !state.spin.auto;
  $('#autoSpinBtn').setAttribute('aria-pressed', String(state.spin.auto));
  if (state.spin.auto) render();
}
function bindSpin(){
  overlay.addEventListener('pointerdown', e => {
    if (!is3DSystem()) return;
    spinning = true;
    spinLast = { x:e.clientX, y:e.clientY };
    overlay.setPointerCapture(e.pointerId);
  });
  overlay.addEventListener('pointermove', e => {
    if (!spinning) return;
    const dx = e.clientX - spinLast.x, dy = e.clientY - spinLast.y;
    spinLast = { x:e.clientX, y:e.clientY };
    state.rot3d.y += dx * 0.008;
    state.rot3d.x = clamp(state.rot3d.x + dy*0.008, -1.5, 1.5);
    scheduleRender();
  });
  const stop = () => { spinning = false; };
  overlay.addEventListener('pointerup', stop);
  overlay.addEventListener('pointercancel', stop);
}

function setTool(t){
  state.tool = t;
  $$('#brushChips .chip').forEach(c => c.setAttribute('aria-pressed', String(c.dataset.tool === t)));
  $('#paper').classList.toggle('painting', t !== 'off' && state.mode === 'image');
  $('#eraseTag').textContent = t === 'off' ? '' : t === 'erase' ? 'rubbing out' : 'bringing back';
  octx.clearRect(0,0,overlay.width,overlay.height);
}

/* ============================================================
   LAYERS
   "Add current as layer" locks in a snapshot of whatever is on
   the sheet right now — prepare + effect, exactly as rendered —
   as a transparent PNG. Every render after that draws the locked
   layers back on top of the live effect below them, so you can
   keep tweaking underneath while the earlier passes stay put.
   ============================================================ */
function compositeLayers(){
  if (!state.layers.length) return;
  state.layers.forEach(L => {
    if (!L.visible) return;
    vctx.globalCompositeOperation = L.blend || 'source-over';
    vctx.globalAlpha = L.opacity != null ? L.opacity : 1;
    vctx.drawImage(L.img, 0, 0, view.width, view.height);
  });
  vctx.globalCompositeOperation = 'source-over';
  vctx.globalAlpha = 1;
}

function addLayerFromCurrent(){
  if (!view.width || state.mode !== 'image') return;
  const fold = Math.max(1, Math.round(Number($('#layerFold').value) || 1));
  const c = document.createElement('canvas');
  c.width = view.width; c.height = view.height;
  const cx = c.getContext('2d');
  const cxp = c.width/2, cyp = c.height/2;
  for (let k=0; k<fold; k++){
    cx.save();
    cx.translate(cxp, cyp);
    cx.rotate(k * TAU/fold);
    cx.translate(-cxp, -cyp);
    cx.drawImage(view, 0, 0);
    cx.restore();
  }
  const img = new Image();
  img.onload = () => {
    state.layers.push({
      id: Date.now()+'-'+Math.random().toString(36).slice(2,6),
      name: EFFECTS[state.effect].label + (fold > 1 ? ' ×'+fold : ''),
      img, blend:'source-over', opacity:1, visible:true
    });
    renderLayers();
    render();
    setStatus('Layer added' + (fold > 1 ? ' · duplicated ' + fold + '×' : '') + ' · <b>' + state.layers.length + '</b> total');
  };
  img.src = c.toDataURL('image/png');
}

function clearLayers(){
  state.layers = [];
  renderLayers();
  render();
}

const LAYER_BLENDS = [
  ['source-over','Normal'],
  ['multiply','Multiply'],
  ['screen','Screen'],
  ['overlay','Overlay'],
  ['darken','Darken'],
  ['lighten','Lighten'],
  ['color-dodge','Color Dodge'],
  ['color-burn','Color Burn'],
  ['hard-light','Hard Light'],
  ['soft-light','Soft Light'],
  ['difference','Difference'],
  ['exclusion','Exclusion']
];

function renderLayers(){
  const host = $('#layerList');
  $('#layerTag').textContent = state.layers.length ? state.layers.length + ' locked' : '';
  host.innerHTML = '';
  if (!state.layers.length){
    host.innerHTML = '<p class="hint">No layers locked in yet.</p>';
    return;
  }
  state.layers.forEach((L, i) => {
    const row = document.createElement('div');
    row.className = 'layer-row';

    const top = document.createElement('div');
    top.className = 'layer-top';
    const thumb = document.createElement('img');
    thumb.className = 'layer-thumb'; thumb.src = L.img.src; thumb.alt = '';
    const vis = document.createElement('input');
    vis.type = 'checkbox'; vis.checked = L.visible;
    vis.addEventListener('change', () => { L.visible = vis.checked; render(); });
    const name = document.createElement('b');
    name.textContent = (i+1) + '. ' + L.name;
    const up = document.createElement('button');
    up.type='button'; up.className='layer-btn'; up.textContent='↑'; up.title='Move up'; up.disabled = i===0;
    up.addEventListener('click', () => { [state.layers[i-1], state.layers[i]] = [state.layers[i], state.layers[i-1]]; renderLayers(); render(); });
    const down = document.createElement('button');
    down.type='button'; down.className='layer-btn'; down.textContent='↓'; down.title='Move down'; down.disabled = i===state.layers.length-1;
    down.addEventListener('click', () => { [state.layers[i+1], state.layers[i]] = [state.layers[i], state.layers[i+1]]; renderLayers(); render(); });
    const del = document.createElement('button');
    del.type='button'; del.className='layer-btn layer-del'; del.textContent='×'; del.title='Delete layer';
    del.addEventListener('click', () => { state.layers.splice(i,1); renderLayers(); render(); });
    top.append(thumb, vis, name, up, down, del);

    const bottom = document.createElement('div');
    bottom.className = 'layer-bottom';
    const sel = document.createElement('select');
    LAYER_BLENDS.forEach(([v,l]) => { const o=document.createElement('option'); o.value=v; o.textContent=l; if (v===L.blend) o.selected=true; sel.appendChild(o); });
    sel.addEventListener('change', () => { L.blend = sel.value; render(); });
    const op = document.createElement('input');
    op.type='range'; op.min=0; op.max=1; op.step=0.02; op.value=L.opacity;
    op.addEventListener('input', () => { L.opacity = Number(op.value); render(); });
    bottom.append(sel, op);

    row.append(top, bottom);
    host.appendChild(row);
  });
}

/* ============================================================
   BACKGROUND REMOVAL
   Flood-fills in from the edges of the photo, growing through
   pixels that are close in colour to ones already claimed as
   background. Feeds the result into the same erase mask the
   brush uses, so it composites and undoes the same way.
   ============================================================ */
function autoRemoveBackground(){
  if (!state.srcImage){ setStatus('Load a photo first'); return; }
  if (!state.mask) makeMask();

  const tol = Number($('#bgTol').value);
  const sw = 260;
  const sh = Math.max(1, Math.round(sw * state.srcImage.naturalHeight / state.srcImage.naturalWidth));
  const sc = document.createElement('canvas');
  sc.width = sw; sc.height = sh;
  const sctx = sc.getContext('2d', { willReadFrequently:true });
  sctx.drawImage(state.srcImage, 0, 0, sw, sh);
  const id = sctx.getImageData(0, 0, sw, sh);
  const d = id.data;

  const idx = (x,y) => y*sw + x;
  const dist = (i,j) => {
    const pi = i*4, pj = j*4;
    const dr = d[pi]-d[pj], dg = d[pi+1]-d[pj+1], db = d[pi+2]-d[pj+2];
    return Math.sqrt(dr*dr + dg*dg + db*db);
  };
  const thresh = 6 + (tol/100) * 90;

  const seen = new Uint8Array(sw*sh);
  const q = [];
  for (let x=0; x<sw; x++){ q.push(idx(x,0)); q.push(idx(x,sh-1)); }
  for (let y=0; y<sh; y++){ q.push(idx(0,y)); q.push(idx(sw-1,y)); }
  for (const i of q) seen[i] = 1;

  let qi = 0;
  while (qi < q.length){
    const i = q[qi++];
    const x = i % sw, y = (i/sw)|0;
    const nb = [[x-1,y],[x+1,y],[x,y-1],[x,y+1]];
    for (const [nx,ny] of nb){
      if (nx<0 || ny<0 || nx>=sw || ny>=sh) continue;
      const ni = idx(nx,ny);
      if (seen[ni]) continue;
      if (dist(i,ni) <= thresh){ seen[ni] = 1; q.push(ni); }
    }
  }

  const mimg = sctx.createImageData(sw,sh);
  for (let i=0; i<sw*sh; i++){
    mimg.data[i*4+3] = seen[i] ? 255 : 0;
  }
  sctx.putImageData(mimg, 0, 0);

  const mctx = state.mask.getContext('2d');
  mctx.globalCompositeOperation = 'source-over';
  mctx.drawImage(sc, 0, 0, state.mask.width, state.mask.height);

  render();
  const pct = Math.round(q.length/(sw*sh)*100);
  setStatus('Background removed · <b>' + pct + '%</b> of the frame');
}

/* ============================================================
   FLASH SHEET
   ============================================================ */
const SHEET_SCHEMA = [
  { k:'cols',   l:'Across', t:'range', min:1, max:8, step:1, v:3 },
  { k:'gap',    l:'Gap', t:'range', min:0, max:200, step:5, v:40, fmt:v=>v+' px' },
  { k:'margin', l:'Margin', t:'range', min:0, max:300, step:10, v:60, fmt:v=>v+' px' },
  { k:'width',  l:'Sheet width', t:'range', min:800, max:4000, step:100, v:2000, fmt:v=>v+' px' }
];

function pinDesign(){
  if (!view.width) return;
  const c = document.createElement('canvas');
  c.width = view.width; c.height = view.height;
  c.getContext('2d').drawImage(view, 0, 0);
  state.pins.push({ url:c.toDataURL('image/png'), w:c.width, h:c.height });
  renderPins();
  setStatus('Pinned · <b>' + state.pins.length + '</b> on the sheet');
}

function renderPins(){
  const grid = $('#pinGrid');
  grid.innerHTML = '';
  grid.classList.toggle('empty', state.pins.length === 0);
  $('#pinTag').textContent = state.pins.length ? state.pins.length + ' pinned' : '';
  state.pins.forEach((pin, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = 'Drop this one';
    b.style.background = '#fff';
    const img = document.createElement('img');
    img.src = pin.url; img.alt = '';
    b.appendChild(img);
    b.addEventListener('click', () => { state.pins.splice(i,1); renderPins(); });
    grid.appendChild(b);
  });
}

function layoutSheet(){
  if (!state.pins.length){ setStatus('Nothing pinned yet'); return; }
  stopRun();
  const S = state.sheet;
  const cols = Math.min(Math.round(S.cols), state.pins.length);
  const rows = Math.ceil(state.pins.length/cols);
  const W = Math.round(S.width);
  const cellW = (W - S.margin*2 - S.gap*(cols-1))/cols;
  let tallest = 0;
  state.pins.forEach(p => { tallest = Math.max(tallest, p.h/p.w); });
  const cellH = cellW*tallest;
  const H = Math.round(S.margin*2 + rows*cellH + S.gap*(rows-1));
  Promise.all(state.pins.map(p => new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = p.url;
  }))).then(imgs => {
    beginCanvas(W, H);
    imgs.forEach((im, i) => {
      const c = i%cols, r = Math.floor(i/cols);
      const x0 = S.margin + c*(cellW + S.gap);
      const y0 = S.margin + r*(cellH + S.gap);
      const k = Math.min(cellW/im.width, cellH/im.height);
      const dw = im.width*k, dh = im.height*k;
      vctx.drawImage(im, x0 + (cellW-dw)/2, y0 + (cellH-dh)/2, dw, dh);
    });
    state.vector = null;
    setStatus('Sheet laid out · export it now, the next slider redraws');
    measureInk();
    updateReadout();
  }).catch(() => setStatus('One of the pins would not open'));
}

/* ============================================================
   PRESETS
   Full snapshots of the current pipeline — prepare and effect
   thresholds in Photo mode, or the system/curve/field dials —
   kept in localStorage and exportable as a JSON file.
   ============================================================ */
const PRESET_KEY = 'flashMachinePresets';

function loadPresets(){
  try { return JSON.parse(localStorage.getItem(PRESET_KEY) || '[]'); }
  catch(e){ return []; }
}
function savePresetsList(list){
  localStorage.setItem(PRESET_KEY, JSON.stringify(list));
}
function escapeHtml(t){
  return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function capturePreset(){
  const mode = state.mode;
  if (mode === 'image') return { mode, data: { pre:{...state.pre}, effect:state.effect, fx:{...state.fx} } };
  if (mode === 'generate') return { mode, data: { system:state.gen.system, gen:{...state.gen}, genP:{...state.genP} } };
  if (mode === 'curve') return { mode, data: { key:state.curve.key, curve:{...state.curve}, curveP:{...state.curveP} } };
  return { mode, data: { key:state.field.key, field:{...state.field}, fieldP:{...state.fieldP} } };
}

function presetSubtitle(p){
  const d = p.data;
  if (p.mode === 'image') return (EFFECTS[d.effect] ? EFFECTS[d.effect].label : d.effect);
  if (p.mode === 'generate') return (SYSTEMS[d.system] ? SYSTEMS[d.system].label : d.system);
  if (p.mode === 'curve') return (CURVES[d.key] ? CURVES[d.key].label : d.key);
  return (FIELDS[d.key] ? FIELDS[d.key].label : d.key);
}

function savePreset(){
  const nameInput = $('#presetName');
  const name = nameInput.value.trim();
  if (!name){ setStatus('Name the preset first'); return; }
  const list = loadPresets();
  const snap = capturePreset();
  list.push({ id: Date.now()+'-'+Math.random().toString(36).slice(2,7), name, mode: snap.mode, data: snap.data, thumb: makeThumb(120) });
  savePresetsList(list);
  nameInput.value = '';
  renderPresets();
  setStatus('Saved preset <b>' + escapeHtml(name) + '</b>');
}

function deletePreset(id){
  savePresetsList(loadPresets().filter(p => p.id !== id));
  renderPresets();
}

function applyPreset(p){
  const mode = p.mode, data = p.data;
  if (mode === 'image'){
    setMode('image');
    Object.assign(state.pre, data.pre);
    buildControls($('#preControls'), PRE_SCHEMA, state.pre, scheduleRender);
    state.fxAll[data.effect] = Object.assign({}, data.fx);
    selectEffect(data.effect);
  } else if (mode === 'generate'){
    setMode('generate');
    state.genAll[data.system] = Object.assign({}, data.genP);
    Object.assign(state.gen, data.gen);
    buildRenderControls();
    state.keepRender = true;
    selectSystem(data.system);
    state.keepRender = false;
  } else if (mode === 'curve'){
    setMode('curve');
    state.curveAll[data.key] = Object.assign({}, data.curveP);
    Object.assign(state.curve, data.curve);
    selectCurve(data.key);
  } else {
    setMode('field');
    state.fieldAll[data.key] = Object.assign({}, data.fieldP);
    Object.assign(state.field, data.field);
    selectField(data.key);
  }
  setStatus('Loaded preset <b>' + escapeHtml(p.name) + '</b>');
}

function renderPresets(){
  const list = loadPresets();
  $('#presetTag').textContent = list.length ? list.length + ' saved' : '';
  const host = $('#presetList');
  host.innerHTML = '';
  if (!list.length){
    host.innerHTML = '<p class="hint">No presets saved yet.</p>';
    return;
  }
  list.slice().reverse().forEach(p => {
    const row = document.createElement('div');
    row.className = 'preset-row';
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'preset-apply'; btn.title = 'Load this preset';
    if (p.thumb){
      const img = document.createElement('img');
      img.className = 'preset-thumb'; img.src = p.thumb; img.alt = '';
      btn.appendChild(img);
    }
    const text = document.createElement('div');
    text.className = 'preset-text';
    text.innerHTML = '<b>' + escapeHtml(p.name) + '</b><span>' + p.mode + ' · ' + escapeHtml(presetSubtitle(p)) + '</span>';
    btn.appendChild(text);
    btn.addEventListener('click', () => applyPreset(p));
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'preset-del'; del.textContent = '×'; del.title = 'Delete preset';
    del.addEventListener('click', e => { e.stopPropagation(); deletePreset(p.id); });
    row.appendChild(btn); row.appendChild(del);
    host.appendChild(row);
  });
}

function exportPresets(){
  const list = loadPresets();
  if (!list.length){ setStatus('Nothing saved to export'); return; }
  const blob = new Blob([JSON.stringify(list, null, 2)], { type:'application/json' });
  download(URL.createObjectURL(blob), 'flash-machine-presets.json');
  setStatus('Exported <b>' + list.length + '</b> presets');
}

function importPresetsFile(file){
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const incoming = JSON.parse(reader.result);
      if (!Array.isArray(incoming)) throw new Error('bad format');
      savePresetsList(loadPresets().concat(incoming));
      renderPresets();
      setStatus('Imported <b>' + incoming.length + '</b> presets');
    } catch(e){
      setStatus('That file did not look like a presets export');
    }
  };
  reader.readAsText(file);
}

/* ============================================================
   WIRING
   ============================================================ */
let renderTimer = null;
function scheduleRender(){
  clearTimeout(renderTimer);
  if (state.mode === 'image') setStatus('Rendering…');
  renderTimer = setTimeout(render, 70);
}
function render(){
  if (state.mode === 'image'){ stopRun(); renderImage(); }
  else if (state.mode === 'curve'){ stopRun(); runCurve(); }
  else if (state.mode === 'field'){ stopRun(); runField(); }
  else runGenerator();
}

function setMode(m){
  state.mode = m;
  $$('.modes button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.mode === m)));
  $$('[data-only]').forEach(el => { el.hidden = !el.dataset.only.split(' ').includes(m); });
  $('#systemSel').parentElement.hidden = m !== 'generate';
  $('#curveSel').parentElement.hidden = m !== 'curve';
  $('#fieldSel').parentElement.hidden = m !== 'field';
  $('#pickTitle').firstChild.textContent = m === 'curve' ? 'Curve' : m === 'field' ? 'Field' : 'System';
  $('#paper').classList.toggle('painting', state.tool !== 'off' && m === 'image');
  $('#growthPlay').hidden = m !== 'generate';
  if (m !== 'generate') updateSpinUI();
  if (m === 'image'){ renderEffectChips(); renderEffectPanels(); render(); }
  else if (m === 'curve') selectCurve(state.curve.key);
  else if (m === 'field') selectField(state.field.key);
  else selectSystem(state.gen.system);
}

function selectEffect(key){
  state.effect = key;
  state.activeEffects = [key];
  state.fxAll[key] = state.fxAll[key] || {};
  state.fx = state.fxAll[key];
  renderEffectChips();
  renderEffectPanels();
  render();
}

function toggleCombineEffect(key){
  const idx = state.activeEffects.indexOf(key);
  if (idx >= 0){
    if (state.activeEffects.length === 1){ setStatus('Keep at least one treatment active'); return; }
    state.activeEffects.splice(idx,1);
  } else {
    state.fxAll[key] = state.fxAll[key] || {};
    state.activeEffects.push(key);
    state.effect = key;
  }
  renderEffectChips();
  renderEffectPanels();
  render();
}

function renderEffectChips(){
  $$('#effectChips .chip').forEach(c => c.setAttribute('aria-pressed', String(state.activeEffects.includes(c.dataset.k))));
}

function renderEffectPanels(){
  const host = $('#fxControls');
  host.innerHTML = '';
  if (state.activeEffects.length <= 1){
    const key = state.activeEffects[0] || state.effect;
    state.fxAll[key] = state.fxAll[key] || {};
    state.fx = state.fxAll[key];
    $('#fxTag').textContent = EFFECTS[key].label;
    const hint = document.createElement('p');
    hint.className = 'hint'; hint.textContent = EFFECTS[key].note;
    host.appendChild(hint);
    const box = document.createElement('div');
    host.appendChild(box);
    buildControls(box, EFFECTS[key].controls, state.fxAll[key], scheduleRender);
    return;
  }
  $('#fxTag').textContent = state.activeEffects.length + ' combined';
  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = 'Every active treatment renders on its own pass and stacks together, in the order picked.';
  host.appendChild(hint);
  state.activeEffects.forEach(key => {
    state.fxAll[key] = state.fxAll[key] || {};
    const wrap = document.createElement('div');
    wrap.className = 'fx-combo';
    const head = document.createElement('div');
    head.className = 'fx-combo-head';
    const name = document.createElement('b'); name.textContent = EFFECTS[key].label;
    const rm = document.createElement('button');
    rm.type = 'button'; rm.className = 'fx-combo-rm'; rm.textContent = '×'; rm.title = 'Remove from the mix';
    rm.addEventListener('click', () => toggleCombineEffect(key));
    head.append(name, rm);
    const note = document.createElement('p');
    note.className = 'hint'; note.textContent = EFFECTS[key].note;
    const box = document.createElement('div');
    wrap.append(head, note, box);
    host.appendChild(wrap);
    buildControls(box, EFFECTS[key].controls, state.fxAll[key], scheduleRender);
  });
}

const RENDER_SCHEMA = [
  { k:'points',  l:'Iterations', t:'range', min:20000, max:4000000, step:20000, v:900000, fmt:v => v>=1000000 ? (v/1000000).toFixed(2)+' M' : (v/1000)+'k' },
  { k:'exposure',l:'Exposure', t:'range', min:0.05, max:6, step:0.05, v:1, fmt:v=>v.toFixed(2) },
  { k:'gamma',   l:'Falloff', t:'range', min:0.15, max:2.5, step:0.05, v:0.55, fmt:v=>v.toFixed(2) },
  { k:'detail',  l:'Resolution', t:'range', min:500, max:2400, step:100, v:1100, fmt:v=>v+' px' },
  { k:'format',  l:'Format', t:'select', v:'square', opts:[['square','Square'],['portrait','Portrait 3:4'],['tall','Tall 5:8'],['wide','Landscape 3:2']] },
  { k:'draw',    l:'Draw as', t:'select', v:'dots', opts:[['dots','Dots'],['lines','Continuous line']] }
];
function buildRenderControls(){ buildControls($('#renderControls'), RENDER_SCHEMA, state.gen, scheduleRender); }

function selectSystem(key){
  state.gen.system = key;
  const sys = SYSTEMS[key];
  state.genAll[key] = state.genAll[key] || {};
  state.genP = state.genAll[key];
  $('#systemSel').value = key;
  $('#systemNote').textContent = sys.note;
  $('#fxTag').textContent = sys.label;
  $('#formulaSect').hidden = !sys.custom;
  if (sys.custom){
    $('#fxLabel').textContent = 'next x'; $('#fyLabel').textContent = 'next y';
    $('#formulaHint').textContent = 'Each step feeds x and y back in. Use a, b, c, d for the dials, i for the step count, and any Math function without the prefix: sin, cos, abs, sqrt, exp, pow, sign, atan2, random.';
    compileFormula(true);
  }
  if (sys.suggest && !state.keepRender){ Object.assign(state.gen, sys.suggest); buildRenderControls(); }
  const host = $('#fxControls');
  host.innerHTML = '';
  const box = document.createElement('div');
  host.appendChild(box);
  buildControls(box, sys.dials, state.genP, scheduleRender);
  updateSpinUI();
  render();
}

function selectCurve(key){
  state.curve.key = key;
  const cv = CURVES[key];
  state.curveAll[key] = state.curveAll[key] || {};
  state.curveP = state.curveAll[key];
  $('#curveSel').value = key;
  $('#systemNote').textContent = cv.note;
  $('#fxTag').textContent = cv.label;
  $('#formulaSect').hidden = !cv.custom;
  if (cv.custom){
    $('#fxLabel').textContent = 'x(t)'; $('#fyLabel').textContent = 'y(t)';
    $('#formulaHint').textContent = 'Both lines get t, plus a, b, c and d from the dials. Any Math function works without the prefix: sin, cos, abs, sqrt, exp, pow, atan2.';
    compileFormula(true);
  }
  const host = $('#fxControls');
  host.innerHTML = '';
  const box = document.createElement('div');
  host.appendChild(box);
  buildControls(box, cv.dials, state.curveP, scheduleRender);
  buildControls($('#curveControls'), CURVE_SCHEMA, state.curve, scheduleRender);
  render();
}

function selectField(key){
  state.field.key = key;
  const fd = FIELDS[key];
  state.fieldAll[key] = state.fieldAll[key] || {};
  state.fieldP = state.fieldAll[key];
  $('#fieldSel').value = key;
  $('#systemNote').textContent = fd.note;
  $('#fxTag').textContent = fd.label;
  $('#formulaSect').hidden = true;
  const host = $('#fxControls');
  host.innerHTML = '';
  const box = document.createElement('div');
  host.appendChild(box);
  buildControls(box, fd.dials, state.fieldP, scheduleRender);
  buildControls($('#fieldControls'), FIELD_SCHEMA, state.field, scheduleRender);
  render();
}

const MATH_NAMES = 'sin cos tan asin acos atan atan2 abs sqrt cbrt exp log pow sign floor ceil round min max hypot PI E random'.split(' ');
function compileFormula(silent){
  const fx = $('#fx').value, fy = $('#fy').value;
  const args = MATH_NAMES.join(',');
  const vals = MATH_NAMES.map(n => Math[n]);
  const curveMode = state.mode === 'curve';
  try {
    const body = 'const {a,b,c,d}=p; return [(' + fx + '),(' + fy + ')];';
    let fn;
    if (curveMode){
      const raw = new Function('t','p',args, body);
      fn = (t,p) => raw.apply(null, [t,p].concat(vals));
      const test = fn(0.3, {a:1,b:1,c:1,d:1});
      checkPair(test);
      state.customCurve = fn;
    } else {
      const raw = new Function('x','y','p','i',args, body);
      let n = 0;
      fn = (x,y,p) => raw.apply(null, [x,y,p,n++].concat(vals));
      const test = fn(0.1,0.1,{a:1,b:1,c:1,d:1});
      checkPair(test);
      state.customFn = fn;
    }
    $('#formulaErr').textContent = '';
    return true;
  } catch(e){
    $('#formulaErr').textContent = e.message;
    if (!silent) setStatus('Formula did not run');
    return false;
  }
}
function checkPair(t){
  if (!Array.isArray(t) || t.length !== 2 || typeof t[0] !== 'number' || typeof t[1] !== 'number')
    throw new Error('Both lines have to work out to a number');
}

/* ============================================================
   SHAPE LIBRARY
   A handful of built-in flash motifs — load one straight in as
   the source image, the same as dropping a photo.
   ============================================================ */
const SHAPE_LIBRARY = {
  star: { label:'Star', draw:(ctx,S) => {
    const cx=S/2, cy=S/2, rOuter=S*0.42, rInner=S*0.165, spikes=5;
    ctx.beginPath();
    for (let i=0; i<spikes*2; i++){
      const a = i/(spikes*2)*TAU - Math.PI/2;
      const r = i%2===0 ? rOuter : rInner;
      const x = cx+Math.cos(a)*r, y = cy+Math.sin(a)*r;
      i===0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
    }
    ctx.closePath(); ctx.fill();
  }},
  flower: { label:'Flower', draw:(ctx,S) => {
    const cx=S/2, cy=S/2, petals=6, pr=S*0.22, dist=S*0.19;
    for (let i=0; i<petals; i++){
      const a = i/petals*TAU;
      ctx.beginPath();
      ctx.ellipse(cx+Math.cos(a)*dist, cy+Math.sin(a)*dist, pr, pr*0.6, a, 0, TAU);
      ctx.fill();
    }
    ctx.beginPath(); ctx.arc(cx,cy,S*0.11,0,TAU); ctx.fill();
  }},
  moon: { label:'Moon', draw:(ctx,S) => {
    const cx=S/2, cy=S/2, r1=S*0.32, r2=r1*0.72, dx=r1-r2;
    ctx.beginPath();
    ctx.arc(cx,cy,r1,0,TAU);
    ctx.moveTo(cx+dx+r2, cy);
    ctx.arc(cx+dx,cy,r2,0,TAU,true);
    ctx.fill('evenodd');
  }},
  sun: { label:'Sun', draw:(ctx,S) => {
    const cx=S/2, cy=S/2, r=S*0.19, rays=12, rayLen=S*0.15, rayW=S*0.032;
    for (let i=0; i<rays; i++){
      const a = i/rays*TAU;
      ctx.save();
      ctx.translate(cx,cy); ctx.rotate(a);
      ctx.beginPath();
      ctx.moveTo(-rayW/2, -r-1);
      ctx.lineTo(rayW/2, -r-1);
      ctx.lineTo(0, -r-rayLen);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    ctx.beginPath(); ctx.arc(cx,cy,r,0,TAU); ctx.fill();
  }},
  cat: { label:'Animal', draw:(ctx,S) => {
    const cx=S*0.47, cy=S*0.6;
    ctx.beginPath(); ctx.ellipse(cx,cy,S*0.22,S*0.28,0,0,TAU); ctx.fill();
    const hx=cx, hy=cy-S*0.33, hr=S*0.14;
    ctx.beginPath(); ctx.arc(hx,hy,hr,0,TAU); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(hx-hr*0.8, hy-hr*0.5); ctx.lineTo(hx-hr*1.5, hy-hr*1.8); ctx.lineTo(hx-hr*0.05, hy-hr*0.85);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(hx+hr*0.8, hy-hr*0.5); ctx.lineTo(hx+hr*1.5, hy-hr*1.8); ctx.lineTo(hx+hr*0.05, hy-hr*0.85);
    ctx.closePath(); ctx.fill();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = S*0.065;
    ctx.beginPath();
    ctx.moveTo(cx+S*0.17, cy+S*0.24);
    ctx.bezierCurveTo(cx+S*0.42, cy+S*0.20, cx+S*0.47, cy-S*0.13, cx+S*0.29, cy-S*0.30);
    ctx.stroke();
  }}
};

function loadLibraryShape(key){
  const spec = SHAPE_LIBRARY[key];
  if (!spec) return;
  const S = 900;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0,0,S,S);
  ctx.fillStyle = '#000'; ctx.strokeStyle = '#000';
  spec.draw(ctx, S);
  const img = new Image();
  img.onload = () => {
    state.srcImage = img;
    state.mask = null;
    state.layers = []; renderLayers();
    $('#thumb').src = img.src; $('#thumb').hidden = false;
    $('#srcTag').textContent = spec.label + ' · library';
    setMode('image');
    setStatus('Loaded <b>' + spec.label + '</b> from the library');
  };
  img.src = c.toDataURL('image/png');
}

function buildLibraryGrid(){
  const grid = $('#libraryGrid');
  if (!grid) return;
  grid.classList.remove('empty');
  Object.keys(SHAPE_LIBRARY).forEach(key => {
    const spec = SHAPE_LIBRARY[key];
    const prev = document.createElement('canvas');
    prev.width = 120; prev.height = 120;
    const pctx = prev.getContext('2d');
    pctx.fillStyle = '#fff'; pctx.fillRect(0,0,120,120);
    pctx.fillStyle = '#000'; pctx.strokeStyle = '#000';
    spec.draw(pctx, 120);
    const b = document.createElement('button');
    b.type = 'button'; b.title = spec.label;
    const img = document.createElement('img');
    img.src = prev.toDataURL('image/png'); img.alt = spec.label;
    b.appendChild(img);
    b.addEventListener('click', () => loadLibraryShape(key));
    grid.appendChild(b);
  });
}

function loadFile(file){
  if (!file || !file.type.startsWith('image/')) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    state.srcImage = img;
    state.mask = null;
    state.layers = []; renderLayers();
    $('#thumb').src = url; $('#thumb').hidden = false;
    $('#srcTag').textContent = img.naturalWidth + '×' + img.naturalHeight;
    setMode('image');
  };
  img.onerror = () => setStatus('That file would not open as an image');
  img.src = url;
}

function boot(){
  const chips = $('#effectChips');
  EFFECT_ORDER.forEach(k => {
    const b = document.createElement('button');
    b.className = 'chip'; b.dataset.k = k; b.textContent = EFFECTS[k].label;
    b.setAttribute('aria-pressed','false');
    b.addEventListener('click', () => { state.combine ? toggleCombineEffect(k) : selectEffect(k); });
    chips.appendChild(b);
  });

  const sel = $('#systemSel');
  Object.keys(SYSTEMS).forEach(k => {
    const o = document.createElement('option'); o.value = k; o.textContent = SYSTEMS[k].label; sel.appendChild(o);
  });
  sel.addEventListener('change', () => selectSystem(sel.value));

  const fsel = $('#fieldSel');
  Object.keys(FIELDS).forEach(k => {
    const o = document.createElement('option'); o.value = k; o.textContent = FIELDS[k].label; fsel.appendChild(o);
  });
  fsel.addEventListener('change', () => selectField(fsel.value));

  const csel = $('#curveSel');
  Object.keys(CURVES).forEach(k => {
    const o = document.createElement('option'); o.value = k; o.textContent = CURVES[k].label; csel.appendChild(o);
  });
  csel.addEventListener('change', () => selectCurve(csel.value));

  buildControls($('#preControls'), PRE_SCHEMA, state.pre, scheduleRender);
  $('#preReset').addEventListener('click', () => {
    PRE_SCHEMA.forEach(c => { state.pre[c.k] = c.v; });
    buildControls($('#preControls'), PRE_SCHEMA, state.pre, scheduleRender);
    render();
    setStatus('Prepare reset to defaults');
  });
  buildRenderControls();
  buildControls($('#curveControls'), CURVE_SCHEMA, state.curve, scheduleRender);
  buildControls($('#fieldControls'), FIELD_SCHEMA, state.field, scheduleRender);
  buildControls($('#pinControls'), SHEET_SCHEMA, state.sheet, () => {});
  bindEraser();
  bindSpin();
  $('#resetSpin').addEventListener('click', () => {
    state.rot3d.x = 0.35; state.rot3d.y = 0.6;
    render();
  });
  $('#autoSpinBtn').addEventListener('click', toggleAutoSpin);
  $('#playGrowth').addEventListener('click', togglePlayGrowth);
  $('#growthLoop').addEventListener('change', e => { state.growth.loop = e.target.checked; });
  $('#growthDuration').addEventListener('input', () => {
    state.growth.duration = Number($('#growthDuration').value);
    $('#growthDurationV').textContent = state.growth.duration.toFixed(1) + ' s';
  });
  renderLayers();
  $('#layerAdd').addEventListener('click', addLayerFromCurrent);
  $('#layerClear').addEventListener('click', clearLayers);

  $('#drop').addEventListener('click', () => $('#file').click());
  $('#drop').addEventListener('keydown', e => { if (e.key==='Enter'||e.key===' '){ e.preventDefault(); $('#file').click(); } });
  $('#file').addEventListener('change', e => loadFile(e.target.files[0]));
  ['dragenter','dragover'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); $('#drop').classList.add('over'); }));
  ['dragleave','drop'].forEach(t => document.addEventListener(t, e => {
    e.preventDefault();
    if (t==='dragleave' && e.relatedTarget) return;
    $('#drop').classList.remove('over');
  }));
  document.addEventListener('drop', e => { if (e.dataTransfer && e.dataTransfer.files.length) loadFile(e.dataTransfer.files[0]); });
  document.addEventListener('paste', e => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) if (it.type.startsWith('image/')) loadFile(it.getAsFile());
  });

  $('#res').addEventListener('input', () => { $('#resV').textContent = $('#res').value + ' px'; scheduleRender(); });
  $('#skin').addEventListener('input', () => { $('#skinV').textContent = Number($('#skin').value).toFixed(1)+' cm'; updateReadout(); });
  $('#brush').addEventListener('input', () => { $('#brushV').textContent = $('#brush').value + ' px'; });
  $('#feather').addEventListener('input', () => { $('#featherV').textContent = $('#feather').value + '%'; });
  $('#crisp').addEventListener('change', e => view.classList.toggle('crisp', e.target.checked));
  $$('#brushChips .chip').forEach(c => c.addEventListener('click', () => setTool(c.dataset.tool)));
  $('#clearMask').addEventListener('click', () => { state.mask = null; octx.clearRect(0,0,overlay.width,overlay.height); render(); });
  $('#combineFx').addEventListener('change', e => {
    state.combine = e.target.checked;
    if (!state.combine && state.activeEffects.length > 1){
      state.activeEffects = [state.effect];
      renderEffectChips(); renderEffectPanels(); render();
    }
  });
  $('#bgTol').addEventListener('input', () => { $('#bgTolV').textContent = $('#bgTol').value + '%'; });
  $('#removeBg').addEventListener('click', autoRemoveBackground);
  $('#effectFilter').addEventListener('input', () => {
    const q = $('#effectFilter').value.trim().toLowerCase();
    $$('#effectChips .chip').forEach(c => { c.hidden = q.length>0 && !c.textContent.toLowerCase().includes(q); });
  });

  $$('.modes button').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));

  $('#shuffle').addEventListener('click', () => {
    if (state.mode === 'field'){
      const fd = FIELDS[state.field.key];
      fd.dials.forEach(d => {
        if (d.t !== 'range') return;
        state.fieldP[d.k] = Number((d.min + Math.random()*(d.max-d.min)).toFixed(3));
      });
      state.seed = Math.floor(Math.random()*1e9);
      selectField(state.field.key);
      setStatus('Shuffled ' + fd.label);
      return;
    }
    if (state.mode === 'curve'){
      const cv = CURVES[state.curve.key];
      cv.dials.forEach(d => {
        if (d.t !== 'range' || d.k === 'turns') return;
        state.curveP[d.k] = Number((d.min + Math.random()*(d.max-d.min)).toFixed(3));
      });
      selectCurve(state.curve.key);
      setStatus('Shuffled ' + cv.label);
    } else smartShuffle();
  });
  $('#reseed').addEventListener('click', () => {
    state.seed = Math.floor(Math.random()*1e9);
    setStatus('Seed <b>' + state.seed + '</b>');
    render();
  });
  $('#exploreBtn').addEventListener('click', explore);
  $('#applyFormula').addEventListener('click', () => { if (compileFormula()) render(); });

  $('#pinBtn').addEventListener('click', pinDesign);
  $('#pinClear').addEventListener('click', () => { state.pins = []; renderPins(); });
  $('#sheetBtn').addEventListener('click', layoutSheet);
  $('#pngBtn').addEventListener('click', () => exportPNG(1));
  $('#png2Btn').addEventListener('click', () => exportPNG(2));
  $('#svgBtn').addEventListener('click', exportSVG);
  $('#sendBtn').addEventListener('click', sendToPhoto);

  buildLibraryGrid();
  renderPresets();
  $('#presetSave').addEventListener('click', savePreset);
  $('#presetName').addEventListener('keydown', e => { if (e.key === 'Enter') savePreset(); });
  $('#presetExport').addEventListener('click', exportPresets);
  $('#presetImportBtn').addEventListener('click', () => $('#presetImportFile').click());
  $('#presetImportFile').addEventListener('change', e => importPresetsFile(e.target.files[0]));

  document.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.matches('input, textarea, select')) return;
    if (e.key === 'r' && state.mode !== 'image') $('#shuffle').click();
    if (e.key === 'p') pinDesign();
    if (e.key === 'e' && state.mode === 'image') setTool(state.tool === 'erase' ? 'off' : 'erase');
  });

  setMode('image');
}

boot();
