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

  const width = 980;
  const height = 320;
  const padding = { top: 34, right: 34, bottom: 46, left: 58 };
  const values = series.map((item) => Number(item.revenue || 0));
  const max = Math.max(1, ...values);
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const step = innerWidth / Math.max(1, series.length - 1);
  const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

  const pointFor = (item, index) => {
    const x = padding.left + index * step;
    const y = padding.top + innerHeight - (Number(item.revenue || 0) / max) * innerHeight;
    return { x, y };
  };

  const pointObjects = series.map(pointFor);
  const points = pointObjects.map((point) => `${point.x},${point.y}`).join(' ');
  const areaPoints = `${padding.left},${height - padding.bottom} ${points} ${width - padding.right},${height - padding.bottom}`;
  const grid = Array.from({ length: 5 }, (_, index) => {
    const ratio = index / 4;
    const y = padding.top + innerHeight * ratio;
    const value = max * (1 - ratio);
    return `<line class="chart-grid" x1="${padding.left}" x2="${width - padding.right}" y1="${y}" y2="${y}"/><text x="${padding.left - 12}" y="${y + 4}" text-anchor="end">${money.format(value).replace(/,00$/, '')}</text>`;
  }).join('');
  const labels = series.map((item, index) => {
    const { x } = pointObjects[index];
    const day = new Date(`${String(item.day).slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    return `<text x="${x}" y="${height - 14}" text-anchor="middle">${day}</text>`;
  }).join('');
  const dots = pointObjects.map((point) => `<circle class="chart-point" cx="${point.x}" cy="${point.y}" r="4"/>`).join('');
  const last = series[series.length - 1];
  const lastPoint = pointObjects[pointObjects.length - 1];
  const tooltipX = Math.min(width - 230, Math.max(padding.left, lastPoint.x - 168));
  const tooltipY = Math.max(18, lastPoint.y - 74);
  const tooltip = `<g><rect class="chart-tooltip" x="${tooltipX}" y="${tooltipY}" width="196" height="54" rx="12"/><text class="chart-tooltip-text" x="${tooltipX + 14}" y="${tooltipY + 22}">Último dia</text><text class="chart-tooltip-text" x="${tooltipX + 14}" y="${tooltipY + 40}">${money.format(Number(last.revenue || 0))} · ${Number(last.sales || 0)} venda(s)</text></g>`;

  root.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Faturamento diário">
    <defs>
      <linearGradient id="chart-area-gradient" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#ff4d00" stop-opacity="0.42"/>
        <stop offset="52%" stop-color="#ff8500" stop-opacity="0.16"/>
        <stop offset="100%" stop-color="#050505" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${grid}
    <line class="chart-axis" x1="${padding.left}" x2="${width - padding.right}" y1="${height - padding.bottom}" y2="${height - padding.bottom}"/>
    <polygon class="chart-area" fill="url(#chart-area-gradient)" points="${areaPoints}"/>
    <polyline class="chart-line" points="${points}"/>
    ${dots}
    ${tooltip}
    ${labels}
  </svg>`;
});
