// Pulls live scores, records, and spreads from ESPN's public scoreboard endpoints
// and syncs them into Supabase: upcoming/in-progress games go into schedule_cache
// (for the admin's game picker), and completed games update the real `games`
// table directly (winner + score), auto-grading weeks as results come in.
//
// Triggered by a GitHub Actions schedule (see .github/workflows/sync-schedule.yml)
// hitting this URL with an Authorization: Bearer <CRON_SECRET> header.

const { createClient } = require('@supabase/supabase-js');

const ESPN_NFL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const ESPN_CFB = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?groups=80&limit=300';

function parseEvents(json, league) {
  const events = json.events || [];
  return events.map(ev => {
    const comp = ev.competitions && ev.competitions[0];
    if (!comp) return null;
    const away = comp.competitors.find(c => c.homeAway === 'away');
    const home = comp.competitors.find(c => c.homeAway === 'home');
    if (!away || !home) return null;
    const odds = comp.odds && comp.odds[0];
    const awayRecord = (away.records && away.records[0] && away.records[0].summary) || null;
    const homeRecord = (home.records && home.records[0] && home.records[0].summary) || null;
    return {
      league,
      away: away.team.displayName,
      home: home.team.displayName,
      awayScore: away.score != null ? parseInt(away.score, 10) : null,
      homeScore: home.score != null ? parseInt(home.score, 10) : null,
      kickoff: comp.date,
      completed: !!(comp.status && comp.status.type && comp.status.type.completed),
      started: !!(comp.status && comp.status.type && comp.status.type.state !== 'pre'),
      spread: odds ? (odds.details || null) : null,
      overUnder: odds ? (odds.overUnder || null) : null,
      records: (awayRecord || homeRecord) ? (away.team.displayName + ' ' + (awayRecord||'?') + ', ' + home.team.displayName + ' ' + (homeRecord||'?')) : null,
      liveDetail: (comp.status && comp.status.type && comp.status.type.shortDetail) || null
    };
  }).filter(Boolean);
}

module.exports = async (req, res) => {
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const results = { nfl: 0, cfb: 0, graded: 0, errors: [] };

  try {
    const [nflRes, cfbRes] = await Promise.all([
      fetch(ESPN_NFL).then(r => r.json()),
      fetch(ESPN_CFB).then(r => r.json())
    ]);

    const games = [
      ...parseEvents(nflRes, 'NFL'),
      ...parseEvents(cfbRes, 'College')
    ];

    for (const g of games) {
      const spreadText = [g.spread, g.overUnder ? ('O/U ' + g.overUnder) : null].filter(Boolean).join(' · ') || null;

      // Upcoming/in-progress games: keep the schedule_cache fresh for the admin picker
      if (!g.completed) {
        await sb.from('schedule_cache')
          .delete()
          .eq('league', g.league).eq('away', g.away).eq('home', g.home);
        await sb.from('schedule_cache').insert({
          league: g.league, away: g.away, home: g.home, kickoff: g.kickoff,
          spread: spreadText, records: g.records, week_label: 'Live sync'
        });
        if (g.league === 'NFL') results.nfl++; else results.cfb++;
        // fall through — still push current score into the real games table below
      }

      // Live or completed: push current scores into any matching real game in the pool.
      // Winner is only set once the game is actually final, so grading stays accurate,
      // but the score numbers update live for the Picks screen throughout the game.
      const winner = g.completed ? (g.awayScore > g.homeScore ? 'away' : (g.homeScore > g.awayScore ? 'home' : 'tie')) : null;
      const { data: rawMatches, error } = await sb.from('games')
        .select('id, winner, kickoff')
        .eq('away', g.away).eq('home', g.home);
      if (error) { results.errors.push(error.message); continue; }
      // Two teams can play twice in a season (divisional rematches), so matching
      // on names alone risks bleeding one week's live score into another week's
      // row. Require the stored kickoff to actually be close to this event's.
      const gKick = g.kickoff ? new Date(g.kickoff).getTime() : null;
      const matches = (rawMatches || []).filter(m => {
        if (!gKick || !m.kickoff) return true; // no timestamp to compare, fall back to name match
        return Math.abs(new Date(m.kickoff).getTime() - gKick) < 36 * 3600 * 1000;
      });
      if (matches.length && g.started) {
        for (const m of matches) {
          if (m.winner) continue; // already graded, don't touch
          const update = { away_score: g.awayScore, home_score: g.homeScore, live_status: winner ? null : g.liveDetail };
          if (winner) update.winner = winner;
          await sb.from('games').update(update).eq('id', m.id);
          if (winner) results.graded++;
        }
      }
    }

    // Insurance: for any locked week where a registered player never submitted picks,
    // auto-fill using the current leader's exact team picks with confidence values
    // reversed (leader's 10 becomes 1, etc.). Idempotent — only inserts where no
    // pick row exists yet, so safe to run on every sync.
    const insuranceResults = await applyInsurance(sb);
    results.insuranceApplied = insuranceResults.length;
    if (insuranceResults.length) results.insuranceFor = insuranceResults;

    res.status(200).json({ ok: true, ...results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, ...results });
  }
};

async function applyInsurance(sb) {
  const applied = [];
  const { data: weeks } = await sb.from('weeks').select('*');
  const { data: profiles } = await sb.from('profiles').select('id, display_name');
  const { data: allGames } = await sb.from('games').select('*');
  const { data: allPicks } = await sb.from('picks').select('*');
  if (!weeks || !profiles || !allGames || !allPicks) return applied;

  const gamesByWeek = {};
  allGames.forEach(g => { (gamesByWeek[g.week_number] ||= []).push(g); });
  const picksByWeekPlayer = {};
  allPicks.forEach(p => { picksByWeekPlayer[p.week_number + '__' + p.player_id] = p; });

  function isLocked(w) {
    if (w.locked) return true;
    const games = gamesByWeek[w.week_number] || [];
    const kicks = games.map(g => g.kickoff).filter(Boolean).map(k => new Date(k).getTime());
    if (!kicks.length) return false;
    return Date.now() >= Math.min(...kicks);
  }
  function weeklyScoreFor(weekNum, playerId) {
    const games = gamesByWeek[weekNum] || [];
    const p = picksByWeekPlayer[weekNum + '__' + playerId];
    if (!p) return 0;
    let score = 0;
    for (const g of games) {
      if (g.is_tiebreaker) continue;
      const pick = (p.game_picks || {})[g.id];
      if (!pick || !g.winner || g.winner === 'tie') continue;
      if (pick.winner === g.winner) score += pick.value;
    }
    return score;
  }

  for (const w of weeks) {
    if (!isLocked(w)) continue;
    const games = gamesByWeek[w.week_number] || [];
    if (!games.length) continue;

    const missing = profiles.filter(pr => !picksByWeekPlayer[w.week_number + '__' + pr.id]);
    if (!missing.length) continue;

    // Leader = highest season total using weeks strictly before this one
    const priorWeeks = weeks.filter(ww => ww.week_number < w.week_number);
    let leaderId = null, leaderTotal = -1;
    for (const pr of profiles) {
      const total = priorWeeks.reduce((sum, ww) => sum + weeklyScoreFor(ww.week_number, pr.id), 0);
      if (total > leaderTotal) { leaderTotal = total; leaderId = pr.id; }
    }
    if (!leaderId) continue;
    const leaderPick = picksByWeekPlayer[w.week_number + '__' + leaderId];
    if (!leaderPick || leaderPick.is_hammer) continue; // can't mirror a hammer week sensibly

    const reversedGamePicks = {};
    for (const [gid, pick] of Object.entries(leaderPick.game_picks || {})) {
      reversedGamePicks[gid] = { winner: pick.winner, value: pick.value != null ? (11 - pick.value) : null };
    }

    for (const pr of missing) {
      await sb.from('picks').insert({
        week_number: w.week_number, player_id: pr.id, display_name: pr.display_name,
        game_picks: reversedGamePicks, omit_game_id: leaderPick.omit_game_id,
        tiebreaker: leaderPick.tiebreaker, submitted_at: new Date().toISOString(),
        is_hammer: false, is_insurance: true
      });
      applied.push(pr.display_name + ' (week ' + w.week_number + ')');
    }
  }
  return applied;
}
