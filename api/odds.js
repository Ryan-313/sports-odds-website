export default async function handler(req, res) {
  const apiKey = process.env.ODDSPAPI_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "ODDSPAPI_KEY is not configured"
    });
  }

  const sportId = Number(req.query.sportId || 10);
  const bookmaker = String(req.query.bookmaker || "stake");

  const API_BASE = "https://api.oddspapi.io/v4";

  function errorMessage(data) {
    if (!data) return "Unknown OddsPAPI error";

    if (typeof data === "string") {
      return data;
    }

    if (data.message) {
      return data.message;
    }

    if (data.error) {
      if (typeof data.error === "string") {
        return data.error;
      }

      if (data.error.message) {
        return data.error.message;
      }
    }

    return JSON.stringify(data);
  }

  async function request(url) {
    const response = await fetch(url);

    let data;

    try {
      data = await response.json();
    } catch {
      throw new Error(
        `OddsPAPI returned invalid JSON. HTTP ${response.status}`
      );
    }

    if (!response.ok) {
      throw new Error(
        `OddsPAPI HTTP ${response.status}: ${errorMessage(data)}`
      );
    }

    return data;
  }

  try {

    // --------------------------------------------------
    // STEP 1: Get soccer tournaments
    // --------------------------------------------------

    const tournamentsUrl =
      `${API_BASE}/tournaments` +
      `?sportId=${sportId}` +
      `&language=en` +
      `&apiKey=${encodeURIComponent(apiKey)}`;

    const tournaments = await request(tournamentsUrl);

    if (!Array.isArray(tournaments)) {
      throw new Error(
        "Unexpected tournaments response: " +
        JSON.stringify(tournaments)
      );
    }

    // Only tournaments that actually have fixtures.
    const usableTournaments = tournaments.filter(t =>
      Number(t.futureFixtures || 0) > 0 ||
      Number(t.upcomingFixtures || 0) > 0 ||
      Number(t.liveFixtures || 0) > 0
    );

    // Keep the request reasonably small.
    const selected = usableTournaments.slice(0, 20);

    if (selected.length === 0) {
      return res.status(200).json({
        sportId,
        bookmaker,
        fixtures: [],
        message: "No tournaments currently have fixtures."
      });
    }

    const tournamentIds = selected
      .map(t => t.tournamentId)
      .filter(Boolean)
      .join(",");

    // --------------------------------------------------
    // STEP 2: Get odds
    // --------------------------------------------------
    //
    // IMPORTANT:
    // OddsPAPI uses "bookmakers" PLURAL.
    // --------------------------------------------------

    const oddsUrl =
      `${API_BASE}/odds-by-tournaments` +
      `?tournamentIds=${encodeURIComponent(tournamentIds)}` +
      `&bookmakers=${encodeURIComponent(bookmaker)}` +
      `&language=en` +
      `&oddsFormat=decimal` +
      `&verbosity=3` +
      `&apiKey=${encodeURIComponent(apiKey)}`;

    const oddsData = await request(oddsUrl);

    let fixtures = [];

    if (Array.isArray(oddsData)) {
      fixtures = oddsData;
    } else if (Array.isArray(oddsData?.data)) {
      fixtures = oddsData.data;
    } else if (Array.isArray(oddsData?.fixtures)) {
      fixtures = oddsData.fixtures;
    } else if (oddsData?.fixtureId) {
      fixtures = [oddsData];
    }

    // --------------------------------------------------
    // STEP 3: Get participant names
    // --------------------------------------------------

    const participantsUrl =
      `${API_BASE}/participants` +
      `?sportId=${sportId}` +
      `&language=en` +
      `&apiKey=${encodeURIComponent(apiKey)}`;

    const participants =
      await request(participantsUrl);

    // Participants is an object:
    // {
    //   "123": "Team A",
    //   "456": "Team B"
    // }

    if (
      !participants ||
      typeof participants !== "object" ||
      Array.isArray(participants)
    ) {
      throw new Error(
        "Unexpected participants response: " +
        JSON.stringify(participants)
      );
    }

    // --------------------------------------------------
    // STEP 4: Tournament name lookup
    // --------------------------------------------------

    const tournamentMap = {};

    for (const tournament of tournaments) {
      tournamentMap[String(tournament.tournamentId)] =
        tournament.tournamentName ||
        `Tournament ${tournament.tournamentId}`;
    }

    // --------------------------------------------------
    // STEP 5: Normalize fixtures
    // --------------------------------------------------

    const normalized = fixtures.map(fixture => {

      const id1 = fixture.participant1Id;
      const id2 = fixture.participant2Id;

      const team1 =
        fixture.participant1Name ||
        participants[String(id1)] ||
        `Team ${id1}`;

      const team2 =
        fixture.participant2Name ||
        participants[String(id2)] ||
        `Team ${id2}`;

      const tournamentName =
        fixture.tournamentName ||
        tournamentMap[String(fixture.tournamentId)] ||
        `Tournament ${fixture.tournamentId}`;

      const bookmakerData =
        fixture.bookmakerOdds?.[bookmaker] ||
        fixture.bookmakerOdds?.stake ||
        null;

      const markets =
        bookmakerData?.markets || {};

      // Soccer:
      // 101 = Full Time Result
      // 101 = Home
      // 102 = Draw
      // 103 = Away

      const resultMarket =
        markets["101"];

      function getOutcome(outcomeId) {

        const outcome =
          resultMarket
            ?.outcomes?.[String(outcomeId)]
            ?.players?.["0"];

        if (!outcome) {
          return null;
        }

        return {
          price: outcome.price ?? null,
          priceAmerican:
            outcome.priceAmerican ?? null,
          priceFractional:
            outcome.priceFractional ?? null,
          active:
            outcome.active !== false
        };
      }

      return {

        fixtureId:
          fixture.fixtureId,

        participant1Id:
          id1,

        participant2Id:
          id2,

        participant1Name:
          team1,

        participant2Name:
          team2,

        sportId:
          fixture.sportId ?? sportId,

        tournamentId:
          fixture.tournamentId,

        tournamentName:
          tournamentName,

        seasonId:
          fixture.seasonId ?? null,

        statusId:
          fixture.statusId ?? null,

        startTime:
          fixture.startTime ?? null,

        hasOdds:
          fixture.hasOdds === true,

        bookmaker:
          bookmaker,

        bookmakerActive:
          bookmakerData?.bookmakerIsActive === true,

        suspended:
          bookmakerData?.suspended === true,

        fixturePath:
          bookmakerData?.fixturePath || null,

        odds: {
          home: getOutcome(101),
          draw: getOutcome(102),
          away: getOutcome(103)
        },

        marketCount:
          Object.keys(markets).length

      };
    });

    return res.status(200).json({
      success: true,
      sportId,
      bookmaker,
      fixtureCount: normalized.length,
      fixtures: normalized
    });

  } catch (error) {

    console.error("ODDSPAPI ERROR:", error);

    return res.status(500).json({
      success: false,
      error: error.message || "Failed to fetch OddsPAPI data"
    });
  }
}
