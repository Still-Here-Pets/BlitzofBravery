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
      spread: odds ? (odds.details || null) : null,
      overUnder: odds ? (odds.overUnder || null) : null,
      records: (awayRecord || homeRecord) ? (away.team.displayName + ' ' + (awayRecord||'?') + ', ' + home.team.displayName + ' ' + (homeRecord||'?')) : null
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
        continue;
      }

      // Completed games: auto-grade any matching real game in the pool
      const winner = g.awayScore > g.homeScore ? 'away' : (g.homeScore > g.awayScore ? 'home' : null);
      const { data: matches, error } = await sb.from('games')
        .select('id')
        .eq('away', g.away).eq('home', g.home)
        .is('winner', null);
      if (error) { results.errors.push(error.message); continue; }
      if (matches && matches.length) {
        for (const m of matches) {
          await sb.from('games').update({
            winner, away_score: g.awayScore, home_score: g.homeScore
          }).eq('id', m.id);
          results.graded++;
        }
      }
    }

    res.status(200).json({ ok: true, ...results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, ...results });
  }
};
