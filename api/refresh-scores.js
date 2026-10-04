// Lightweight companion to sync-schedule.js, meant to be called straight from the
// browser whenever the app loads or is refreshed, so scores feel live instead of
// waiting for the next 15-minute cron run. No secret required — it only reads
// public ESPN data and writes scores, nothing a player couldn't already see.
// It skips the schedule_cache refresh and the insurance auto-fill (those stay on
// the cron job) so this stays fast enough to run on every page load.

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
    return {
      league,
      away: away.team.displayName,
      home: home.team.displayName,
      awayScore: away.score != null ? parseInt(away.score, 10) : null,
      homeScore: home.score != null ? parseInt(home.score, 10) : null,
      completed: !!(comp.status && comp.status.type && comp.status.type.completed),
      started: !!(comp.status && comp.status.type && comp.status.type.state !== 'pre')
    };
  }).filter(Boolean);
}

module.exports = async (req, res) => {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const results = { graded: 0, updated: 0, errors: [] };

  try {
    const [nflRes, cfbRes] = await Promise.all([
      fetch(ESPN_NFL).then(r => r.json()),
      fetch(ESPN_CFB).then(r => r.json())
    ]);
    const games = [...parseEvents(nflRes, 'NFL'), ...parseEvents(cfbRes, 'College')];

    for (const g of games) {
      if (!g.started) continue; // nothing to update until kickoff
      const winner = g.completed ? (g.awayScore > g.homeScore ? 'away' : (g.homeScore > g.awayScore ? 'home' : 'tie')) : null;
      const { data: matches, error } = await sb.from('games')
        .select('id, winner').eq('away', g.away).eq('home', g.home);
      if (error) { results.errors.push(error.message); continue; }
      for (const m of (matches || [])) {
        if (m.winner) continue; // already graded, don't touch
        const update = { away_score: g.awayScore, home_score: g.homeScore };
        if (winner) update.winner = winner;
        await sb.from('games').update(update).eq('id', m.id);
        results.updated++;
        if (winner) results.graded++;
      }
    }
    res.status(200).json({ ok: true, ...results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, ...results });
  }
};
