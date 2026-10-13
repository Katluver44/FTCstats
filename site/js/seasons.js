// Per-season game config: how to read FTCScout's season-specific score objects
// into a common shape { auto, teleop, endgame, np, rp: [bool, bool, bool] }.

// `solo` lists elements the game manual scores per robot (station 1 / 2 fields)
// `moved: true` marks the auto movement element: a robot that scored 0 there
// almost certainly didn't move, so it gets little credit for the alliance's auto.
// `parked: true` marks the endgame park/base element: a robot that skipped it
// usually broke down, so its partner gets most of the alliance's teleop credit.
// (Not used for POWERPLAY, whose endgame terminal park strong robots skipped.)
// and the alliance field they add up to. Their point values are learned from
// the data by scripts/solo-values.mjs and checked against the manuals.
const std = (extra = "") => `autoPoints dcPoints egPoints totalPointsNp totalPoints ${extra}`;
const readStd = (a) => ({
  auto: a.autoPoints, teleop: a.dcPoints, endgame: a.egPoints,
  np: a.totalPointsNp, total: a.totalPoints, rp: [false, false, false], raw: a,
});

export const SEASONS = {
  2019: {
    game: "SKYSTONE",
    scoreType: "MatchScores2019",
    statsType: "TeamEventStats2019",
    fields: std("autoNav2019_1 autoNav2019_2 autoNavPoints egParked1 egParked2 egParkPoints"),
    rpNames: [],
    winRp: 2,
    tieRp: 1,
    solo: [
      { comp: "auto", moved: true, label: "auto navigation", robots: ["autoNav2019_1", "autoNav2019_2"], total: "autoNavPoints" },
      { comp: "endgame", parked: true, label: "endgame parking", robots: ["egParked1", "egParked2"], total: "egParkPoints" },
    ],
    read: readStd,
  },
  2020: {
    game: "ULTIMATE GOAL",
    scoreType: "MatchScores2020Trad",
    statsType: "TeamEventStats2020Trad",
    fields: std("autoNav2020_1 autoNav2020_2 autoNavPoints"),
    rpNames: [],
    // ranked by the sum of the team's alliance scores (matches FIRST's numbers 100%)
    rankBy: "score",
    winRp: 2,
    tieRp: 1,
    solo: [{ comp: "auto", moved: true, label: "auto navigation", robots: ["autoNav2020_1", "autoNav2020_2"], total: "autoNavPoints" }],
    read: readStd,
  },
  2021: {
    game: "FREIGHT FRENZY",
    scoreType: "MatchScores2021Trad",
    statsType: "TeamEventStats2021Trad",
    fields: std("autoNav2021_1 autoNav2021_2 autoNavPoints autoBonus1 autoBonus2 autoBonusPoints egPark1 egPark2 egParkPoints"),
    rpNames: [],
    // ranked by the sum of the team's alliance scores (matches FIRST's numbers 100%)
    rankBy: "score",
    winRp: 2,
    tieRp: 1,
    solo: [
      { comp: "auto", moved: true, label: "auto parking", robots: ["autoNav2021_1", "autoNav2021_2"], total: "autoNavPoints" },
      // the auto bonus is 10 or 20 depending on duck vs team element, which the
      // per-robot flag doesn't record, so it stays shared
      { comp: "endgame", parked: true, label: "endgame parking", robots: ["egPark1", "egPark2"], total: "egParkPoints" },
    ],
    read: readStd,
  },
  2022: {
    game: "POWERPLAY",
    scoreType: "MatchScores2022",
    statsType: "TeamEventStats2022",
    fields: std("autoNav2022_1 autoNav2022_2 autoNavPoints egNav1 egNav2 egNavPoints"),
    rpNames: [],
    winRp: 2,
    tieRp: 1,
    solo: [
      { comp: "auto", moved: true, label: "auto signal parking", robots: ["autoNav2022_1", "autoNav2022_2"], total: "autoNavPoints" },
      { comp: "endgame", label: "endgame terminal parking", robots: ["egNav1", "egNav2"], total: "egNavPoints" },
    ],
    read: readStd,
  },
  2023: {
    game: "CENTERSTAGE",
    scoreType: "MatchScores2023",
    statsType: "TeamEventStats2023",
    fields: std("autoNav1 autoNav2 autoNavPoints purple1 purple2 purplePoints yellow1 yellow2 yellowPoints egNav2023_1 egNav2023_2 egNavPoints drone1 drone2 dronePoints"),
    rpNames: [],
    winRp: 2,
    tieRp: 1,
    solo: [
      { comp: "auto", moved: true, label: "auto navigation", robots: ["autoNav1", "autoNav2"], total: "autoNavPoints" },
      { comp: "auto", label: "purple pixel", robots: ["purple1", "purple2"], total: "purplePoints" },
      { comp: "auto", label: "yellow pixel", robots: ["yellow1", "yellow2"], total: "yellowPoints" },
      { comp: "endgame", parked: true, label: "backstage / rigging", robots: ["egNav2023_1", "egNav2023_2"], total: "egNavPoints" },
      { comp: "endgame", label: "drone landing", robots: ["drone1", "drone2"], total: "dronePoints" },
    ],
    read: readStd,
  },
  2024: {
    game: "INTO THE DEEP",
    scoreType: "MatchScores2024",
    statsType: "TeamEventStats2024",
    fields: "autoPoints dcPoints dcParkPoints totalPointsNp totalPoints autoPark1 autoPark2 autoParkPoints dcPark1 dcPark2",
    rpNames: [], // no bonus ranking points this season
    winRp: 2, // verified against official ranking scores in scripts/check-rs.mjs
    tieRp: 1,
    solo: [
      { comp: "auto", moved: true, label: "auto parking", robots: ["autoPark1", "autoPark2"], total: "autoParkPoints" },
      { comp: "endgame", parked: true, label: "ascent / parking", robots: ["dcPark1", "dcPark2"], total: "dcParkPoints" },
    ],
    read: (a) => ({
      auto: a.autoPoints, teleop: a.dcPoints - a.dcParkPoints, endgame: a.dcParkPoints,
      np: a.totalPointsNp, total: a.totalPoints, rp: [false, false, false], raw: a,
    }),
  },
  2025: {
    game: "DECODE",
    scoreType: "MatchScores2025",
    statsType: "TeamEventStats2025",
    fields: "autoPoints dcPoints dcBasePoints totalPointsNp totalPoints movementRp goalRp patternRp autoLeave1 autoLeave2 autoLeavePoints dcBase1 dcBase2 dcBaseBonus",
    rpNames: ["Movement", "Goal", "Pattern"],
    winRp: 3,
    tieRp: 1,
    solo: [
      { comp: "auto", moved: true, label: "leaving the start zone", robots: ["autoLeave1", "autoLeave2"], total: "autoLeavePoints" },
      // the both-robots-fully-in-base bonus stays shared
      { comp: "endgame", parked: true, label: "returning to base", robots: ["dcBase1", "dcBase2"], total: (a) => a.dcBasePoints - a.dcBaseBonus },
    ],
    read: (a) => ({
      auto: a.autoPoints, teleop: a.dcPoints - a.dcBasePoints, endgame: a.dcBasePoints,
      np: a.totalPointsNp, total: a.totalPoints, // total decides the winner
      rp: [a.movementRp, a.goalRp, a.patternRp], raw: a,
    }),
  },
  2026: {
    game: "BIOBUZZ",
    scoreType: "MatchScores2026",
    statsType: "TeamEventStats2026",
    fields: "autoPoints dcPoints dcParkPoints totalPointsNp totalPoints swarmRp pollinator1Rp pollinator2Rp autoLeave1 autoLeave2 autoLeavePoints autoParkPoints1 autoParkPoints2 autoParkPoints dcParkPoints1 dcParkPoints2",
    rpNames: ["Swarm", "Pollinator 1", "Pollinator 2"],
    winRp: 3, // verified against official ranking scores from early 2026 events
    tieRp: 1,
    solo: [
      { comp: "auto", moved: true, label: "leaving the start zone", robots: ["autoLeave1", "autoLeave2"], total: "autoLeavePoints" },
      { comp: "auto", label: "auto parking", robots: ["autoParkPoints1", "autoParkPoints2"], total: "autoParkPoints" },
      { comp: "endgame", parked: true, label: "endgame parking", robots: ["dcParkPoints1", "dcParkPoints2"], total: "dcParkPoints" },
    ],
    read: (a) => ({
      auto: a.autoPoints, teleop: a.dcPoints - a.dcParkPoints, endgame: a.dcParkPoints,
      np: a.totalPointsNp, total: a.totalPoints,
      rp: [a.swarmRp, a.pollinator1Rp, a.pollinator2Rp], raw: a,
    }),
  },
};

// Points each robot earned from per-robot elements, using learned values:
// one [robot 1, robot 2] pair per solo spec.
export function soloPoints(season, raw, fits) {
  const specs = SEASONS[season].solo ?? [];
  return specs.map((spec, j) => spec.robots.map((f) => fits[j]?.values[String(raw[f] ?? "None")] ?? 0));
}

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
