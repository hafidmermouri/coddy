import { createMemo, createSignal, For, onMount, Show } from 'solid-js';
import type { UsageData, UsageToWebview } from '../shared/protocol';
import { send } from './vscode';

type Period = 'day' | 'week' | 'month';
interface Bar { label: string; value: number; title: string }

const PERIODS: { id: Period; label: string; count: number }[] = [
  { id: 'day', label: 'Day', count: 14 },
  { id: 'week', label: 'Week', count: 12 },
  { id: 'month', label: 'Month', count: 12 },
];

const fmt = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(Math.round(n)));
const usd = (n: number) => `$${n.toFixed(n >= 100 ? 0 : 2)}`;

/** Start of the day / Monday-based week / month containing t, in local time. */
function bucketStart(t: number, p: Period): Date {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  if (p === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  if (p === 'month') d.setDate(1);
  return d;
}

function step(d: Date, p: Period, by: number): Date {
  const n = new Date(d);
  if (p === 'day') n.setDate(n.getDate() + by);
  else if (p === 'week') n.setDate(n.getDate() + 7 * by);
  else n.setMonth(n.getMonth() + by);
  return n;
}

function costBars(costs: UsageData['costs'], p: Period, count: number): Bar[] {
  const sums = new Map<number, number>();
  for (const c of costs) {
    const k = bucketStart(c.t, p).getTime();
    sums.set(k, (sums.get(k) ?? 0) + c.cost);
  }
  const bars: Bar[] = [];
  let d = bucketStart(Date.now(), p);
  for (let i = 0; i < count; i++) {
    const value = sums.get(d.getTime()) ?? 0;
    const label = p === 'month' ? d.toLocaleDateString(undefined, { month: 'short' }) : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    bars.unshift({ label, value, title: `${p === 'week' ? 'Week of ' : ''}${d.toLocaleDateString(undefined, { dateStyle: 'medium' })}: ${usd(value)}` });
    d = step(d, p, -1);
  }
  return bars;
}

function BarChart(props: { bars: Bar[] }) {
  const max = () => Math.max(...props.bars.map((b) => b.value), 1e-9);
  return (
    <div class="chart">
      <div class="bars">
        <For each={props.bars}>
          {(b) => (
            <div class="bar-slot" title={b.title}>
              <div class="chart-bar" style={{ height: `${(b.value / max()) * 100}%` }} />
            </div>
          )}
        </For>
      </div>
      <div class="axis">
        <span>{props.bars[0]?.label}</span>
        <span>{props.bars.at(-1)?.label}</span>
      </div>
    </div>
  );
}

export function Usage() {
  const [data, setData] = createSignal<UsageData>();
  const [error, setError] = createSignal<string>();
  const [period, setPeriod] = createSignal<Period>('day');

  onMount(() => {
    window.addEventListener('message', (e: MessageEvent<UsageToWebview>) => {
      if (e.data?.type !== 'usage') return;
      setError(e.data.error);
      if (e.data.data) setData(e.data.data);
    });
    send({ type: 'refresh' });
  });

  const cost = createMemo(() => {
    const d = data();
    const cfg = PERIODS.find((x) => x.id === period())!;
    if (!d) return { bars: [] as Bar[], total: 0 };
    const bars = costBars(d.costs, period(), cfg.count);
    return { bars, total: bars.reduce((a, b) => a + b.value, 0) };
  });
  const avgContext = () => {
    const s = data()?.sessions ?? [];
    return s.length ? s.reduce((a, x) => a + x.context, 0) / s.length : 0;
  };

  return (
    <div class="usage-page">
      <div class="usage-head">
        <b>Usage</b>
        <span class="muted">this workspace</span>
        <span class="spacer" />
        <button class="icon" title="Refresh" onClick={() => send({ type: 'refresh' })}>↻</button>
      </div>
      <Show when={error()}><div class="banner error">{error()}</div></Show>
      <Show when={data()} fallback={<Show when={!error()}><div class="muted">Loading...</div></Show>}>
        {(d) => (
          <>
            <div class="stats">
              <div><span class="muted">In</span><b>{fmt(d().totals.input)}</b><span class="muted">+{fmt(d().totals.cached)} cached</span></div>
              <div><span class="muted">Out</span><b>{fmt(d().totals.output)}</b></div>
              <div><span class="muted">Cost</span><b>{usd(d().totals.cost)}</b><span class="muted">{d().totals.sessions} sessions</span></div>
            </div>

            <section>
              <div class="chart-head"><b>Context per session</b><span class="muted">avg {fmt(avgContext())}</span></div>
              <Show when={d().sessions.length} fallback={<div class="muted">No sessions yet.</div>}>
                <BarChart bars={d().sessions.map((s, i) => ({ label: `#${i + 1}`, value: s.context, title: `${s.title}: ${fmt(s.context)} tokens` }))} />
                <div class="muted note">Last {d().sessions.length} sessions, size at their last step.</div>
              </Show>
            </section>

            <section>
              <div class="chart-head">
                <b>Cost</b>
                <span class="muted">{usd(cost().total)}</span>
                <span class="spacer" />
                <div class="switch">
                  <For each={PERIODS}>
                    {(p) => <button classList={{ on: period() === p.id }} onClick={() => setPeriod(p.id)}>{p.label}</button>}
                  </For>
                </div>
              </div>
              <BarChart bars={cost().bars} />
              <div class="muted note">Each session's cost counts on the day it was created.</div>
            </section>
          </>
        )}
      </Show>
    </div>
  );
}
