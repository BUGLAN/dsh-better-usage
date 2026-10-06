import { describe, expect, it } from 'vitest'
import {
  buildHeatmap, HEATMAP_MAX_WEEKS, HEATMAP_MIN_WEEKS, HEATMAP_ROWS, heatmapWeeks, isActiveDay, metricValue, shiftDay,
} from '../src/client/heatmap.ts'
import type { UsageCalendarDay } from '../src/core/types.ts'

/**
 * The activity heatmap's grid math: whole Monday-first weeks ending in today's
 * week, a window that follows the ledger up to a year, quartile levels that
 * survive one runaway day, and streak figures that read an unfinished today
 * the way a contribution graph does.
 */

/** 2026-08-05 is a Wednesday; every fixture hangs off it so weekdays are exact. */
const TODAY = '2026-08-05'

const day = (date: string, tokens: number, calls = 1, cost = 0): UsageCalendarDay => ({ date, tokens, calls, cost })

/** The cell a given date renders as, whichever column it landed in. */
function cellAt(days: readonly UsageCalendarDay[], today: string, date: string, metric: 'tokens' | 'calls' | 'cost' = 'tokens') {
  const grid = buildHeatmap(days, today, metric)
  for (const column of grid.columns) {
    for (const cell of column) {
      if (cell !== null && cell.date === date) return cell
    }
  }
  throw new Error('no cell for ' + date)
}

describe('buildHeatmap grid', () => {
  it('user sees whole Monday-first weeks ending in today\'s week, with the days left in the week empty', () => {
    // Given a ledger whose oldest day is younger than the minimum window
    const grid = buildHeatmap([day('2026-08-04', 100), day(TODAY, 50)], TODAY, 'tokens')
    // When the grid is built
    // Then the window is the minimum number of whole weeks back to a Monday
    expect(grid.columns).toHaveLength(HEATMAP_MIN_WEEKS)
    expect(grid.from).toBe('2026-02-09')
    expect(new Date(grid.from + 'T12:00:00').getDay()).toBe(1)
    expect(grid.to).toBe(TODAY)
    // And every column runs Monday through Sunday
    for (const column of grid.columns) {
      expect(column).toHaveLength(HEATMAP_ROWS)
      expect(new Date((column[0]?.date ?? '') + 'T12:00:00').getDay()).toBe(1)
    }
    // And the last column holds only the days up to today: the rest is a gap,
    // not a shifted row
    expect(grid.columns[grid.columns.length - 1]?.map((cell) => cell?.date ?? null)).toEqual([
      '2026-08-03', '2026-08-04', '2026-08-05', null, null, null, null,
    ])
    // And the first week of the window is fully rendered
    expect(grid.columns[0]?.[6]?.date).toBe('2026-02-15')
  })

  it('user sees the window follow the oldest retained day up to a year of columns', () => {
    // Given a ledger past the minimum window, 200 days deep
    const oldest = shiftDay(TODAY, -200)
    // When the grid is built
    const grid = buildHeatmap([day(oldest, 10), day(TODAY, 10)], TODAY, 'tokens')
    // Then the window reaches back over those days in whole weeks
    expect(grid.columns).toHaveLength(heatmapWeeks(oldest, TODAY))
    expect(grid.columns.length).toBe(30)
    expect(grid.from <= oldest).toBe(true)
    // And the window is minimal: one column fewer would start after the oldest day
    expect(shiftDay(grid.from, HEATMAP_ROWS) > oldest).toBe(true)
    expect(shiftDay(grid.from, 7 * (grid.columns.length - 1))).toBe('2026-08-03')
  })

  it('caps the window at a year even when retention reaches further back', () => {
    // Given a ledger whose oldest day is far outside a year, and a recent day
    const grid = buildHeatmap([day(shiftDay(TODAY, -900), 999), day(shiftDay(TODAY, -1), 5)], TODAY, 'tokens')
    // When the grid is built
    // Then the grid is a year wide and the days outside it are neither counted
    // nor rendered
    expect(grid.columns).toHaveLength(HEATMAP_MAX_WEEKS)
    expect(grid.activeDays).toBe(1)
    expect(grid.totals.tokens).toBe(5)
    // And the out-of-window day never sets the scale of the days on screen
    expect(cellAt([day(shiftDay(TODAY, -900), 999), day(shiftDay(TODAY, -1), 5)], TODAY, shiftDay(TODAY, -1)).level).toBe(4)
  })

  it('drops a day after today instead of rendering it', () => {
    // Given a series carrying a day ahead of the browser's today
    const grid = buildHeatmap([day(shiftDay(TODAY, 1), 999), day(TODAY, 5)], TODAY, 'tokens')
    // Then that day is not in the window at all
    expect(grid.totals.tokens).toBe(5)
    expect(grid.activeDays).toBe(1)
  })
})

describe('buildHeatmap levels', () => {
  it('user gets quartile levels, so one runaway day cannot wash the grid out', () => {
    // Given five active days whose heaviest is a hundred times the rest
    const days = [1, 2, 3, 4, 100].map((tokens, index) => day(shiftDay(TODAY, -index), tokens))
    // When the grid is built
    const levels = days.map((row) => cellAt(days, TODAY, row.date).level)
    // Then the levels follow the window's own quartiles, heaviest at the top
    expect(levels).toEqual([1, 1, 2, 3, 4])
  })

  it('renders a window whose active days all carry the same value at the top level', () => {
    // Given two active days with identical totals and a fresh ledger
    const days = [day(shiftDay(TODAY, -2), 500), day(shiftDay(TODAY, -1), 500)]
    // When the grid is built
    const levels = days.map((row) => cellAt(days, TODAY, row.date).level)
    // Then a flat window still reads as usage rather than as the palest level
    expect(levels).toEqual([4, 4])
  })

  it('keeps a day without usage out of the scale and off the levels', () => {
    // Given a day with calls but no tokens and a day with neither
    const days = [day('2026-08-04', 0, 3), day('2026-08-03', 0, 0)]
    // When the grid is built on the token measure
    // Then the call-only day is active but unscaled, and the empty day is level 0
    expect(cellAt(days, TODAY, '2026-08-04').level).toBe(0)
    expect(cellAt(days, TODAY, '2026-08-04').active).toBe(true)
    expect(cellAt(days, TODAY, '2026-08-03').active).toBe(false)
  })

  it('scales each measure on its own, so the spend view ignores an unpriced heavy day', () => {
    // Given a huge unpriced day and a small priced one
    const days = [day('2026-08-04', 5_000_000, 10, 0), day('2026-08-03', 100, 1, 4.2)]
    // When the grid is scaled by spend
    // Then the unpriced day carries no level while the priced one tops the scale
    expect(cellAt(days, TODAY, '2026-08-04', 'cost').level).toBe(0)
    expect(cellAt(days, TODAY, '2026-08-03', 'cost').level).toBe(4)
    // And the spend summary totals only what was priced
    expect(buildHeatmap(days, TODAY, 'cost').totals).toEqual({ tokens: 5_000_100, calls: 11, cost: 4.2 })
  })
})

describe('buildHeatmap streaks', () => {
  it('counts the run ending today and the longest run in the window', () => {
    // Given a six-day run two weeks back and a two-day run ending today
    const days = ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24', '2026-07-25', '2026-08-04', TODAY]
      .map((date) => day(date, 10))
    // When the grid is built
    const grid = buildHeatmap(days, TODAY, 'tokens')
    // Then the current streak is the run in progress and the longest is the older one
    expect(grid.streak).toBe(2)
    expect(grid.longestStreak).toBe(6)
    expect(grid.activeDays).toBe(8)
  })

  it('does not break the streak on a today that has not recorded usage yet', () => {
    // Given four consecutive active days ending yesterday
    const days = ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04'].map((date) => day(date, 10))
    // When the grid is built while today is still empty
    expect(buildHeatmap(days, TODAY, 'tokens').streak).toBe(4)
    // And a gap before that run is still a gap
    expect(buildHeatmap([day('2026-08-04', 10), day(TODAY, 10)], TODAY, 'tokens').longestStreak).toBe(2)
  })
})

describe('heatmap helpers', () => {
  it('steps days through the local calendar and stays inside the grid bounds', () => {
    expect(shiftDay('2026-08-05', -5)).toBe('2026-07-31')
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28')
    expect(heatmapWeeks(TODAY, TODAY)).toBe(HEATMAP_MIN_WEEKS)
    expect(heatmapWeeks(shiftDay(TODAY, -4000), TODAY)).toBe(HEATMAP_MAX_WEEKS)
  })

  it('reads one day\'s measures and activity', () => {
    expect(metricValue(day('2026-08-05', 10, 3, 1.5), 'tokens')).toBe(10)
    expect(metricValue(day('2026-08-05', 10, 3, 1.5), 'calls')).toBe(3)
    expect(metricValue(day('2026-08-05', 10, 3, 1.5), 'cost')).toBe(1.5)
    expect(isActiveDay(day('2026-08-05', 0, 1))).toBe(true)
    expect(isActiveDay(day('2026-08-05', 7, 0))).toBe(true)
    expect(isActiveDay(day('2026-08-05', 0, 0))).toBe(false)
  })
})
