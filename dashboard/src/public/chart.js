'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const root = document.querySelector('#sales-chart');
  if (!root) return;
  let series = [];
  try { series = JSON.parse(root.dataset.series || '[]'); } catch { series = []; }
  if (!series.length) {
    root.innerHTML = '<p class="empty">As vendas confirmadas aparecerão aqui.</p>';
    return;
  }
  const width = 760;
  const height = 220;
  const padding = 34;
  const max = Math.max(1, ...series.map((item) => Number(item.revenue)));
  const step = (width - padding * 2) / Math.max(1, series.length - 1);
  const points = series.map((item, index) => {
    const x = padding + index * step;
    const y = height - padding - (Number(item.revenue) / max) * (height - padding * 2);
    return `${x},${y}`;
  }).join(' ');
  const labels = series.map((item, index) => {
    const x = padding + index * step;
    const day = new Date(`${String(item.day).slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    return `<text x="${x}" y="210" text-anchor="middle">${day}</text>`;
  }).join('');
  root.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Faturamento diário"><polyline class="chart-area" points="${padding},${height-padding} ${points} ${width-padding},${height-padding}"/><polyline class="chart-line" points="${points}"/>${labels}</svg>`;
});
