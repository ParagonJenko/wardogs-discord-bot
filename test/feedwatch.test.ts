import { describe, expect, it } from 'vitest';
import { FEED_QUIET_MS, observeFeed, parseFeedWatch, type FeedWatch, type FeedWatchEvent } from '../src/feedwatch.ts';

const MINUTE = 60_000;
const LIVE = 20;

// Replays checks a minute apart. Each is the players the check found (null: it could not reach the server), and
// whether a kill feed batch came in the minute before it. Returns each event with the minute it came at, and the
// watch left at the end.
const replay = (
  checks: [players: number | null, batch: boolean][],
  heardAt: number | null = null,
): { events: [number, FeedWatchEvent][]; watch: FeedWatch } => {
  let watch = parseFeedWatch(undefined);
  let heard = heardAt;
  const events: [number, FeedWatchEvent][] = [];
  checks.forEach(([players, batch], minute) => {
    const at = minute * MINUTE;
    if (batch) heard = at - MINUTE / 2;
    const result = observeFeed(watch, { at, players, live: LIVE, heardAt: heard });
    watch = result.watch;
    if (result.event !== null) events.push([minute, result.event]);
  });
  return { events, watch };
};

const live = (minutes: number, batch: boolean, players = 99): [number, boolean][] =>
  Array.from({ length: minutes }, () => [players, batch] as [number, boolean]);

describe('the kill feed going quiet', () => {
  it('says nothing while kills arrive', () => {
    expect(replay(live(60, true)).events).toEqual([]);
  });

  it('posts once when a live server has sent no kills for 10 minutes, as after the Season 2 update', () => {
    const { events, watch } = replay([...live(5, true), ...live(30, false)]);

    expect(events.map(([minute, e]) => [minute, e.type])).toEqual([[14, 'quiet']]);
    expect(events[0]?.[1]).toEqual({ type: 'quiet', at: 14 * MINUTE, quietFrom: 4 * MINUTE - MINUTE / 2, heardAt: 4 * MINUTE - MINUTE / 2, players: 99 });
    expect(watch.toldAt).toBe(14 * MINUTE);
  });

  it('counts from when the server went live, for a feed it has never heard', () => {
    const { events } = replay([...live(3, false, 5), ...live(12, false)]);

    expect(events).toEqual([[13, { type: 'quiet', at: 13 * MINUTE, quietFrom: 3 * MINUTE, heardAt: null, players: 99 }]]);
  });

  it('never posts while the server seeds, when minutes without a kill are usual', () => {
    expect(replay(live(60, false, LIVE - 1)).events).toEqual([]);
  });

  it('starts again when the server stops being live before the 10 minutes are up', () => {
    expect(replay([...live(8, false), ...live(2, false, 3), ...live(8, false)]).events).toEqual([]);
  });

  it('is not fooled by a check that could not reach the server', () => {
    const { events } = replay([...live(5, false), [null, false], ...live(6, false)]);

    expect(events.map(([minute, e]) => [minute, e.type])).toEqual([[10, 'quiet']]);
  });

  it('lets a map change go by', () => {
    // Kills, then four quiet minutes at the end screen and the load, then kills again.
    expect(replay([...live(20, true), ...live(4, false), ...live(20, true)]).events).toEqual([]);
  });

  it('posts again when kills arrive, even with the server below live by then', () => {
    const { events, watch } = replay([...live(12, false), ...live(5, false, 10), [10, true], ...live(30, false)]);

    expect(events.map(([minute, e]) => [minute, e.type])).toEqual([
      [10, 'quiet'],
      [17, 'back'],
      // Live again from minute 18.
      [28, 'quiet'],
    ]);
    expect(events[1]?.[1]).toEqual({ type: 'back', at: 17 * MINUTE, quietFrom: 0, heardAt: 17 * MINUTE - MINUTE / 2 });
    expect(watch.toldAt).toBe(28 * MINUTE);
  });

  it('keeps the same watch while nothing changes, so a check writes nothing', () => {
    const watch: FeedWatch = { liveSince: 0, quietFrom: null, toldAt: null };
    expect(observeFeed(watch, { at: MINUTE, players: 99, live: LIVE, heardAt: MINUTE / 2 }).watch).toBe(watch);
    const told: FeedWatch = { liveSince: 0, quietFrom: 0, toldAt: FEED_QUIET_MS };
    expect(observeFeed(told, { at: FEED_QUIET_MS + MINUTE, players: 99, live: LIVE, heardAt: null }).watch).toBe(told);
    const idle = parseFeedWatch(undefined);
    expect(observeFeed(idle, { at: 0, players: 0, live: LIVE, heardAt: null }).watch).toBe(idle);
  });

  it('reads a saved watch, and starts afresh from anything else', () => {
    expect(parseFeedWatch({ liveSince: 1, quietFrom: 2, toldAt: 3 })).toEqual({ liveSince: 1, quietFrom: 2, toldAt: 3 });
    expect(parseFeedWatch({ liveSince: 'x' })).toEqual({ liveSince: null, quietFrom: null, toldAt: null });
  });
});
