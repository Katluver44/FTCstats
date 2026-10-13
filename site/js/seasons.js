// Per-season game config: how to read FTCScout's season-specific score objects
// into a common shape { auto, teleop, endgame, np, rp: [bool, bool, bool] }.

export const SEASONS = {
  2024: {
    game: "INTO THE DEEP",
    scoreType: "MatchScores2024",
    statsType: "TeamEventStats2024",
    fields: "autoPoints dcPoints dcParkPoints totalPointsNp totalPoints",
    rpNames: [], // no bonus ranking points this season
    winRp: 2, // verified against official ranking scores in scripts/check-rs.mjs
    tieRp: 1,
    read: (a) => ({
      auto: a.autoPoints,
      teleop: a.dcPoints - a.dcParkPoints,
      endgame: a.dcParkPoints,
      np: a.totalPointsNp,
      total: a.totalPoints,
      rp: [false, false, false],
    }),
  },
  2025: {
    game: "DECODE",
    scoreType: "MatchScores2025",
    statsType: "TeamEventStats2025",
    fields: "autoPoints dcPoints dcBasePoints totalPointsNp totalPoints movementRp goalRp patternRp",
    rpNames: ["Movement", "Goal", "Pattern"],
    winRp: 3,
    tieRp: 1,
    read: (a) => ({
      auto: a.autoPoints,
      teleop: a.dcPoints - a.dcBasePoints,
      endgame: a.dcBasePoints,
      np: a.totalPointsNp,
      total: a.totalPoints, // decides the winner
      rp: [a.movementRp, a.goalRp, a.patternRp],
    }),
  },
  2026: {
    game: "2026-27",
    scoreType: "MatchScores2026",
    statsType: "TeamEventStats2026",
    fields: "autoPoints dcPoints dcParkPoints totalPointsNp totalPoints swarmRp pollinator1Rp pollinator2Rp",
    rpNames: ["Swarm", "Pollinator 1", "Pollinator 2"],
    winRp: 3, // verified against official ranking scores from early 2026 events
    tieRp: 1,
    read: (a) => ({
      auto: a.autoPoints,
      teleop: a.dcPoints - a.dcParkPoints,
      endgame: a.dcParkPoints,
      np: a.totalPointsNp,
      total: a.totalPoints,
      rp: [a.swarmRp, a.pollinator1Rp, a.pollinator2Rp],
    }),
  },
};

// Full event query: matches with scores, rosters, and official rankings.
export function eventQuery(season) {
  const s = SEASONS[season];
  return `query($season: Int!, $code: String!) {
    eventByCode(season: $season, code: $code) {
      code name type start end timezone remote finished ongoing
      location { city state country }
      matches {
        id tournamentLevel series matchNum description
        actualStartTime scheduledStartTime hasBeenPlayed
        scores { ... on ${s.scoreType} { red { ${s.fields} } blue { ${s.fields} } } }
        teams { teamNumber alliance station onField noShow surrogate dq }
      }
      teams {
        teamNumber
        team { name rookieYear location { city state country } }
        stats { ... on ${s.statsType} { rank rp wins losses ties qualMatchesPlayed } }
      }
    }
  }`;
}

export const API = "https://api.ftcscout.org/graphql";
