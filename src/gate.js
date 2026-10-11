// 进站提示：点了按钮才进入页面，同时放一声欢呼、撒一阵彩纸。

import { $ } from './ui.js';

const COLORS = ['#e8590c', '#ff9a3d', '#f2c94c', '#e87ba4', '#2a78d6', '#4a3aa7', '#008300'];
const DURATION = 3.8; // 秒

/** 从屏幕下方两个角各喷出一把彩纸，中间夹几块冰。 */
function celebrate() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = $('confetti');
  const width = innerWidth;
  const height = innerHeight;
  const dpr = devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.hidden = false;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);

  const power = Math.sqrt(height / 800);
  const pieces = Array.from({ length: 170 }, (_, i) => {
    const fromLeft = i % 2 === 0;
    const angle = (fromLeft ? -Math.PI / 3 : (-2 * Math.PI) / 3) + (Math.random() - 0.5) * 1.0;
    const speed = (10 + Math.random() * 14) * power;
    return {
      x: fromLeft ? -10 : width + 10,
      y: height * 0.9,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: 6 + Math.random() * 7,
      color: COLORS[i % COLORS.length],
      turn: Math.random() * 6.28,
      spin: (Math.random() - 0.5) * 0.4,
      ice: i % 11 === 0,
    };
  });

  const started = performance.now();
  let last = started;
  const frame = now => {
    const t = (now - started) / 1000;
    const step = Math.min(3, (now - last) / 16.7); // 按 60 帧折算，掉帧时也不会变慢
    last = now;
    g.clearRect(0, 0, width, height);
    g.globalAlpha = Math.max(0, Math.min(1, (DURATION - t) / 1.2));
    for (const p of pieces) {
      p.vy += 0.34 * step;
      p.vx *= 0.99 ** step;
      p.x += p.vx * step;
      p.y += p.vy * step;
      p.turn += p.spin * step;
      g.save();
      g.translate(p.x, p.y);
      g.rotate(p.turn);
      if (p.ice) {
        g.font = `${p.size * 2.6}px serif`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText('🧊', 0, 0);
      } else {
        g.fillStyle = p.color;
        g.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      }
      g.restore();
    }
    if (t < DURATION) requestAnimationFrame(frame);
    else canvas.hidden = true;
  };
  requestAnimationFrame(frame);
}

function enter() {
  // 声音要在点击的当下开始放，浏览器才允许
  new Audio('yay.mp3').play().catch(() => {});
  celebrate();
  $('top').inert = false;
  $('gate').classList.add('leaving');
  setTimeout(() => ($('gate').hidden = true), 450);
}

for (const button of $('gate').querySelectorAll('button')) button.addEventListener('click', enter, { once: true });
$('gate-ok').focus();
