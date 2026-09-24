// SYNTHETIC test records. These are NOT claims about real NBA players or games.
export const GAME_ID = '401999101';
export const OFFICIAL_ID = '0029900101';
export const START = '2026-10-03T23:00:00Z';
export const liveScoreboard = (phase = 'in') => ({ events: [
  { id: GAME_ID, date: START,
    status: { type: { state: phase, shortDetail: phase === 'in' ? '7:15 - 2nd' : phase === 'pre' ? '7:00 PM ET' : 'Final' }, period: 2, displayClock: '7:15' },
    competitions: [{ competitors: [
      { homeAway: 'away', score: '45', team: { id: '1', abbreviation: 'ATL', displayName: 'Atlanta Hawks', logo: 'https://a.espncdn.com/i/teamlogos/nba/500/atl.png' } },
      { homeAway: 'home', score: '48', team: { id: '2', abbreviation: 'BOS', displayName: 'Boston Celtics', logo: 'https://a.espncdn.com/i/teamlogos/nba/500/bos.png' } }
    ] }] }
] });
export const summary = () => ({ header: { id: GAME_ID },
  boxscore: { players: [
    { team: { id: '1' }, statistics: [{ keys: ['minutes','points'], athletes: [
      { athlete: { id: '1234567', displayName: 'Test Player' }, stats: ['12','8'], didNotPlay: false },
      { athlete: { id: '7654321', displayName: 'Bench Player' }, stats: [], didNotPlay: true }
    ] }] },
    { team: { id: '2' }, statistics: [{ keys: ['minutes'], athletes: [
      { athlete: { id: '5555555', displayName: 'Other Player' }, stats: ['0:01'], didNotPlay: false }
    ] }] }
  ] },
  plays: [
    { id: `${GAME_ID}20`, wallclock: '2026-10-03T23:04:00Z', type: { text: 'Jump Shot' }, team: { id: '1' }, participants: [{ athlete: { id: '1234567' } }], text: 'Test Player makes 2-foot layup', period: { number: 1 }, clock: { displayValue: '11:00' }, awayScore: 2, homeScore: 0 },
    { id: `${GAME_ID}21`, wallclock: '2026-10-03T23:05:00Z', type: { text: 'Timeout' }, team: { id: '1' }, participants: [{ athlete: { id: '7654321' } }], text: 'ATL timeout', period: { number: 1 }, clock: { displayValue: '10:30' }, awayScore: 2, homeScore: 0 }
  ]
});
export const injury = ({ id = '1234567', team = '1', status = 'Questionable', date = '2026-10-03T23:10:00Z', text = 'Test Player is questionable to return due to a left ankle sprain.' } = {}) => ({
  injuries: [{ id: team, injuries: [{ status, date, shortComment: text, athlete: { id, displayName: id === '1234567' ? 'Test Player' : 'Bench Player', team: { id: team }, links: [] } }] }]
});
export const news = ({ headline = 'Test Player will not return after ankle injury', date = '2026-10-03T23:15:00Z', athlete = '1234567', description = 'Test Player will not return to the game after an ankle sprain.' } = {}) => ({
  articles: [{ id: 11110000, published: date, headline, description, byline: 'Example reporter',
    links: { web: { href: 'https://www.espn.com/nba/story/_/id/11110000/example' } },
    categories: [{ type: 'athlete', athleteId: athlete, description: athlete === '1234567' ? 'Test Player' : 'Bench Player' }] }]
});
export const nbaScoreboard = () => ({ scoreboard: { games: [
  { gameId: OFFICIAL_ID, gameTimeUTC: START, awayTeam: { teamTricode: 'ATL' }, homeTeam: { teamTricode: 'BOS' } }
] } });
export const nbaPbp = () => ({ game: { gameId: OFFICIAL_ID, actions: [
  { actionNumber: 47, timeActual: '2026-10-03T23:07:05Z', actionType: 'timeout', period: 1, clock: 'PT10M00S', description: "Coach's Challenge (BOS): foul called under review", scoreAway: '2', scoreHome: '0' },
  { actionNumber: 48, timeActual: '2026-10-03T23:08:30Z', actionType: 'instant replay', period: 1, clock: 'PT10M00S', description: 'Replay Review: call overturned', scoreAway: '2', scoreHome: '0' }
] } });
