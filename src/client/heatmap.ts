/**
 * Activity-heatmap math for the usage section: the host's sparse per-day
 * series turned into week columns, per-cell levels, and the window's summary
 * figures. Pure — no React, no DOM — so the grid is unit-testable without a
 * renderer, and it keys days through the same local-date helper the host's
 * ledger uses, so a cell always lands on the day the host recorded.
 * @module @linxin666/dsh-usage/client/heatmap
 */

import { localDateKey } from '../core/ledger.ts'
import type { UsageCalendarDay } from '../core/types.ts'

/** Days in one grid column, Monday through Sunday. */
export const HEATMAP_ROWS = 7

/**
 * Narrowest grid: half a year of columns. The ledger's default retention is
 * 180 days, so this shows the whole retained window at a comfortably large
 * cell size (the columns share the card's width).
 */
export const HEATMAP_MIN_WEEKS = 26

/** Widest grid: one year of columns, GitHub-style. */
export const HEATMAP_MAX_WEEKS = 53

/** One day in ms; only used to measure a distance, never to step a date (DST). */
const DAY_MS = 86_400_000

/** The per-day measure a grid is scaled and totaled by. */
export type HeatmapMetric = 'tokens' | 'calls' | 'cost'

/** One rendered day: the host's totals plus the level the metric scales it to. */
export interface HeatmapCell {
  /** Local-date key `YYYY-MM-DD`. */
  date: string
  tokens: number
  calls: number
  cost: number
  /** 0 = no usage, 1-4 = the day's quartile bucket for the selected metric. */
  level: number
  /** Whether the ledger recorded usage that day (the cell is a click target). */
  active: boolean
}

/** One week column, Monday first; `null` is a day after today. */
export type HeatmapColumn = Array<HeatmapCell | null>

/** One month label and the column it starts at. */
export interface HeatmapMonth {
  /** Column index the month's first rendered day sits in. */
  column: number
  /** Calendar month, 1-12; the section localizes the label. */
  month: number
}

/** The rendered grid plus its window summary. */
export interface HeatmapGrid {
  /** Week columns, oldest first, each holding {@link HEATMAP_ROWS} days. */
  columns: HeatmapColumn[]
  /** Month labels over the columns, in column order. */
  months: HeatmapMonth[]
  /** The window's first and last rendered local day. */
  from: string
  to: string
  /** Window totals of every measure, so the summary follows the metric switch. */
  totals: { tokens: number; calls: number; cost: number }
  /** Days inside the window that recorded usage. */
  activeDays: number
  /**
   * Consecutive active days ending today, or ending yesterday while today has
   * not recorded usage yet (an unfinished day does not break a streak).
   * Measured inside the window: a run older than the grid has no cell to
   * count in.
   */
  streak: number
  /** Longest consecutive active run inside the window. */
  longestStreak: number
}

/** The measure one day is scaled and totaled by. */
export function metricValue(day: Pick<UsageCalendarDay, 'tokens' | 'calls' | 'cost'>, metric: HeatmapMetric): number {
  return metric === 'tokens' ? day.tokens : metric === 'calls' ? day.calls : day.cost
}

/** Whether a day recorded usage at all — independent of the selected metric. */
export function isActiveDay(day: Pick<UsageCalendarDay, 'tokens' | 'calls'>): boolean {
  return day.calls > 0 || day.tokens > 0
}

/** Local midnight of a `YYYY-MM-DD` key, as epoch ms. */
function dayMs(dateKey: string): number {
  const [year, month, day] = dateKey.split('-').map(Number)
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1).getTime()
}

/**
 * The key `days` local days away from `dateKey`. Stepping through the Date's
 * own calendar (not by adding 24 h) is what keeps a window crossing a DST
 * boundary on its local days.
 */
export function shiftDay(dateKey: string, days: number): string {
  const at = new Date(dayMs(dateKey))
  at.setDate(at.getDate() + days)
  return localDateKey(at.getTime())
}

/** Monday-first row of a day (0 = Monday, 6 = Sunday). */
function rowOf(dateKey: string): number {
  return (new Date(dayMs(dateKey)).getDay() + 6) % 7
}

/**
 * How many week columns a window needs to show `from`..`today` inclusive,
 * clamped to the grid's own bounds: a ledger younger than the minimum renders
 * the minimum grid, one older than a year renders the widest. The count is the
 * smallest one whose first Monday is at or before `from` — the days left in
 * today's week never shift the window, they stay gaps.
 */
export function heatmapWeeks(from: string, today: string): number {
  const days = Math.max(0, Math.round((dayMs(today) - dayMs(from)) / DAY_MS))
  const weeks = Math.floor((days - rowOf(today) + 6) / HEATMAP_ROWS) + 1
  return Math.min(HEATMAP_MAX_WEEKS, Math.max(HEATMAP_MIN_WEEKS, weeks))
}

/** The oldest day a series holds at or before `today`, else `today` itself. */
function oldestOf(days: readonly UsageCalendarDay[], today: string): string {
  let oldest = today
  for (const day of days) {
    if (day.date < oldest) oldest = day.date
  }
  return oldest
}

/**
 * The level scale of one window: non-zero days bucketed by the 25/50/75%
 * quantiles of the window's non-zero metric values (rank-based, so the
 * heaviest day always reaches level 4). Quantiles rather than a linear share
 * of the peak keep one runaway day from washing the rest of the grid out, and
 * a window whose active days all carry the same value renders them all at the
 * top level instead of all at the palest.
 */
function levelScale(values: readonly number[]): (value: number) => number {
  const sorted = values.filter((value) => value > 0).sort((a, b) => a - b)
  if (sorted.length === 0) return () => 0
  const quantile = (p: number): number => sorted[Math.floor(p * (sorted.length - 1))] ?? 0
  const lower = quantile(0.25)
  const middle = quantile(0.5)
  const upper = quantile(0.75)
  const flat = lower === upper
  return (value: number): number => {
    if (value <= 0) return 0
    if (flat) return 4
    let level = 1
    for (const threshold of [lower, middle, upper]) {
      if (value > threshold) level += 1
    }
    return level
  }
}

/**
 * Build the contribution grid over `weeks` columns ending in today's week,
 * Monday first: the last column runs to Sunday, so the days left in this week
 * stay empty rather than shifting the grid. Days after today render as
 * `null`, and a day the series does not hold renders as a zero day, which is
 * what the host's sparse series means.
 */
export function buildHeatmap(
  days: readonly UsageCalendarDay[],
  today: string,
  metric: HeatmapMetric,
  weeks: number = heatmapWeeks(oldestOf(days, today), today),
): HeatmapGrid {
  const byDate = new Map<string, UsageCalendarDay>()
  for (const day of days) {
    // A day after today has no cell (a host clock ahead of the browser's).
    if (day.date <= today) byDate.set(day.date, day)
  }
  const span = Math.min(HEATMAP_MAX_WEEKS, Math.max(1, Math.floor(weeks)))
  const lastMonday = shiftDay(today, -rowOf(today))
  const firstMonday = shiftDay(lastMonday, -(span - 1) * HEATMAP_ROWS)
  const cursor = new Date(dayMs(firstMonday))

  const columns: HeatmapColumn[] = []
  const months: HeatmapMonth[] = []
  const totals = { tokens: 0, calls: 0, cost: 0 }
  const rendered: HeatmapCell[] = []
  for (let column = 0; column < span; column += 1) {
    const month = cursor.getMonth() + 1
    if (months.length === 0 || months[months.length - 1]?.month !== month) {
      months.push({ column, month })
    }
    const cells: HeatmapColumn = []
    for (let row = 0; row < HEATMAP_ROWS; row += 1) {
      const date = localDateKey(cursor.getTime())
      cursor.setDate(cursor.getDate() + 1)
      if (date > today) {
        cells.push(null)
        continue
      }
      const day = byDate.get(date)
      const cell: HeatmapCell = {
        date,
        tokens: day?.tokens ?? 0,
        calls: day?.calls ?? 0,
        cost: day?.cost ?? 0,
        level: 0,
        active: day !== undefined && isActiveDay(day),
      }
      totals.tokens += cell.tokens
      totals.calls += cell.calls
      totals.cost += cell.cost
      rendered.push(cell)
      cells.push(cell)
    }
    columns.push(cells)
  }
  // Levels are scaled over the rendered window alone, after the columns exist:
  // a series reaching past the window (a shorter grid asked for explicitly)
  // must not set the scale of the days that are actually on screen.
  const levelOf = levelScale(rendered.map((cell) => metricValue(cell, metric)))
  for (const cell of rendered) cell.level = levelOf(metricValue(cell, metric))

  const activeDates = rendered.filter((cell) => cell.active).map((cell) => cell.date)
  const activeSet = new Set(activeDates)
  let longestStreak = 0
  let run = 0
  for (let index = 0; index < activeDates.length; index += 1) {
    run = index > 0 && shiftDay(activeDates[index - 1] as string, 1) === activeDates[index] ? run + 1 : 1
    if (run > longestStreak) longestStreak = run
  }
  let streak = 0
  let streakCursor = activeSet.has(today) ? today : shiftDay(today, -1)
  while (activeSet.has(streakCursor)) {
    streak += 1
    streakCursor = shiftDay(streakCursor, -1)
  }

  return {
    columns,
    months,
    from: firstMonday,
    to: today,
    totals,
    activeDays: activeDates.length,
    streak,
    longestStreak,
  }
}
