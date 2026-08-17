'use strict';
// Minimal canvas candlestick chart (no external deps). Renders OHLC candles
// with a volume pane, hover crosshair, and price axis.

window.KChart = (function () {
  function create(canvas) {
    const ctx = canvas.getContext('2d');
    let candles = [];
    let hover = null;

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function draw() {
      resize();
      const W = canvas.getBoundingClientRect().width;
      const H = canvas.getBoundingClientRect().height;
      ctx.clearRect(0, 0, W, H);
      if (!candles.length) {
        ctx.fillStyle = '#8a94a0'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('No price history yet', W / 2, H / 2);
        return;
      }
      const padR = 52, padT = 10, padB = 4;
      const volH = 46;
      const plotW = W - padR, plotH = H - padT - padB - volH - 8;

      let lo = Infinity, hi = -Infinity, vmax = 1;
      for (const c of candles) { lo = Math.min(lo, c.l); hi = Math.max(hi, c.h); vmax = Math.max(vmax, c.v); }
      const range = Math.max(hi - lo, 0.02);
      lo -= range * 0.08; hi += range * 0.08;

      const y = p => padT + (1 - (p - lo) / (hi - lo)) * plotH;
      const n = candles.length;
      const step = plotW / n;
      const bw = Math.max(1.5, Math.min(9, step * 0.62));
      const x = i => i * step + step / 2;

      // gridlines + price labels
      ctx.font = '10.5px sans-serif';
      ctx.textAlign = 'left';
      const gridN = 5;
      for (let g = 0; g <= gridN; g++) {
        const p = lo + (hi - lo) * (g / gridN);
        const yy = y(p);
        ctx.strokeStyle = '#eef1f5'; ctx.beginPath();
        ctx.moveTo(0, yy); ctx.lineTo(plotW, yy); ctx.stroke();
        ctx.fillStyle = '#8a94a0';
        ctx.fillText((p * 100).toFixed(1) + '¢', plotW + 6, yy + 3);
      }

      // candles
      for (let i = 0; i < n; i++) {
        const c = candles[i];
        const up = c.c >= c.o;
        const col = up ? '#0a9d6c' : '#e5484d';
        const xc = x(i);
        ctx.strokeStyle = col; ctx.fillStyle = col;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(xc, y(c.h)); ctx.lineTo(xc, y(c.l)); ctx.stroke();
        const top = y(Math.max(c.o, c.c));
        const hgt = Math.max(1, Math.abs(y(c.o) - y(c.c)));
        ctx.fillRect(xc - bw / 2, top, bw, hgt);
        // volume
        const vh = (c.v / vmax) * volH;
        ctx.globalAlpha = 0.35;
        ctx.fillRect(xc - bw / 2, H - padB - vh, bw, vh);
        ctx.globalAlpha = 1;
      }

      // last price line
      const last = candles[n - 1].c;
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = '#1f5eff'; ctx.beginPath();
      ctx.moveTo(0, y(last)); ctx.lineTo(plotW, y(last)); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#1f5eff';
      ctx.fillRect(plotW + 2, y(last) - 8, padR - 4, 16);
      ctx.fillStyle = '#fff';
      ctx.fillText((last * 100).toFixed(1) + '¢', plotW + 7, y(last) + 3.5);

      // hover crosshair
      if (hover !== null && hover >= 0 && hover < n) {
        const c = candles[hover];
        const xc = x(hover);
        ctx.strokeStyle = '#b8c0ca'; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(xc, padT); ctx.lineTo(xc, H - padB); ctx.stroke();
        ctx.setLineDash([]);
        const label = `${fmtTime(c.t_open)}  O ${(c.o*100).toFixed(1)}  H ${(c.h*100).toFixed(1)}  L ${(c.l*100).toFixed(1)}  C ${(c.c*100).toFixed(1)}  V ${Math.round(c.v)}`;
        ctx.font = '11px sans-serif';
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(16,20,24,.85)';
        const bx = Math.min(Math.max(xc - tw / 2 - 8, 4), W - tw - 22);
        ctx.fillRect(bx, 6, tw + 16, 20);
        ctx.fillStyle = '#fff'; ctx.textAlign = 'left';
        ctx.fillText(label, bx + 8, 20);
      }
      ctx.textAlign = 'left';
    }

    function fmtTime(ts) {
      const d = new Date(ts);
      const mo = d.toLocaleString('en-US', { month: 'short' });
      return `${mo} ${d.getDate()}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }

    canvas.addEventListener('mousemove', e => {
      const rect = canvas.getBoundingClientRect();
      const W = rect.width, padR = 52;
      const plotW = W - padR;
      const i = Math.floor((e.clientX - rect.left) / (plotW / candles.length));
      hover = i; draw();
    });
    canvas.addEventListener('mouseleave', () => { hover = null; draw(); });
    window.addEventListener('resize', () => draw());

    return {
      setData(rows) { candles = rows || []; hover = null; draw(); },
      updateLast(c) {
        if (!candles.length) { candles = [c]; draw(); return; }
        const lastC = candles[candles.length - 1];
        if (c.t_open === lastC.t_open) candles[candles.length - 1] = c;
        else { candles.push(c); if (candles.length > 600) candles.shift(); }
        draw();
      },
      redraw: draw,
    };
  }
  return { create };
})();
